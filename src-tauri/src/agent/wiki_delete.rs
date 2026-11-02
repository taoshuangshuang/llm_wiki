//! Wiki 页面删除生命周期：桌面、Agent、HTTP/MCP 共用路径校验、引用清理和索引回收。
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::commands::{file_approval, file_history, file_sync, vectorstore};
use super::tools::{ensure_project_bound_path, normalize_wiki_write_path, safe_project_join};

const MAX_PAGES: usize = 10_000;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDeleteOutput {
    pub deleted_paths: Vec<String>,
    pub rewritten_paths: Vec<String>,
    pub rewritten_files: usize,
    /// 文件已删除后，索引或媒体回收的失败不能伪装成整体未执行。
    pub warnings: Vec<String>,
    pub verified: bool,
}

/// 一次提交中的原始正文与清理结果，用于并发版本核对及失败回滚。
pub(super) struct Page {
    pub(super) rel: String,
    pub(super) path: PathBuf,
    pub(super) before: String,
    pub(super) after: String,
}

/// 界面批量删除入口。只接受项目内 Markdown；调用者负责根据真实用户要求选择目标。
#[tauri::command]
pub async fn delete_wiki_pages(project_path: String, paths: Vec<String>) -> Result<WikiDeleteOutput, String> {
    delete_lifecycle(project_path, paths, None).await
}

/// 仅由人工审核入口调用，授权只绑定待删除页的原始正文，不放宽其他文件保护。
pub(crate) async fn delete_approved_wiki_page(project_path: String, path: String, original: String) -> Result<WikiDeleteOutput, String> {
    delete_lifecycle(project_path, vec![path.clone()], Some((path, original))).await
}

/// 文件提交完成后回收受影响索引，后续清理失败单独记录为警告。
async fn delete_lifecycle(project_path: String, paths: Vec<String>, approved: Option<(String, String)>) -> Result<WikiDeleteOutput, String> {
    let root = project_path.clone();
    let mut output = tauri::async_runtime::spawn_blocking(move || delete_files_inner(&root, &paths, approved.as_ref()))
        .await.map_err(|error| format!("Wiki 删除任务失败：{error}"))??;
    // 磁盘是事实源。删除和重写都清掉旧向量，正文监听负责重新嵌入存活页。
    for rel in output.deleted_paths.iter().chain(&output.rewritten_paths) {
        let page_id = rel[5..rel.len() - 3].to_string();
        if let Err(error) = vectorstore::vector_delete_page(project_path.clone(), page_id).await {
            output.warnings.push(format!("{rel} 已变更，但旧索引清理失败，需重新核对索引：{error}"));
        }
    }
    Ok(output)
}

/// 在同一短提交锁内预检并提交；保护规则或扫描失败时不先删页再留下断链。
#[cfg(test)]
fn delete_files(project_path: &str, paths: &[String]) -> Result<WikiDeleteOutput, String> {
    delete_files_inner(project_path, paths, None)
}

fn delete_files_inner(project_path: &str, paths: &[String], approved: Option<&(String, String)>) -> Result<WikiDeleteOutput, String> {
    let _mutation = crate::mutation::lock()?;
    if paths.is_empty() || paths.len() > MAX_PAGES { return Err("一次删除须指定 1–10000 个 Wiki 页面".into()); }
    let root = Path::new(project_path).canonicalize().map_err(|e| e.to_string())?;
    let root_str = root.to_str().ok_or("项目路径不是 UTF-8")?;
    let mut deleted = BTreeSet::new();
    for path in paths {
        let rel = normalize_wiki_write_path(path).map_err(|e| e.replace("wiki.write_page", "wiki.delete_page"))?;
        let target = safe_project_join(root_str, &rel)?;
        if !target.exists() { return Err(format!("Wiki 页面不存在：{rel}")); }
        reject_symlink_components(&root, &target)?;
        if !target.is_file() { return Err(format!("Wiki 页面不存在：{rel}")); }
        deleted.insert(rel);
    }
    let mut pages = load_pages(&root)?;
    if deleted.iter().any(|rel| !pages.iter().any(|page| &page.rel == rel)) {
        return Err("删除目标不在可安全读取的 Wiki 页面中".into());
    }
    let targets = DeletionTargets::new(&pages, &deleted);
    for i in 0..pages.len() {
        if !deleted.contains(&pages[i].rel) {
            pages[i].after = clean_references(&pages[i].before, &pages[i].rel, &targets);
        }
    }
    if let Some((rel, original)) = approved {
        if !pages.iter().any(|page| &page.rel == rel && &page.before == original && deleted.contains(rel)) {
            return Err("FILE_APPROVAL_CONFLICT: 删除目标已变化，请重新核对并审核".into());
        }
    }
    apply_pages(&root, &pages, &deleted, approved)?;
    let rewritten_paths: Vec<_> = pages.iter().filter(|p| !deleted.contains(&p.rel) && p.before != p.after)
        .map(|p| p.rel.clone()).collect();
    let mut output = WikiDeleteOutput {
        deleted_paths: deleted.iter().cloned().collect(), rewritten_files: rewritten_paths.len(),
        rewritten_paths, warnings: Vec::new(), verified: true,
    };
    output.warnings = collect_media_warnings(&root, &pages, &deleted);
    Ok(output)
}

/// 预检保护规则并提交整批文件；失败时恢复本批已触及的页面。
fn apply_pages(root: &Path, pages: &[Page], deleted: &BTreeSet<String>, approved: Option<&(String, String)>) -> Result<(), String> {
    let is_approved = |page: &Page| approved.is_some_and(|(rel, original)| &page.rel == rel && &page.before == original);
    // 先检查所有目标及被引用页；受保护的文件只产生审批草稿。
    for page in pages {
        let proposed = if deleted.contains(&page.rel) { None } else if page.before != page.after {
            Some(page.after.as_bytes())
        } else { continue };
        if !is_approved(page) { drop(file_approval::guard_mutation(&page.path, proposed, "wiki.delete_page")?); }
    }
    let mut applied: Vec<&Page> = Vec::new();
    for page in pages {
        if !deleted.contains(&page.rel) && page.before == page.after { continue; }
        let proposed = (!deleted.contains(&page.rel)).then_some(page.after.as_bytes());
        let result = (|| {
            let _approval = if is_approved(page) { None } else { Some(file_approval::guard_mutation(&page.path, proposed, "wiki.delete_page")?) };
            // 防止扫描后发生的外部编辑被旧快照覆盖。
            reject_symlink_components(&root, &page.path)?;
            if fs::read_to_string(&page.path).map_err(|e| e.to_string())? != page.before {
                return Err(format!("页面已变化，请重新读取后再删除：{}", page.rel));
            }
            applied.push(page);
            file_history::record_file_version(&page.path, "baseline", "before.wiki.delete_page");
            file_sync::mark_app_write_path(&page.path);
            if proposed.is_none() { fs::remove_file(&page.path).map_err(|e| e.to_string())?; }
            else { crate::mutation::atomic_write(&page.path, page.after.as_bytes())?; }
            file_sync::mark_app_write_path(&page.path);
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            let mut failures = Vec::new();
            for previous in applied.into_iter().rev() {
                if let Err(e) = crate::mutation::atomic_write(&previous.path, previous.before.as_bytes()) {
                    failures.push(format!("{}: {e}", previous.rel));
                }
            }
            return Err(format!("Wiki 删除未完成：{error}；已提交变更回滚{}", if failures.is_empty() {
                "成功".to_string()
            } else { format!("失败：{}", failures.join("；")) }));
        }
    }
    Ok(())
}

/// 仅回收已无存活页面引用的来源配图，失败以警告返回，不扩大删除范围。
fn collect_media_warnings(root: &Path, pages: &[Page], deleted: &BTreeSet<String>) -> Vec<String> {
    let mut warnings = Vec::new();
    // 来源摘要才拥有媒体目录；仍被其他页面使用或无法确认安全时保留。
    for page in pages.iter().filter(|p| deleted.contains(&p.rel) && p.rel.starts_with("wiki/sources/")) {
        let slug = page.path.file_stem().unwrap().to_string_lossy();
        let reference = format!("media/{slug}/");
        let encoded = encode_reference(&reference);
        if pages.iter().any(|p| !deleted.contains(&p.rel) && (p.after.contains(&reference) || p.after.contains(&encoded))) { continue; }
        let media = root.join("wiki/media").join(slug.as_ref());
        if !media.exists() { continue; }
        let result = (|| {
            reject_symlink_components(&root, &media)?;
            let _approval = file_approval::guard_mutation(&media, None, "wiki.delete_page.media")?;
            fs::remove_dir_all(&media).map_err(|e| e.to_string())
        })();
        if let Err(error) = result { warnings.push(format!("媒体目录已保留：{error}")); }
    }
    warnings
}

/// 不跟随符号链接，确保批量扫描和提交不穿透项目边界。
pub(super) fn reject_symlink_components(root: &Path, target: &Path) -> Result<(), String> {
    let rel = target.strip_prefix(root).map_err(|e| e.to_string())?;
    let mut current = root.to_path_buf();
    for part in rel.components() {
        current.push(part);
        if fs::symlink_metadata(&current).map_err(|e| e.to_string())?.file_type().is_symlink() {
            return Err("wiki.delete_page 不允许符号链接路径".into());
        }
    }
    ensure_project_bound_path(root.to_str().unwrap(), target)
}

/// 有界扫描所有正文，读取失败即停止，避免基于不完整证据清理引用。
pub(super) fn load_pages(root: &Path) -> Result<Vec<Page>, String> {
    reject_symlink_components(root, &root.join("wiki"))?;
    let mut pages = Vec::new();
    let mut bytes = 0;
    for entry in WalkDir::new(root.join("wiki")).follow_links(false).into_iter().filter_entry(|e| {
        e.depth() == 0 || (!e.file_name().to_string_lossy().starts_with('.') && e.file_name() != "media")
    }) {
        let entry = entry.map_err(|e| format!("无法完整扫描 Wiki：{e}"))?;
        // 链接文件或目录都不能被纳入清理，媒体回收不能依赖不完整扫描。
        if entry.file_type().is_symlink() { return Err("Wiki 中存在符号链接，未执行删除".into()); }
        if entry.path().extension().is_none_or(|ext| ext != "md") { continue; }
        if !entry.file_type().is_file() { continue; }
        let size = entry.metadata().map_err(|e| e.to_string())?.len();
        if size > super::tools::MAX_WRITE_PAGE_BYTES as u64 { return Err("Wiki 页面过大，未执行删除".into()); }
        bytes += size as usize;
        if pages.len() >= MAX_PAGES || bytes > MAX_TOTAL_BYTES { return Err("Wiki 扫描超出安全预算，未执行删除".into()); }
        let before = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        pages.push(Page { rel: entry.path().strip_prefix(root).unwrap().to_str().ok_or("Wiki 页面路径不是 UTF-8，未执行删除")?.replace('\\', "/"),
            path: entry.path().to_path_buf(), after: before.clone(), before });
    }
    pages.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(pages)
}

/// 同时识别 Markdown 中原始与 URI 编码的媒体引用。
fn encode_reference(value: &str) -> String {
    value.as_bytes().iter().map(|b| if b.is_ascii_alphanumeric() || b"/-_.~".contains(b) {
        (*b as char).to_string()
    } else { format!("%{b:02X}") }).collect()
}

/// 标题别名沿用 Wiki 的空格、连字符和下划线兼容约定。
fn ref_key(value: &str) -> String {
    value.trim().trim_matches(['\'', '"']).trim_start_matches("[[").trim_end_matches("]]")
        .to_lowercase().chars().filter(|c| !c.is_whitespace() && !matches!(c, '-' | '_')).collect()
}

/// 只读取 frontmatter 中的标题，正文里的 title: 不作为页面别名。
pub(super) fn page_title(page: &Page) -> &str {
    let Some(front) = page.before.strip_prefix("---\n").or_else(|| page.before.strip_prefix("---\r\n")) else { return ""; };
    front.lines().take_while(|line| line.trim() != "---")
        .find_map(|line| line.strip_prefix("title:").map(|v| v.trim().trim_matches(['\'', '"']))) .unwrap_or("")
}

/// 预先建立名称归属，清理时不再为每个链接重新扫描全部页面。
pub(super) struct DeletionTargets { paths: BTreeSet<String>, aliases: BTreeSet<String> }

impl DeletionTargets {
    pub(super) fn new(pages: &[Page], deleted: &BTreeSet<String>) -> Self {
        let mut names: BTreeMap<String, (bool, bool)> = BTreeMap::new();
        for page in pages {
            for name in [page.path.file_stem().unwrap().to_str().unwrap(), page_title(page)] {
                let key = ref_key(name);
                if key.is_empty() { continue; }
                let state = names.entry(key).or_default();
                if deleted.contains(&page.rel) { state.0 = true; } else { state.1 = true; }
            }
        }
        Self { paths: deleted.clone(), aliases: names.into_iter()
            .filter(|(_, (removed, alive))| *removed && !alive).map(|(key, _)| key).collect() }
    }

    /// 路径精确匹配；裸名称/标题只有没有存活同名页时才清理，避免跨 Schema 误伤。
    pub(super) fn contains(&self, value: &str) -> bool {
        let normalized = value.trim().trim_matches(['\'', '"']).trim_start_matches("[[").trim_end_matches("]]")
            .split('|').next().unwrap_or_default().split('#').next().unwrap_or_default().trim().replace('\\', "/");
        let normalized = normalized.strip_suffix(".md").unwrap_or(&normalized);
        if normalized.contains('/') {
            let rel = if normalized.starts_with("wiki/") { format!("{normalized}.md") } else { format!("wiki/{normalized}.md") };
            return self.paths.contains(&rel);
        }
        self.aliases.contains(&ref_key(normalized))
    }
}

/// 保留别名文本，索引只移除以目标链接开头的条目，不做子串匹配。
fn clean_references(content: &str, rel: &str, targets: &DeletionTargets) -> String {
    let mut lines = Vec::new();
    let mut frontmatter = false;
    let mut related_block = false;
    for (index, raw) in content.split_inclusive('\n').enumerate() {
        let line = raw.trim_end_matches(['\r', '\n']);
        let newline = &raw[line.len()..];
        if line.trim() == "---" && (index == 0 || frontmatter) { frontmatter = !frontmatter; related_block = false; }
        if frontmatter {
            if let Some(value) = line.strip_prefix("related:") {
                let value = value.trim();
                related_block = value.is_empty();
                if value.starts_with('[') && value.ends_with(']') {
                    let items = split_yaml_list(&value[1..value.len() - 1]);
                    let filtered: Vec<_> = items.iter().filter(|v| !targets.contains(v)).copied().collect();
                    if filtered.len() != items.len() { lines.push(format!("related: [{}]{newline}", filtered.join(", "))); continue; }
                }
            } else if related_block {
                if let Some(value) = line.trim_start().strip_prefix("- ") {
                    if targets.contains(value) { continue; }
                } else { related_block = false; }
            }
            lines.push(raw.to_string());
            continue;
        }
        if Path::new(rel).file_name().is_some_and(|n| n == "index.md") {
            let item = line.trim_start().strip_prefix("- ").or_else(|| line.trim_start().strip_prefix("* "));
            if let Some(link) = item.and_then(|v| v.trim_start().strip_prefix("[[")) {
                if let Some(end) = link.find("]]") {
                    if targets.contains(&link[..end]) { continue; }
                }
            }
        }
        let mut rest = raw;
        let mut out = String::new();
        while let Some(start) = rest.find("[[") {
            out.push_str(&rest[..start]);
            let link = &rest[start + 2..];
            let Some(end) = link.find("]]") else { out.push_str(&rest[start..]); rest = ""; break; };
            if targets.contains(&link[..end]) {
                let (target, alias) = link[..end].split_once('|').map_or((&link[..end], None), |(a, b)| (a, Some(b)));
                out.push_str(alias.unwrap_or(target));
            } else { out.push_str(&rest[start..start + 2 + end + 2]); }
            rest = &link[end + 2..];
        }
        out.push_str(rest);
        lines.push(out);
    }
    lines.concat()
}

/// YAML 行内数组按引号与 [[链接]] 边界分割，标题含逗号时保持原值。
pub(super) fn split_yaml_list(value: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let (mut quote, mut depth, mut start, mut escaped) = (None, 0usize, 0, false);
    for (i, c) in value.char_indices() {
        if escaped { escaped = false; continue; }
        if c == '\\' && quote == Some('"') { escaped = true; continue; }
        if let Some(q) = quote { if c == q { quote = None; } continue; }
        match c {
            '\'' | '"' => quote = Some(c), '[' => depth += 1, ']' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => { result.push(value[start..i].trim()); start = i + 1; }
            _ => {}
        }
    }
    if !value[start..].trim().is_empty() { result.push(value[start..].trim()); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// 独立临时项目，不读取或修改用户的知识库。
    struct Project(PathBuf);
    impl Project {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("wiki-delete-{}", Uuid::new_v4()));
            fs::create_dir_all(root.join(".llm-wiki")).unwrap();
            fs::create_dir_all(root.join("wiki")).unwrap();
            Self(root)
        }
        fn root(&self) -> &str { self.0.to_str().unwrap() }
        fn write(&self, rel: &str, content: &str) {
            fs::create_dir_all(self.0.join(rel).parent().unwrap()).unwrap();
            fs::write(self.0.join(rel), content).unwrap();
        }
        fn read(&self, rel: &str) -> String { fs::read_to_string(self.0.join(rel)).unwrap() }
        fn delete(&self, paths: &[&str]) -> Result<WikiDeleteOutput, String> {
            delete_files(self.root(), &paths.iter().map(|p| p.to_string()).collect::<Vec<_>>())
        }
        fn protect(&self, rel: &str) {
            file_approval::set_important_file(self.root().into(), self.0.join(rel).to_string_lossy().into_owned(), true).unwrap();
        }
    }
    impl Drop for Project { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    /// 批量删除同时覆盖标题、路径、别名和两种 related 格式，保留无关元数据及换行。
    #[test]
    fn batch_delete_cleans_titles_paths_aliases_and_both_related_formats() {
        let p = Project::new();
        p.write("wiki/entities/alice-chen.md", "---\ntitle: Alice Chen\n---\n# Alice");
        p.write("wiki/concepts/ai.md", "# AI");
        p.write("wiki/index.md", "# 目录\n- [[Alice Chen]]\n* [[wiki/concepts/ai.md|AI]]\n- [[OpenAI]]\n");
        p.write("wiki/kept.md", "---\nrelated: ['wiki/entities/alice-chen.md', ai, OpenAI]\ntags: [ai]\n---\n[[Alice Chen|作者]] [[concepts/ai#定义]] [[OpenAI]]\n");
        p.write("wiki/block.md", "---\r\nrelated:\r\n  - alice-chen\r\n  - 'wiki/concepts/ai.md'\r\n  - OpenAI\r\ntags: [keep]\r\n---\r\n保留\r\n");
        let result = p.delete(&["wiki/entities/alice-chen.md", "wiki/concepts/ai.md"]).unwrap();
        assert_eq!(result.deleted_paths.len(), 2);
        assert_eq!(result.rewritten_files, 3);
        assert_eq!(p.read("wiki/index.md"), "# 目录\n- [[OpenAI]]\n");
        assert_eq!(p.read("wiki/kept.md"), "---\nrelated: [OpenAI]\ntags: [ai]\n---\n作者 concepts/ai#定义 [[OpenAI]]\n");
        assert_eq!(p.read("wiki/block.md"), "---\r\nrelated:\r\n  - OpenAI\r\ntags: [keep]\r\n---\r\n保留\r\n");
    }

    /// 两个 Schema 有同名页面时，只清理明确指向删除路径的引用。
    #[test]
    fn same_named_surviving_schema_page_keeps_its_links_and_related() {
        let p = Project::new();
        p.write("wiki/a/item.md", "---\ntitle: 共同标题\n---\na");
        p.write("wiki/b/item.md", "---\ntitle: 共同标题\n---\nb");
        p.write("wiki/kept.md", "---\nrelated: [wiki/a/item.md, wiki/b/item.md, item, 共同标题]\n---\n[[wiki/a/item.md|旧]] [[wiki/b/item.md]] [[item]] [[共同标题]]");
        p.delete(&["wiki/a/item.md"]).unwrap();
        assert_eq!(p.read("wiki/kept.md"), "---\nrelated: [wiki/b/item.md, item, 共同标题]\n---\n旧 [[wiki/b/item.md]] [[item]] [[共同标题]]");
        assert_eq!(p.read("wiki/b/item.md"), "---\ntitle: 共同标题\n---\nb");
    }

    /// 删除目标或引用页受保护时，整批原文保持不变，只产生待审批草稿。
    #[test]
    fn important_target_or_backlink_prevents_the_whole_batch_before_changes() {
        for protect_target in [true, false] {
            let p = Project::new();
            p.write("wiki/old.md", "# Old");
            p.write("wiki/kept.md", "[[old]]");
            p.protect(if protect_target { "wiki/old.md" } else { "wiki/kept.md" });
            let error = p.delete(&["wiki/old.md"]).unwrap_err();
            assert!(error.starts_with("FILE_APPROVAL_REQUIRED:"));
            assert_eq!(p.read("wiki/old.md"), "# Old");
            assert_eq!(p.read("wiki/kept.md"), "[[old]]");
            let state = file_approval::get_file_approvals(p.root().into()).unwrap();
            assert_eq!(state.proposals.len(), 1);
        }
    }

    /// 批量中混入非法路径、目录或缺失页时，先前合法目标也不能被提前删除。
    #[test]
    fn invalid_missing_or_directory_target_never_partially_deletes_a_batch() {
        let p = Project::new();
        p.write("wiki/old.md", "# Old");
        for invalid in ["../old.md", "/tmp/outside.md", "wiki", "wiki/missing.md", "raw/sources/a.md", "wiki/../wiki/old.md"] {
            assert!(p.delete(&["wiki/old.md", invalid]).is_err(), "{invalid}");
            assert_eq!(p.read("wiki/old.md"), "# Old");
        }
        assert!(p.delete(&[]).is_err());
    }

    /// 来源摘要删除后，分别验证独占配图回收和共享配图保留。
    #[test]
    fn source_media_is_removed_only_when_no_surviving_page_references_it() {
        for referenced in [true, false] {
            let p = Project::new();
            p.write("wiki/sources/source.md", "# 来源");
            p.write("wiki/media/source/image.png", "image");
            if referenced { p.write("wiki/kept.md", "![图](media/source/image.png)"); }
            p.delete(&["wiki/sources/source.md"]).unwrap();
            assert_eq!(p.0.join("wiki/media/source/image.png").exists(), referenced);
        }
    }

    #[cfg(unix)]
    /// 项目外链接目录和项目内链接文件均须拒绝，真实页面不能被别名穿透删除。
    #[test]
    fn symlinked_target_or_ancestor_cannot_delete_outside_or_inside_aliases() {
        use std::os::unix::fs::symlink;
        let p = Project::new();
        let outside = Project::new();
        outside.write("wiki/original.md", "外部页面");
        symlink(outside.0.join("wiki"), p.0.join("wiki/alias")).unwrap();
        assert!(p.delete(&["wiki/alias/original.md"]).is_err());
        assert_eq!(outside.read("wiki/original.md"), "外部页面");
        fs::remove_file(p.0.join("wiki/alias")).unwrap();
        p.write("wiki/original.md", "项目内页面");
        symlink(p.0.join("wiki/original.md"), p.0.join("wiki/alias.md")).unwrap();
        assert!(p.delete(&["wiki/alias.md"]).is_err());
        assert_eq!(p.read("wiki/original.md"), "项目内页面");
    }
}

#[cfg(test)]
mod index_tests {
    use super::*;

    /// 使用真实 LanceDB 验证删除页和引用重写页的旧向量被清理，未变页不受影响。
    #[tokio::test]
    async fn delete_lifecycle_removes_only_affected_page_indexes() {
        let root = std::env::temp_dir().join(format!("wiki-delete-index-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();
        for (page, content) in [("old", "# Old"), ("linked", "[[old]]"), ("kept", "# Kept")] {
            fs::write(root.join(format!("wiki/{page}.md")), content).unwrap();
            vectorstore::vector_upsert_chunks(root.to_string_lossy().into_owned(), page.into(), vec![vectorstore::ChunkUpsertInput {
                chunk_index: 0, chunk_text: content.into(), heading_path: String::new(), embedding: vec![0.1; 16],
            }]).await.unwrap();
        }
        let result = delete_wiki_pages(root.to_string_lossy().into_owned(), vec!["wiki/old.md".into()]).await.unwrap();
        assert!(result.verified);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let pages = vectorstore::vector_indexed_pages(root.to_string_lossy().into_owned(), None).await.unwrap();
        let value = serde_json::to_value(pages).unwrap();
        assert_eq!(value.as_array().unwrap().len(), 1);
        assert_eq!(value[0]["pageId"], "kept");
        assert_eq!(fs::read_to_string(root.join("wiki/linked.md")).unwrap(), "old");
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;

    /// 审核删除草稿后也要走完整生命周期，不能由通用审批入口只删一个文件。
    #[test]
    fn approving_a_protected_page_deletion_also_cleans_backlinks() {
        let root = std::env::temp_dir().join(format!("wiki-delete-approval-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("wiki/old.md"), "# Old").unwrap();
        fs::write(root.join("wiki/kept.md"), "[[old]]").unwrap();
        let project = root.to_string_lossy().into_owned();
        file_approval::set_important_file(project.clone(), root.join("wiki/old.md").to_string_lossy().into_owned(), true).unwrap();
        assert!(delete_files(&project, &["wiki/old.md".into()]).unwrap_err().starts_with("FILE_APPROVAL_REQUIRED:"));
        let state = file_approval::get_file_approvals(project.clone()).unwrap();
        file_approval::review_file_change(project.clone(), state.proposals[0].id.clone(), true).unwrap();
        assert!(!root.join("wiki/old.md").exists());
        assert_eq!(fs::read_to_string(root.join("wiki/kept.md")).unwrap(), "old");
        let state = file_approval::get_file_approvals(project).unwrap();
        assert_eq!(state.proposals[0].status, "approved");
        assert!(state.important_paths.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
