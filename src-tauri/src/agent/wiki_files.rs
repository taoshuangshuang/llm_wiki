//! 页面枚举与原始资料精确读取；所有调用方共用范围、分页和版本核对规则。
use std::{fs, path::{Component, Path}, time::SystemTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use super::tools::safe_project_join;
use super::wiki_delete::reject_symlink_components;

const MAX_SCAN: usize = 20_000;
const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListPagesRequest {
    pub prefix: Option<String>, pub offset: Option<usize>, pub limit: Option<usize>, pub snapshot: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedPage { pub path: String, pub bytes: u64 }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPagesOutput {
    pub pages: Vec<ListedPage>, pub total: usize, pub offset: usize, pub next_offset: Option<usize>,
    pub truncated: bool, pub snapshot: String,
}

/// 列出所有匹配磁盘页面，按路径排序；超过预算或扫描不完整时明确失败。
pub fn list_pages(project_path: &str, request: ListPagesRequest) -> Result<ListPagesOutput, String> {
    let _mutation = crate::mutation::lock()?;
    let prefix = request.prefix.as_deref().unwrap_or("wiki/");
    validate_relative(prefix.trim_end_matches('/'), "wiki")?;
    let root = Path::new(project_path).canonicalize().map_err(|e| e.to_string())?;
    let wiki = root.join("wiki");
    let mut entries = Vec::new();
    if wiki.exists() {
        reject_symlink_components(&root, &wiki)?;
        for (index, item) in WalkDir::new(&wiki).follow_links(false).into_iter().filter_entry(|e| {
            e.depth() == 0 || (!e.file_name().to_string_lossy().starts_with('.') && e.file_name() != "media")
        }).enumerate() {
            if index >= MAX_SCAN { return Err("Wiki 列表扫描超出预算，结果不完整".into()); }
            let entry = item.map_err(|e| format!("Wiki 列表扫描失败：{e}"))?;
            if entry.file_type().is_symlink() { return Err("Wiki 存在符号链接，无法保证列表完整".into()); }
            if !entry.file_type().is_file() || entry.path().extension().is_none_or(|v| v != "md") { continue; }
            let rel = entry.path().strip_prefix(&root).unwrap().to_str().ok_or("页面路径不是 UTF-8")?.replace('\\', "/");
            if !rel.starts_with(prefix) { continue; }
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let modified = metadata.modified().map_err(|e| e.to_string())?.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos();
            entries.push((rel, metadata.len(), modified));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let snapshot = revision(&serde_json::to_string(&entries).map_err(|e| e.to_string())?);
    if request.snapshot.as_ref().is_some_and(|expected| expected != &snapshot) {
        return Err("Wiki 页面列表已变化，请从 offset=0 重新列举".into());
    }
    let total = entries.len();
    let offset = request.offset.unwrap_or(0);
    if offset > total { return Err("offset 超过列表总数".into()); }
    let limit = request.limit.unwrap_or(100);
    if !(1..=500).contains(&limit) { return Err("limit 必须在 1–500 之间".into()); }
    // 同时按字符预算分页，避免 Agent 观察记录截断后错误声称已列完。
    let mut pages = Vec::new();
    let mut budget = 0;
    for (path, bytes, _) in entries.into_iter().skip(offset).take(limit) {
        let cost = path.chars().count() + 48;
        if !pages.is_empty() && budget + cost > 6_000 { break; }
        budget += cost;
        pages.push(ListedPage { path, bytes });
    }
    let end = offset + pages.len();
    Ok(ListPagesOutput { pages, total, offset, next_offset: (end < total).then_some(end), truncated: end < total, snapshot })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadSourceRequest {
    pub path: String, pub start_line: Option<usize>, pub end_line: Option<usize>,
    pub start_column: Option<usize>, pub max_chars: Option<usize>, pub revision: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSourceOutput {
    pub path: String, pub content: String, pub revision: String, pub total_lines: usize,
    pub start_line: usize, pub start_column: usize, pub end_line: usize,
    pub next_start_line: Option<usize>, pub next_start_column: Option<usize>, pub truncated: bool,
    pub representation: String,
}

/// 返回来源原文或最新提取正文；行列均从 1 开始，长行也可接续读取，不静默丢字。
pub fn read_source(project_path: &str, request: ReadSourceRequest) -> Result<ReadSourceOutput, String> {
    validate_relative(&request.path, "raw/sources")?;
    let root = Path::new(project_path).canonicalize().map_err(|e| e.to_string())?;
    let path = safe_project_join(root.to_str().unwrap(), &request.path)?;
    reject_symlink_components(&root, &path)?;
    let metadata = fs::metadata(&path).map_err(|e| format!("来源不存在：{e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES { return Err("来源须为不超过 16 MiB 的文件".into()); }
    let extension = path.extension().and_then(|v| v.to_str()).unwrap_or_default().to_ascii_lowercase();
    let binary = ["pdf", "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm", "xls", "xlsx", "xlsm", "xlsb", "odt", "ods", "odp", "rtf", "epub", "mobi"].contains(&extension.as_str());
    let text = if binary {
        // 只读应用验证为最新的提取缓存；不将二进制字节或过期正文作为证据。
        let cache = path.parent().unwrap().join(".cache");
        let filename = path.file_name().unwrap().to_string_lossy();
        for candidate in [cache.clone(), cache.join(format!("{filename}.txt")), cache.join(format!("{filename}.txt.parser"))] {
            if candidate.exists() {
                reject_symlink_components(&root, &candidate)?;
                if candidate.is_file() && fs::metadata(&candidate).map_err(|e| e.to_string())?.len() > MAX_SOURCE_BYTES { return Err("提取正文超出读取预算".into()); }
            }
        }
        crate::commands::fs::read_preprocessed_cache(&path).ok_or("没有最新的提取正文，请先在应用中完成来源提取")?
    } else { fs::read_to_string(&path).map_err(|e| format!("来源不是可读 UTF-8 文本：{e}"))? };
    let after = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() != after.len() || metadata.modified().map_err(|e| e.to_string())? != after.modified().map_err(|e| e.to_string())? {
        return Err("来源在读取期间发生变化，请重新读取".into());
    }
    read_text_range(&text, request, if binary { "extracted_text" } else { "original_text" })
}

/// Wiki 和来源共用原文切片协议；返回实际行列、续读位置与版本，保留所有空白。
pub(crate) fn read_text_range(text: &str, request: ReadSourceRequest, representation: &str) -> Result<ReadSourceOutput, String> {
    let current_revision = revision(text);
    if request.revision.as_ref().is_some_and(|v| v != &current_revision) { return Err("正文已变化，请从第一段重新读取".into()); }
    let total_lines = text.split_inclusive('\n').count();
    let start = request.start_line.unwrap_or(1);
    let end = request.end_line.unwrap_or(total_lines);
    let column = request.start_column.unwrap_or(1);
    let max_chars = request.max_chars.unwrap_or(4_000);
    if start == 0 || column == 0 || !(1..=12_000).contains(&max_chars) { return Err("行列须从 1 开始，maxChars 须在 1–12000 之间".into()); }
    if total_lines > 0 && (start > total_lines || end < start || end > total_lines) { return Err("正文读取行范围无效".into()); }
    if total_lines == 0 && (start != 1 || column != 1 || request.end_line.is_some_and(|v| v != 0)) { return Err("空正文的读取行范围无效".into()); }
    if let Some(line) = text.split_inclusive('\n').nth(start - 1) {
        if column > line.chars().count().max(1) { return Err("startColumn 超出所在行".into()); }
    }
    let mut content = String::new();
    let mut chars = 0;
    let mut next = None;
    let mut consumed_end = start.saturating_sub(1);
    'outer: for (index, body) in text.split_inclusive('\n').enumerate().skip(start - 1).take(end.saturating_sub(start) + 1) {
        let line = index + 1;
        let skip = if line == start { column - 1 } else { 0 };
        for (col, ch) in body.chars().enumerate().skip(skip) {
            if chars == max_chars { next = Some((line, col + 1)); break 'outer; }
            content.push(ch); chars += 1; consumed_end = line;
        }
    }
    Ok(ReadSourceOutput { path: request.path, content, revision: current_revision, total_lines,
        start_line: start, start_column: column, end_line: consumed_end,
        next_start_line: next.map(|v| v.0), next_start_column: next.map(|v| v.1), truncated: next.is_some(),
        representation: representation.into() })
}

/// 路径不做猜测或自动去掉前缀，拒绝隐藏文件、父级跳转和跨平台绝对路径。
fn validate_relative(path: &str, root: &str) -> Result<(), String> {
    if path != root && !path.starts_with(&format!("{root}/")) { return Err(format!("path 必须位于 {root}/")); }
    if path.contains('\\') || path.split('/').any(|p| p.is_empty() || p.starts_with('.') || p.contains(':'))
        || Path::new(path).components().any(|p| !matches!(p, Component::Normal(_))) {
        return Err("path 含非法路径片段".into());
    }
    Ok(())
}

/// 显式读取、分页和移动共用正文版本标识。
pub(crate) fn revision(text: &str) -> String { format!("sha256:{:x}", Sha256::digest(text.as_bytes())) }

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    struct Project(std::path::PathBuf);
    impl Project {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("wiki-files-{}", Uuid::new_v4()));
            fs::create_dir_all(path.join("wiki/data")).unwrap();
            fs::create_dir_all(path.join("raw/sources")).unwrap();
            Self(path)
        }
        fn root(&self) -> &str { self.0.to_str().unwrap() }
        fn read(&self, request: serde_json::Value) -> Result<ReadSourceOutput, String> {
            read_source(self.root(), serde_json::from_value(request).unwrap())
        }
    }
    impl Drop for Project { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    /// 分页结果按路径稳定排序、限定前缀，后续页面可以校验相同快照。
    #[test]
    fn list_pages_paginates_all_duplicates_and_detects_changed_snapshot() {
        let p = Project::new();
        for index in 0..37 { fs::write(p.0.join(format!("wiki/data/table-{index:02}.md")), "正文").unwrap(); }
        fs::write(p.0.join("wiki/other.md"), "其他").unwrap();
        let mut all = Vec::new();
        let mut offset = 0;
        let mut snapshot = None;
        loop {
            let result = list_pages(p.root(), ListPagesRequest { prefix: Some("wiki/data/table-".into()), offset: Some(offset), limit: Some(10), snapshot: snapshot.clone() }).unwrap();
            assert_eq!(result.total, 37);
            snapshot = Some(result.snapshot);
            all.extend(result.pages.into_iter().map(|p| p.path));
            if let Some(next) = result.next_offset { assert!(result.truncated); offset = next; } else { assert!(!result.truncated); break; }
        }
        assert_eq!(all.len(), 37);
        assert!(all.windows(2).all(|pair| pair[0] < pair[1]));
        fs::write(p.0.join("wiki/data/table-99.md"), "新增").unwrap();
        assert!(list_pages(p.root(), ListPagesRequest { prefix: Some("wiki/data/table-".into()), snapshot, ..Default::default() }).unwrap_err().contains("已变化"));
    }

    /// 长行与中文按字符续读，拼接后必须逐字等于来源，不通过空白折叠冒充完整读取。
    #[test]
    fn source_read_preserves_unicode_long_lines_and_revision_across_pages() {
        let p = Project::new();
        let text = format!("标题\r\n{}\n最后一行", "汉字内容".repeat(100));
        fs::write(p.0.join("raw/sources/doc.md"), &text).unwrap();
        let (mut line, mut column, mut version) = (1, 1, None);
        let mut reconstructed = String::new();
        loop {
            let part = p.read(serde_json::json!({"path":"raw/sources/doc.md","startLine":line,"startColumn":column,"maxChars":37,"revision":version})).unwrap();
            assert_eq!(part.total_lines, 3);
            reconstructed.push_str(&part.content);
            version = Some(part.revision);
            match (part.next_start_line, part.next_start_column) {
                (Some(l), Some(c)) => { assert!(part.truncated); line = l; column = c; },
                _ => { assert!(!part.truncated); break; }
            }
        }
        assert_eq!(reconstructed, text);
        fs::write(p.0.join("raw/sources/doc.md"), "已修改").unwrap();
        assert!(p.read(serde_json::json!({"path":"raw/sources/doc.md","revision":version})).unwrap_err().contains("已变化"));
    }

    /// 指定行区间只返回原文区间；空文件与非法行列范围均有明确契约。
    #[test]
    fn source_read_handles_ranges_empty_files_and_invalid_inputs() {
        let p = Project::new();
        fs::write(p.0.join("raw/sources/doc.md"), "一\n二\n三").unwrap();
        assert_eq!(p.read(serde_json::json!({"path":"raw/sources/doc.md","startLine":2,"endLine":2})).unwrap().content, "二\n");
        for request in [serde_json::json!({"path":"raw/sources/doc.md","startLine":0}), serde_json::json!({"path":"raw/sources/doc.md","startLine":4}), serde_json::json!({"path":"raw/sources/doc.md","startColumn":10}), serde_json::json!({"path":"wiki/other.md"}), serde_json::json!({"path":"raw/sources/../secret"}), serde_json::json!({"path":"raw/sources/.cache/secret.txt"})] {
            assert!(p.read(request).is_err());
        }
        fs::write(p.0.join("raw/sources/empty.txt"), "").unwrap();
        let empty = p.read(serde_json::json!({"path":"raw/sources/empty.txt"})).unwrap();
        assert_eq!(empty.content, ""); assert_eq!(empty.total_lines, 0);
    }

    /// 二进制只读最新的已提取正文；过期缓存不得被引用。
    #[test]
    fn binary_source_read_uses_fresh_extraction_and_refuses_stale_cache() {
        let p = Project::new();
        let original = p.0.join("raw/sources/file.pdf");
        fs::write(&original, b"%PDF fixture").unwrap();
        fs::create_dir_all(p.0.join("raw/sources/.cache")).unwrap();
        let cache = p.0.join("raw/sources/.cache/file.pdf.txt");
        fs::write(&cache, "提取正文\n第二行").unwrap();
        let result = p.read(serde_json::json!({"path":"raw/sources/file.pdf"})).unwrap();
        assert_eq!(result.content, "提取正文\n第二行"); assert_eq!(result.representation, "extracted_text");
        fs::File::open(&cache).unwrap().set_times(fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH)).unwrap();
        assert!(p.read(serde_json::json!({"path":"raw/sources/file.pdf"})).unwrap_err().contains("最新"));
    }

    /// 列表和来源读取都不穿透符号链接，也不暴露应用元数据。
    #[cfg(unix)]
    #[test]
    fn list_and_source_read_reject_symlinks_and_private_paths() {
        let p = Project::new();
        let other = Project::new();
        fs::write(other.0.join("raw/sources/private.txt"), "私密").unwrap();
        std::os::unix::fs::symlink(other.0.join("raw/sources/private.txt"), p.0.join("raw/sources/alias.txt")).unwrap();
        assert!(p.read(serde_json::json!({"path":"raw/sources/alias.txt"})).is_err());
        for prefix in ["../", "wiki/../", "/wiki/", "wiki/.hidden/"] {
            assert!(list_pages(p.root(), ListPagesRequest { prefix: Some(prefix.into()), ..Default::default() }).is_err());
        }
        std::os::unix::fs::symlink(other.0.join("wiki"), p.0.join("wiki/alias")).unwrap();
        assert!(list_pages(p.root(), ListPagesRequest::default()).is_err());
    }
}
