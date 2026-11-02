//! 页面移动与重命名：同一提交内迁移正文、引用和保护标记，随后核对向量身份。
use std::{collections::BTreeSet, fs, path::Path};
use serde::{Deserialize, Serialize};
use crate::commands::{file_approval, file_history, file_sync, page_embedding, search::SearchEmbeddingConfig, vectorstore};
use super::{tools::{ensure_existing_ancestor_bound, normalize_wiki_write_path, safe_project_join},
    wiki_delete::{load_pages, reject_symlink_components, split_yaml_list, DeletionTargets, Page}, wiki_files::revision};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MovePageRequest { pub path: String, pub to_path: String, pub expected_revision: Option<String> }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePageOutput {
    pub from_path: String, pub to_path: String, pub rewritten_paths: Vec<String>,
    pub indexing_pending_paths: Vec<String>, pub warnings: Vec<String>, pub verified: bool,
}

/// Agent 与 HTTP/MCP 共用入口；无嵌入配置时明确报告待索引页面，不伪报新向量已就绪。
pub async fn move_wiki_page(project_path: String, request: MovePageRequest, config: Option<SearchEmbeddingConfig>) -> Result<MovePageOutput, String> {
    move_lifecycle(project_path, request, config, None).await
}

/// 人工审批只授权对应的源页版本与目标路径，不能扩大为任意移动权限。
pub(crate) async fn move_approved_wiki_page(project_path: String, path: String, to_path: String, original: String) -> Result<MovePageOutput, String> {
    let request = MovePageRequest { path, to_path, expected_revision: Some(revision(&original)) };
    move_lifecycle(project_path, request, None, Some(original)).await
}

/// 磁盘提交与网络等待分开；索引失败不回滚已经完成的页面身份迁移。
async fn move_lifecycle(project_path: String, request: MovePageRequest, config: Option<SearchEmbeddingConfig>, approved: Option<String>) -> Result<MovePageOutput, String> {
    let root = project_path.clone();
    let mut output = tauri::async_runtime::spawn_blocking(move || move_files(&root, request, approved.as_deref()))
        .await.map_err(|e| format!("页面移动任务失败：{e}"))??;
    let affected: Vec<_> = std::iter::once(output.from_path.clone()).chain(output.rewritten_paths.iter().cloned()).collect();
    for path in affected {
        if let Err(error) = vectorstore::vector_delete_page(project_path.clone(), path[5..path.len() - 3].into()).await {
            output.warnings.push(format!("{path} 的旧索引清理失败：{error}"));
        }
    }
    if let Some(config) = config.filter(|cfg| cfg.enabled && !cfg.model.trim().is_empty()) {
        let mut pending = Vec::new();
        for path in &output.indexing_pending_paths {
            if let Err(error) = page_embedding::embed_wiki_page(&project_path, path, config.clone(), false).await {
                output.warnings.push(format!("{path} 尚未完成重新索引：{}", error.message));
                pending.push(path.clone());
            }
        }
        output.indexing_pending_paths = pending;
    }
    Ok(output)
}

/// 全量预检后提交移动；目标已存在、版本冲突或保护规则阻断时保持原状。
fn move_files(project_path: &str, request: MovePageRequest, approved: Option<&str>) -> Result<MovePageOutput, String> {
    let _mutation = crate::mutation::lock()?;
    let root = Path::new(project_path).canonicalize().map_err(|e| e.to_string())?;
    let project = root.to_str().ok_or("项目路径不是 UTF-8")?;
    let from = normalize_wiki_write_path(&request.path).map_err(|e| e.replace("wiki.write_page", "wiki.move_page"))?;
    let to = normalize_wiki_write_path(&request.to_path).map_err(|e| e.replace("wiki.write_page", "wiki.move_page"))?;
    if from == to { return Err("源路径和目标路径相同，未执行移动".into()); }
    let source = safe_project_join(project, &from)?;
    let target = safe_project_join(project, &to)?;
    reject_symlink_components(&root, &source)?;
    if fs::symlink_metadata(&target).is_ok() { return Err("目标页面已存在，移动不会覆盖已有文件".into()); }
    validate_destination_parent(&root, &target)?;
    let mut pages = load_pages(&root)?;
    let original = pages.iter().find(|p| p.rel == from).ok_or("源 Wiki 页面不存在")?.before.clone();
    if request.expected_revision.as_ref().is_some_and(|v| v != &revision(&original)) || approved.is_some_and(|v| v != original) {
        return Err("FILE_APPROVAL_CONFLICT: 源页面已变化，请重新读取后再移动".into());
    }
    let matcher = DeletionTargets::new(&pages, &BTreeSet::from([from.clone()]));
    for page in &mut pages {
        page.after = rewrite_page(&page.before, &page.rel, &from, &to, &matcher);
    }
    let moved = pages.iter().find(|p| p.rel == from).unwrap();
    let approval_source = format!("wiki.move_page:{to}");
    if approved.is_none() { drop(file_approval::guard_mutation(&source, None, &approval_source)?); }
    drop(file_approval::guard_mutation(&target, Some(moved.after.as_bytes()), "wiki.move_page")?);
    for page in pages.iter().filter(|p| p.rel != from && p.before != p.after) {
        drop(file_approval::guard_mutation(&page.path, Some(page.after.as_bytes()), "wiki.move_page.refs")?);
    }
    commit_move(&root, &pages, &from, &target, approved, &approval_source)?;
    let mut changed: Vec<_> = pages.iter().filter(|p| p.rel != from && p.before != p.after).map(|p| p.rel.clone()).collect();
    changed.push(to.clone());
    let pending = changed.iter().filter(|path| !matches!(Path::new(path).file_stem().and_then(|v| v.to_str()), Some("index" | "log" | "overview"))).cloned().collect();
    Ok(MovePageOutput { from_path: from, to_path: to, rewritten_paths: changed,
        indexing_pending_paths: pending, warnings: Vec::new(), verified: true })
}

/// 检查最深现存祖先，创建目录之前就拒绝穿透符号链接。
fn validate_destination_parent(root: &Path, target: &Path) -> Result<(), String> {
    let mut ancestor = target.parent().ok_or("目标路径缺少父目录")?;
    while !ancestor.exists() { ancestor = ancestor.parent().ok_or("目标路径没有有效祖先")?; }
    ensure_existing_ancestor_bound(root.to_str().unwrap(), ancestor)?;
    reject_symlink_components(root, ancestor)
}

/// 移动后写入所有变更；任一提交失败时恢复源文件和已触及的引用页。
fn commit_move(root: &Path, pages: &[Page], from: &str, target: &Path, approved: Option<&str>, approval_source: &str) -> Result<(), String> {
    let moved = pages.iter().find(|p| p.rel == from).unwrap();
    let mut touched = Vec::new();
    let mut renamed = false;
    let result = (|| {
        let source_approval = if approved.is_some() { file_approval::lock_mutations()? }
            else { file_approval::guard_mutation(&moved.path, None, approval_source)? };
        validate_destination_parent(root, target)?;
        if fs::symlink_metadata(target).is_ok() { return Err("目标页面已出现，未执行移动".into()); }
        reject_symlink_components(root, &moved.path)?;
        if fs::read_to_string(&moved.path).map_err(|e| e.to_string())? != moved.before { return Err("源页面已变化，未执行移动".into()); }
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        file_history::record_file_version(&moved.path, "baseline", "before.wiki.move_page");
        file_sync::mark_app_write_path(&moved.path); file_sync::mark_app_write_path(target);
        // hard_link 的 create-only 语义防止并发创建目标被 rename 覆盖；失败时保留源页。
        fs::hard_link(&moved.path, target).map_err(|e| format!("无法安全建立移动目标：{e}"))?;
        renamed = true;
        fs::remove_file(&moved.path).map_err(|e| e.to_string())?;
        // 源文件的删除期间持续持锁，随后释放再检查目标及引用页，避免重复获取审批锁。
        drop(source_approval);
        for page in pages.iter().filter(|p| p.rel == from || p.before != p.after) {
            let path = if page.rel == from { target } else { &page.path };
            let _approval = file_approval::guard_mutation(path, Some(page.after.as_bytes()), "wiki.move_page.refs")?;
            reject_symlink_components(root, path)?;
            if fs::read_to_string(path).map_err(|e| e.to_string())? != page.before { return Err(format!("页面已变化：{}", page.rel)); }
            touched.push(page);
            file_history::record_file_version(path, "baseline", "before.wiki.move_page.refs");
            file_sync::mark_app_write_path(path);
            crate::mutation::atomic_write(path, page.after.as_bytes())?;
            file_history::record_file_version(path, "agent", "wiki.move_page");
        }
        file_approval::migrate_important_path(root.to_str().unwrap(), from, target.strip_prefix(root).unwrap().to_str().unwrap())?;
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for page in touched.into_iter().rev() {
            let path = if page.rel == from { target } else { &page.path };
            if fs::read_to_string(path).ok().as_deref() != Some(page.before.as_str()) {
                if let Err(e) = crate::mutation::atomic_write(path, page.before.as_bytes()) { failures.push(e); }
            }
        }
        if renamed {
            if !moved.path.exists() {
                if let Err(e) = fs::hard_link(target, &moved.path) { failures.push(e.to_string()); }
            }
            if moved.path.exists() { if let Err(e) = fs::remove_file(target) { failures.push(e.to_string()); } }
        }
        return Err(format!("页面移动未完成：{error}；回滚{}", if failures.is_empty() { "成功".into() } else { format!("失败：{}", failures.join("；")) }));
    }
    file_sync::mark_app_write_path(&moved.path); file_sync::mark_app_write_path(target);
    Ok(())
}

/// 仅改变引用身份和跨目录相对链接，保留别名、标题、无关 frontmatter 以及代码围栏。
fn rewrite_page(content: &str, page: &str, from: &str, to: &str, matcher: &DeletionTargets) -> String {
    let mut output = String::new();
    let mut front = false;
    let mut related = false;
    let mut fence: Option<(char, usize)> = None;
    for (index, raw) in content.split_inclusive('\n').enumerate() {
        let line = raw.trim_end_matches(['\n', '\r']);
        let newline = &raw[line.len()..];
        if line == "---" && (index == 0 || front) { front = !front; related = false; output.push_str(raw); continue; }
        if front {
            if let Some(value) = line.strip_prefix("related:") {
                let value = value.trim(); related = value.is_empty();
                if value.starts_with('[') && value.ends_with(']') {
                    let items = split_yaml_list(&value[1..value.len() - 1]);
                    let updated: Vec<_> = items.iter().map(|item| if matcher.contains(item) { serde_json::to_string(to).unwrap() } else { item.to_string() }).collect();
                    if items.iter().zip(&updated).any(|(a, b)| *a != b) { output.push_str(&format!("related: [{}]{newline}", updated.join(", "))); continue; }
                }
            } else if related {
                if let Some(value) = line.trim_start().strip_prefix("- ") {
                    if matcher.contains(value) {
                        let indent = &line[..line.len() - line.trim_start().len()];
                        output.push_str(&format!("{indent}- {}{newline}", serde_json::to_string(to).unwrap())); continue;
                    }
                } else { related = false; }
            }
            output.push_str(raw); continue;
        }
        let trim = line.trim_start();
        let mark = trim.chars().next().unwrap_or_default();
        let count = trim.chars().take_while(|c| *c == mark).count();
        if matches!(mark, '`' | '~') && count >= 3 {
            match fence { None => fence = Some((mark, count)), Some((m, n)) if m == mark && count >= n => fence = None, _ => {} }
            output.push_str(raw); continue;
        }
        if fence.is_some() { output.push_str(raw); continue; }
        output.push_str(&rewrite_body_line(raw, page, from, to, matcher));
    }
    output
}

/// 行内代码保持原样；其他正文中的 Wiki 链接保留锚点及显示别名。
fn rewrite_body_line(line: &str, page: &str, from: &str, to: &str, matcher: &DeletionTargets) -> String {
    let mut output = String::new();
    let mut rest = line;
    while !rest.is_empty() {
        if rest.starts_with('`') {
            let count = rest.chars().take_while(|c| *c == '`').count();
            let marker = "`".repeat(count);
            if let Some(end) = rest[count..].find(&marker) {
                let end = count + end + count; output.push_str(&rest[..end]); rest = &rest[end..]; continue;
            }
        }
        if let Some(link) = rest.strip_prefix("[[") {
            if let Some(end) = link.find("]]") {
                let inner = &link[..end];
                let (target, alias) = inner.split_once('|').map_or((inner, None), |(a,b)| (a,Some(b)));
                if matcher.contains(target) {
                    let anchor = target.split_once('#').map(|(_, a)| format!("#{a}")).unwrap_or_default();
                    output.push_str(&format!("[[{to}{anchor}|{}]]", alias.unwrap_or(target)));
                    rest = &link[end + 2..]; continue;
                }
            }
        }
        if rest.starts_with("](") {
            output.push_str("]("); rest = &rest[2..];
            let (url, tail) = rewrite_destination(rest, page, from, to);
            output.push_str(&url); rest = tail; continue;
        }
        // Markdown 的引用式链接定义，例如 [图]: ../media/a.png。
        if rest.starts_with("]: ") {
            output.push_str("]: "); rest = &rest[3..];
            let (url, tail) = rewrite_destination(rest, page, from, to);
            output.push_str(&url); rest = tail; continue;
        }
        let ch = rest.chars().next().unwrap(); output.push(ch); rest = &rest[ch.len_utf8()..];
    }
    output
}

/// 提取链接目标时保留尖括号、标题与括号；路径内成对括号不会被截断。
fn rewrite_destination<'a>(rest: &'a str, page: &str, from: &str, to: &str) -> (String, &'a str) {
    let angle = rest.starts_with('<');
    let start = usize::from(angle);
    let mut end = rest.len();
    let mut depth = 0usize;
    for (index, ch) in rest[start..].char_indices() {
        if angle && ch == '>' { end = start + index; break; }
        if !angle {
            if ch == '(' { depth += 1; }
            if ch == ')' { if depth == 0 { end = start + index; break; } depth -= 1; }
            if ch.is_whitespace() { end = start + index; break; }
        }
    }
    let url = &rest[start..end];
    let replacement = rewrite_url(url, page, from, to).unwrap_or_else(|| url.to_string());
    (format!("{}{replacement}", if angle { "<" } else { "" }), &rest[end..])
}

/// 普通 Markdown 入链迁移到新目标；源页移动后对其他相对资源路径重新计算基准目录。
fn rewrite_url(url: &str, page: &str, from: &str, to: &str) -> Option<String> {
    if url.is_empty() || url.starts_with(['#', '?', '/']) || url.contains(':') { return None; }
    let split = url.find(['#', '?']).unwrap_or(url.len());
    let (path, suffix) = url.split_at(split);
    let decoded = decode_path(path)?;
    let project_relative = decoded.starts_with("wiki/");
    let resolved = if project_relative { normalize_path(&decoded)? } else { normalize_path(&format!("{}/{decoded}", Path::new(page).parent()?.to_str()?))? };
    let destination = if resolved == from { to } else { &resolved };
    if page != from && resolved != from { return None; }
    let updated = if project_relative { destination.to_string() } else {
        relative_path(Path::new(if page == from { to } else { page }).parent()?.to_str()?, destination)
    };
    Some(format!("{}{suffix}", encode_path(&updated)))
}

/// 只进行项目内词法归一化，不访问磁盘或跟随链接。
fn normalize_path(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in path.split('/') { match part { "" | "." => {}, ".." => { parts.pop()?; }, _ => parts.push(part) } }
    Some(parts.join("/"))
}

/// 计算两个项目相对路径之间的相对地址，供移动后的图片和文档链接使用。
fn relative_path(directory: &str, target: &str) -> String {
    let from: Vec<_> = directory.split('/').collect(); let to: Vec<_> = target.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a,b)| a == b).count();
    std::iter::repeat("..").take(from.len() - common).chain(to[common..].iter().copied()).collect::<Vec<_>>().join("/")
}

/// UTF-8 百分号路径解码失败时保持原链接，避免猜测错误目标。
fn decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes(); let mut output = Vec::new(); let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            output.push(u8::from_str_radix(std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?, 16).ok()?); index += 3;
        } else { output.push(bytes[index]); index += 1; }
    }
    String::from_utf8(output).ok()
}

/// 保留可读中文，只转义 Markdown 目标中的空白、括号和分隔符。
fn encode_path(path: &str) -> String {
    path.chars().map(|ch| if ch.is_whitespace() || matches!(ch, '(' | ')' | '%' | '#' | '?' | '<' | '>') {
        ch.to_string().as_bytes().iter().map(|b| format!("%{b:02X}")).collect()
    } else { ch.to_string() }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    struct Project(PathBuf);
    use std::path::PathBuf;
    impl Project {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("wiki-move-{}", Uuid::new_v4()));
            fs::create_dir_all(root.join(".llm-wiki")).unwrap();
            fs::create_dir_all(root.join("wiki")).unwrap();
            Self(root)
        }
        fn root(&self) -> &str { self.0.to_str().unwrap() }
        fn write(&self, path: &str, content: &str) {
            fs::create_dir_all(self.0.join(path).parent().unwrap()).unwrap();
            fs::write(self.0.join(path), content).unwrap();
        }
        fn read(&self, path: &str) -> String { fs::read_to_string(self.0.join(path)).unwrap() }
        fn request(&self, from: &str, to: &str) -> MovePageRequest {
            MovePageRequest { path: from.into(), to_path: to.into(), expected_revision: Some(revision(&self.read(from))) }
        }
        fn move_page(&self, from: &str, to: &str) -> Result<MovePageOutput, String> { move_files(self.root(), self.request(from, to), None) }
    }
    impl Drop for Project { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    /// 一次移动同时验证正文、索引、related、别名、锚点、图片相对路径和代码样例。
    #[test]
    fn move_migrates_references_and_relative_assets_without_rewriting_code() {
        let p = Project::new();
        p.write("wiki/concepts/old.md", "---\ntitle: 原标题\nsources: [source.md]\nrelated: [old, keep]\n---\n# 原标题\n![图](../media/a%20b.png)\n[外页](keep.md#一)\n[本页](?preview=1)\n[[old#定义|自己]]\n");
        p.write("wiki/index.md", "- [[concepts/old|条目]]\n- [[keep]]\n");
        p.write("wiki/kept.md", "---\nrelated:\n  - concepts/old.md\n  - keep\ntags: [old]\n---\n[[old|显示]] [[原标题]] [[concepts/old#定义]]\n[旧页](concepts/old.md#定义)\n`[[old]]`\n```md\n[[old]]\n```\n");
        let result = p.move_page("wiki/concepts/old.md", "wiki/data/nested/new.md").unwrap();
        assert!(result.verified); assert!(!p.0.join("wiki/concepts/old.md").exists());
        let moved = p.read("wiki/data/nested/new.md");
        assert!(moved.contains("title: 原标题\nsources: [source.md]"));
        assert!(moved.contains("![图](../../media/a%20b.png)"));
        assert!(moved.contains("[外页](../../concepts/keep.md#一)"));
        assert!(moved.contains("[本页](?preview=1)"));
        assert!(moved.contains("[[wiki/data/nested/new.md#定义|自己]]"));
        assert!(p.read("wiki/index.md").contains("[[wiki/data/nested/new.md|条目]]"));
        let linked = p.read("wiki/kept.md");
        assert!(linked.contains("- \"wiki/data/nested/new.md\"\n  - keep"));
        assert!(linked.contains("[[wiki/data/nested/new.md|显示]] [[wiki/data/nested/new.md|原标题]]"));
        assert!(linked.contains("[旧页](data/nested/new.md#定义)"));
        assert!(linked.contains("`[[old]]`\n```md\n[[old]]\n```"));
        assert!(linked.contains("tags: [old]"));
    }

    /// 同名存活页的裸名和标题不迁移，只有明确路径引用跟随源页移动。
    #[test]
    fn move_preserves_other_schema_links_and_refuses_existing_or_stale_destination() {
        let p = Project::new();
        p.write("wiki/a/item.md", "---\ntitle: 同名\n---\n原文");
        p.write("wiki/b/item.md", "---\ntitle: 同名\n---\n别页");
        p.write("wiki/ref.md", "[[item]] [[同名]] [[a/item]] [[b/item]]");
        let stale = p.request("wiki/a/item.md", "wiki/c/new.md");
        p.write("wiki/a/item.md", "---\ntitle: 同名\n---\n新版本");
        assert!(move_files(p.root(), stale, None).unwrap_err().contains("已变化"));
        assert!(!p.0.join("wiki/c/new.md").exists());
        assert!(p.move_page("wiki/a/item.md", "wiki/b/item.md").unwrap_err().contains("已存在"));
        p.move_page("wiki/a/item.md", "wiki/c/new.md").unwrap();
        assert_eq!(p.read("wiki/ref.md"), "[[item]] [[同名]] [[wiki/c/new.md|a/item]] [[b/item]]");
        assert_eq!(p.read("wiki/b/item.md"), "---\ntitle: 同名\n---\n别页");
    }

    /// 受保护的引用页阻断整批移动，不能先迁移文件再留下待审批的旧引用。
    #[test]
    fn protected_backlinks_prevent_move_until_reviewed() {
        let p = Project::new();
        p.write("wiki/old.md", "正文"); p.write("wiki/ref.md", "[[old]]");
        file_approval::set_important_file(p.root().into(), p.0.join("wiki/ref.md").to_string_lossy().into_owned(), true).unwrap();
        assert!(p.move_page("wiki/old.md", "wiki/new.md").unwrap_err().starts_with("FILE_APPROVAL_REQUIRED:"));
        assert_eq!(p.read("wiki/old.md"), "正文"); assert_eq!(p.read("wiki/ref.md"), "[[old]]");
        assert!(!p.0.join("wiki/new.md").exists());
        let state = file_approval::get_file_approvals(p.root().into()).unwrap();
        file_approval::review_file_change(p.root().into(), state.proposals[0].id.clone(), true).unwrap();
        p.move_page("wiki/old.md", "wiki/new.md").unwrap();
        assert_eq!(p.read("wiki/ref.md"), "[[wiki/new.md|old]]");
    }

    /// 人工审批源页移动后完成引用清理，并把重要标记继承给新路径。
    #[test]
    fn approved_move_transfers_protection_and_migrates_references() {
        let p = Project::new();
        p.write("wiki/old.md", "正文"); p.write("wiki/ref.md", "[[old]]");
        file_approval::set_important_file(p.root().into(), p.0.join("wiki/old.md").to_string_lossy().into_owned(), true).unwrap();
        assert!(p.move_page("wiki/old.md", "wiki/new.md").unwrap_err().starts_with("FILE_APPROVAL_REQUIRED:"));
        let state = file_approval::get_file_approvals(p.root().into()).unwrap();
        assert_eq!(state.proposals[0].source, "wiki.move_page:wiki/new.md");
        file_approval::review_file_change(p.root().into(), state.proposals[0].id.clone(), true).unwrap();
        assert!(!p.0.join("wiki/old.md").exists()); assert_eq!(p.read("wiki/new.md"), "正文");
        assert_eq!(p.read("wiki/ref.md"), "[[wiki/new.md|old]]");
        let state = file_approval::get_file_approvals(p.root().into()).unwrap();
        assert_eq!(state.important_paths, vec!["wiki/new.md"]); assert_eq!(state.proposals[0].status, "approved");
    }

    /// 项目外路径、源目标一致和链接目录不能扩大移动权限。
    #[test]
    fn invalid_move_targets_keep_the_source_unchanged() {
        let p = Project::new(); p.write("wiki/old.md", "原文");
        for to in ["../outside.md", "/tmp/outside.md", "raw/sources/old.md", "wiki/old.md", "wiki/../outside.md"] {
            assert!(p.move_page("wiki/old.md", to).is_err()); assert_eq!(p.read("wiki/old.md"), "原文");
        }
        #[cfg(unix)] {
            let other = Project::new();
            std::os::unix::fs::symlink(other.0.join("wiki"), p.0.join("wiki/alias")).unwrap();
            assert!(p.move_page("wiki/old.md", "wiki/alias/new.md").is_err());
            assert!(!other.0.join("wiki/new.md").exists()); assert_eq!(p.read("wiki/old.md"), "原文");
        }
    }

    /// 使用真实 LanceDB 核对旧身份和旧引用向量被移除，无模型时明确返回待索引路径。
    #[tokio::test]
    async fn move_removes_old_vector_identity_and_exposes_pending_reindex() {
        let p = Project::new(); p.write("wiki/old.md", "原文"); p.write("wiki/ref.md", "[[old]]");
        for page in ["old", "ref"] {
            vectorstore::vector_upsert_chunks(p.root().into(), page.into(), vec![vectorstore::ChunkUpsertInput {
                chunk_index: 0, chunk_text: "旧向量正文".into(), heading_path: String::new(), embedding: vec![0.1; 16],
            }]).await.unwrap();
        }
        let result = move_wiki_page(p.root().into(), p.request("wiki/old.md", "wiki/new.md"), None).await.unwrap();
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert!(result.indexing_pending_paths.contains(&"wiki/new.md".to_string()));
        let indexed = vectorstore::vector_indexed_pages(p.root().into(), None).await.unwrap();
        assert!(indexed.is_empty());
    }
}

#[cfg(test)]
mod failure_and_index_tests {
    use super::*;

    /// 一个引用页不能写入时，源页和已提交的其他引用页必须恢复，不能只回报失败。
    #[cfg(unix)]
    #[test]
    fn failed_reference_write_rolls_back_the_entire_move() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("wiki-move-rollback-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/z-locked")).unwrap();
        fs::write(root.join("wiki/old.md"), "原文").unwrap();
        fs::write(root.join("wiki/a-ref.md"), "[[old]]").unwrap();
        fs::write(root.join("wiki/z-locked/ref.md"), "[[old]]").unwrap();
        let locked = root.join("wiki/z-locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        // root 或不执行 Unix 权限的平台无法提供此故障条件，不把成功写入误判为回滚问题。
        let probe = locked.join("probe");
        if fs::write(&probe, "").is_ok() {
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            fs::remove_dir_all(root).unwrap(); return;
        }
        let result = move_files(root.to_str().unwrap(), MovePageRequest { path: "wiki/old.md".into(), to_path: "wiki/new.md".into(), expected_revision: None }, None);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.unwrap_err().contains("回滚成功"));
        assert_eq!(fs::read_to_string(root.join("wiki/old.md")).unwrap(), "原文");
        assert_eq!(fs::read_to_string(root.join("wiki/a-ref.md")).unwrap(), "[[old]]");
        assert_eq!(fs::read_to_string(root.join("wiki/z-locked/ref.md")).unwrap(), "[[old]]");
        assert!(!root.join("wiki/new.md").exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// 使用临时嵌入服务和真实 LanceDB，确认可用配置下新页面和引用页都完成重建。
    #[tokio::test]
    async fn configured_move_reindexes_new_identity_and_rewritten_references() {
        let root = std::env::temp_dir().join(format!("wiki-move-reindex-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("wiki/old.md"), "# 页面\n确定的业务事实。").unwrap();
        fs::write(root.join("wiki/ref.md"), "# 引用页\n[[old|旧链接]]").unwrap();
        fs::write(root.join("wiki/index.md"), "- [[old|目录]]").unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1/embeddings", server.server_addr());
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let mut request = server.recv_timeout(std::time::Duration::from_secs(10)).unwrap().unwrap();
                let mut body = String::new(); request.as_reader().read_to_string(&mut body).unwrap();
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                let count = value["input"].as_array().map_or(1, |items| items.len());
                requests.push(value);
                let data: Vec<_> = (0..count).map(|index| serde_json::json!({"index":index,"embedding":vec![0.1;16]})).collect();
                request.respond(tiny_http::Response::from_string(serde_json::json!({"data":data}).to_string())
                    .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())).unwrap();
            }
            requests
        });
        let config = SearchEmbeddingConfig { enabled: true, endpoint, api_key: String::new(), model: "test-embed".into(),
            output_dimensionality: Some(16.0), extra_headers: None, max_chunk_chars: None, overlap_chunk_chars: None };
        let result = move_wiki_page(root.to_string_lossy().into_owned(), MovePageRequest {
            path: "wiki/old.md".into(), to_path: "wiki/new.md".into(), expected_revision: None,
        }, Some(config.clone())).await.unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(result.indexing_pending_paths.is_empty(), "{:?}", result.warnings);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let rows = vectorstore::vector_indexed_pages(root.to_string_lossy().into_owned(), Some(config)).await.unwrap();
        let rows = serde_json::to_value(rows).unwrap();
        let ids: BTreeSet<_> = rows.as_array().unwrap().iter().map(|row| row["pageId"].as_str().unwrap()).collect();
        assert_eq!(ids, BTreeSet::from(["new", "ref"]));
        assert!(rows.as_array().unwrap().iter().all(|row| row["backendRevision"].is_string()));
        fs::remove_dir_all(root).unwrap();
    }
}
