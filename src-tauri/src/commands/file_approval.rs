//! 重要档案保护：模型只提交草稿，人工审核通过后才替换原文。
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const STATE_FILE: &str = "file-approvals.json";
const MAX_CONTENT_BYTES: usize = 4 * 1024 * 1024;
static MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileApprovalState {
    pub important_paths: Vec<String>,
    pub proposals: Vec<FileChangeProposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeProposal {
    pub id: String,
    pub path: String,
    pub original: String,
    /// None 表示删除；空字符串表示清空文件。
    pub proposed: Option<String>,
    pub source: String,
    pub created_at: i64,
    pub status: String,
    pub reviewed_at: Option<i64>,
}

pub fn lock_mutations() -> Result<MutexGuard<'static, ()>, String> {
    MUTATION_LOCK.lock().map_err(|_| "File approval lock is unavailable".to_string())
}

/// Shell 无法可靠地预判所有间接写入；启用重要保护时须逐条人工批准命令。
pub fn project_has_important_files(project_path: &str) -> Result<bool, String> {
    let _guard = lock_mutations()?;
    let project = resolved_path(Path::new(project_path))?;
    for root in project.ancestors().filter(|dir| fs::symlink_metadata(dir.join(".llm-wiki")).is_ok()) {
        if !load_state(root)?.important_paths.is_empty() { return Ok(true); }
    }
    Ok(false)
}

/// 将尚不存在的尾部接到真实祖先上，确保别名路径也命中同一份保护规则。
fn resolved_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err("File approval requires an absolute path without '..'".to_string());
    }
    let mut ancestor = path;
    let mut tail = Vec::new();
    while !ancestor.exists() {
        tail.push(ancestor.file_name().ok_or("Invalid file path")?.to_os_string());
        ancestor = ancestor.parent().ok_or("Invalid file ancestor")?;
    }
    let mut resolved = ancestor.canonicalize().map_err(|err| err.to_string())?;
    for part in tail.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

fn project_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|dir| fs::symlink_metadata(dir.join(".llm-wiki")).is_ok())
        .map(Path::to_path_buf)
}

fn state_path(root: &Path) -> Result<PathBuf, String> {
    let metadata_dir = root.join(".llm-wiki");
    let metadata = fs::symlink_metadata(&metadata_dir).map_err(|err| err.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("File approval metadata must be a real project directory".to_string());
    }
    let path = metadata_dir.join(STATE_FILE);
    match fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
            return Err("File approval state must be a regular file".to_string());
        }
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.to_string()),
        _ => {}
    }
    Ok(path)
}

fn load_state(root: &Path) -> Result<FileApprovalState, String> {
    let path = state_path(root)?;
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|err| format!("Invalid file approval state: {err}")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(FileApprovalState::default()),
        Err(err) => Err(err.to_string()),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_file_name(format!(".approval-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        fs::write(&temp, bytes).map_err(|err| err.to_string())?;
        if let Ok(metadata) = fs::metadata(path) {
            fs::set_permissions(&temp, metadata.permissions()).map_err(|err| err.to_string())?;
        }
        fs::rename(&temp, path).map_err(|err| err.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

fn save_state(root: &Path, state: &FileApprovalState) -> Result<(), String> {
    let path = state_path(root)?;
    atomic_write(&path, &serde_json::to_vec_pretty(state).map_err(|err| err.to_string())?)
}

fn relative_path(root: &Path, file: &Path) -> Result<String, String> {
    let relative = file.strip_prefix(root).map_err(|_| "File must stay inside the project")?;
    if relative.as_os_str().is_empty()
        || relative.components().any(|part| !matches!(part, Component::Normal(_)))
        || relative.starts_with(".llm-wiki")
    {
        return Err("Important files must be content files inside the project".to_string());
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn read_content(file: &Path) -> Result<String, String> {
    let metadata = fs::metadata(file).map_err(|err| err.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_CONTENT_BYTES as u64 {
        return Err("Important files must be UTF-8 text files of at most 4 MiB".to_string());
    }
    fs::read_to_string(file).map_err(|err| format!("Cannot read important file as UTF-8: {err}"))
}

/// 返回的锁须持有到写入结束，避免标记、审批和应用内写入之间出现竞态。
/// 重要文件的请求持久化后返回明确错误，调用方不能将草稿计为已写入。
pub fn guard_mutation(
    path: &Path,
    proposed: Option<&[u8]>,
    source: &str,
) -> Result<MutexGuard<'static, ()>, String> {
    guard_mutation_with(path, || Ok(proposed.map(<[u8]>::to_vec)), source)
}

/// 只在目标受保护时读取复制源，避免普通大文件导入额外占用内存。
pub fn guard_copy(path: &Path, copy_source: &Path) -> Result<MutexGuard<'static, ()>, String> {
    guard_mutation_with(path, || {
        let metadata = fs::metadata(copy_source).map_err(|err| err.to_string())?;
        if metadata.len() > MAX_CONTENT_BYTES as u64 { return Err("Important file proposal exceeds 4 MiB".to_string()); }
        fs::read(copy_source).map(Some).map_err(|err| err.to_string())
    }, "copy_file")
}

/// 普通工作区分块追加保持原有开销，只为受保护文件构造完整待审核正文。
pub fn guard_append(path: &Path, content: &[u8]) -> Result<MutexGuard<'static, ()>, String> {
    guard_mutation_with(path, || {
        let mut bytes = fs::read(path).map_err(|err| err.to_string())?;
        if bytes.len().saturating_add(content.len()) > MAX_CONTENT_BYTES {
            return Err("Important file proposal exceeds 4 MiB".to_string());
        }
        bytes.extend_from_slice(content);
        Ok(Some(bytes))
    }, "workspace.append_file")
}

fn guard_mutation_with(
    path: &Path,
    proposed: impl FnOnce() -> Result<Option<Vec<u8>>, String>,
    source: &str,
) -> Result<MutexGuard<'static, ()>, String> {
    let guard = lock_mutations()?;
    let resolved = resolved_path(path)?;
    // 检查所有祖先项目，不能通过在子目录建立另一份 .llm-wiki 绕过外层保护。
    let mut protected = None;
    for root in resolved.ancestors().filter(|dir| fs::symlink_metadata(dir.join(".llm-wiki")).is_ok()) {
        let state = load_state(root)?;
        if resolved == root.join(".llm-wiki").join(STATE_FILE)
            || root.join(".llm-wiki").starts_with(&resolved)
        {
            return Err("File approval policy can only be changed through the review controls".to_string());
        }
        if resolved.is_dir() && state.important_paths.iter().any(|relative| root.join(relative).starts_with(&resolved)) {
            return Err("Directory contains important files; review each file deletion first".to_string());
        }
        let relative = resolved.strip_prefix(root).map_err(|err| err.to_string())?
            .to_string_lossy().replace('\\', "/");
        if state.important_paths.contains(&relative) {
            protected = Some((root.to_path_buf(), state, relative));
        }
    }
    let Some((root, mut state, relative)) = protected else { return Ok(guard); };
    let original = read_content(&resolved)?;
    let candidate = proposed()?.map(|bytes| {
        if bytes.len() > MAX_CONTENT_BYTES { return Err("Important file proposal exceeds 4 MiB".to_string()); }
        String::from_utf8(bytes).map_err(|_| "Important file proposals must be UTF-8 text".to_string())
    }).transpose()?;
    if candidate.as_deref() == Some(original.as_str()) { return Ok(guard); }
    let existing = state.proposals.iter().find(|item| item.status == "pending"
        && item.path == relative && item.original == original && item.proposed == candidate);
    let id = if let Some(item) = existing { item.id.clone() } else {
        let id = Uuid::new_v4().to_string();
        state.proposals.push(FileChangeProposal {
            id: id.clone(), path: relative.clone(), original, proposed: candidate,
            source: source.to_string(), created_at: chrono::Utc::now().timestamp_millis(),
            status: "pending".to_string(), reviewed_at: None,
        });
        save_state(&root, &state)?;
        id
    };
    Err(format!("FILE_APPROVAL_REQUIRED: Important file '{relative}' is unchanged. Proposal {id} is pending human review in the Review tab; do not retry or claim the file was saved."))
}

#[tauri::command]
pub fn get_file_approvals(project_path: String) -> Result<FileApprovalState, String> {
    let _guard = lock_mutations()?;
    load_state(&resolved_path(Path::new(&project_path))?)
}

/// 仅供用户界面调用；不向 Agent 或 HTTP/MCP 提供标记、解锁或审批能力。
#[tauri::command]
pub fn set_important_file(project_path: String, file_path: String, important: bool) -> Result<(), String> {
    let _guard = lock_mutations()?;
    let root = resolved_path(Path::new(&project_path))?;
    let file = resolved_path(Path::new(&file_path))?;
    let relative = relative_path(&root, &file)?;
    if important { read_content(&file)?; }
    let mut state = load_state(&root)?;
    state.important_paths.retain(|path| path != &relative);
    if important { state.important_paths.push(relative); }
    state.important_paths.sort();
    save_state(&root, &state)
}

#[tauri::command]
pub fn review_file_change(project_path: String, proposal_id: String, approve: bool) -> Result<(), String> {
    let _commit = crate::mutation::lock()?;
    let _guard = lock_mutations()?;
    let root = resolved_path(Path::new(&project_path))?;
    let mut state = load_state(&root)?;
    let item = state.proposals.iter_mut().find(|item| item.id == proposal_id)
        .ok_or("File change proposal not found")?;
    if item.status != "pending" { return Err("File change proposal was already reviewed".to_string()); }
    if approve && (item.source == "wiki.delete_page" || item.source.starts_with("wiki.move_page:")) && item.proposed.is_none() {
        // 页面删除必须连同引用及索引一起完成，不能审批时只删文件留下断链。
        let (path, original) = (item.path.clone(), item.original.clone());
        let move_to = item.source.strip_prefix("wiki.move_page:").map(str::to_string);
        drop(_guard);
        drop(_commit);
        let warnings = if let Some(to) = &move_to {
            tauri::async_runtime::block_on(crate::agent::wiki_move::move_approved_wiki_page(
                root.to_string_lossy().into_owned(), path.clone(), to.clone(), original,
            ))?.warnings
        } else {
            tauri::async_runtime::block_on(crate::agent::wiki_delete::delete_approved_wiki_page(
                root.to_string_lossy().into_owned(), path.clone(), original,
            ))?.warnings
        };
        let _commit = crate::mutation::lock()?;
        let _guard = lock_mutations()?;
        let mut state = load_state(&root)?;
        let item = state.proposals.iter_mut().find(|item| item.id == proposal_id)
            .ok_or("File change proposal not found")?;
        item.status = "approved".into();
        item.reviewed_at = Some(chrono::Utc::now().timestamp_millis());
        state.important_paths.retain(|marked| marked != &path);
        save_state(&root, &state)?;
        return if warnings.is_empty() { Ok(()) }
            else { Err(format!("页面已变更，仍有清理警告：{}", warnings.join("；"))) };
    }
    if approve {
        let file = resolved_path(&root.join(&item.path))?;
        if relative_path(&root, &file)? != item.path {
            return Err("File change proposal target has moved".to_string());
        }
        if read_content(&file)? != item.original {
            return Err("FILE_APPROVAL_CONFLICT: The original file changed. Reject this proposal and generate a new one.".to_string());
        }
        super::file_history::record_file_version(&file, "baseline", "before.approved_file_change");
        super::file_sync::mark_app_write_path(&file);
        if let Some(content) = &item.proposed {
            atomic_write(&file, content.as_bytes())?;
            super::file_history::record_file_version(&file, "agent", "approved_file_change");
        } else {
            fs::remove_file(&file).map_err(|err| err.to_string())?;
        }
        super::file_sync::mark_app_write_path(&file);
    }
    item.status = if approve { "approved" } else { "rejected" }.to_string();
    item.reviewed_at = Some(chrono::Utc::now().timestamp_millis());
    let deleted_path = (approve && item.proposed.is_none()).then(|| item.path.clone());
    if let Some(path) = deleted_path { state.important_paths.retain(|marked| marked != &path); }
    save_state(&root, &state)
}

/// 页面身份移动后继承重要标记；只由持有全局提交锁的生命周期调用。
pub(crate) fn migrate_important_path(project_path: &str, from: &str, to: &str) -> Result<(), String> {
    let root = Path::new(project_path);
    if !root.join(".llm-wiki").exists() { return Ok(()); }
    let _guard = lock_mutations()?;
    let mut state = load_state(root)?;
    if state.important_paths.iter().any(|path| path == from) {
        state.important_paths.retain(|path| path != from);
        if !state.important_paths.iter().any(|path| path == to) { state.important_paths.push(to.to_string()); }
        state.important_paths.sort();
        save_state(root, &state)?;
    }
    Ok(())
}

/// 原文编辑器的人工保存入口，与模型的通用写入入口区分。
#[tauri::command]
pub fn save_human_file(path: String, contents: String) -> Result<(), String> {
    let _commit = crate::mutation::lock()?;
    let _guard = lock_mutations()?;
    let file = resolved_path(Path::new(&path))?;
    if let Some(root) = project_root(&file) { relative_path(&root, &file)?; }
    super::file_history::record_file_version(&file, "baseline", "before.human_editor");
    super::file_sync::mark_app_write_path(&file);
    atomic_write(&file, contents.as_bytes())?;
    super::file_history::record_file_version(&file, "human", "human_editor");
    super::file_sync::mark_app_write_path(&file);
    Ok(())
}

/// 知识流程编辑器只写项目配置，并在同一提交锁内核对读取版本。
#[tauri::command]
pub fn save_workflow_file(project_path: String, relative_path: String, expected: Option<String>, contents: String) -> Result<(), String> {
    let parts: Vec<&str> = relative_path.split('/').collect();
    let valid = matches!(relative_path.as_str(), "purpose.md" | "schema.md" | "page-rules.md" | "business-modules.md")
        || (parts.len() == 2 && parts[0] == "prompts" && parts[1].ends_with(".md")
            && !parts[1].starts_with('.') && !parts[1].contains(['\\', ':'])
            && !parts[1].chars().any(char::is_control));
    if !valid { return Err("知识流程配置路径无效".into()); }
    let _commit = crate::mutation::lock()?;
    let _guard = lock_mutations()?;
    let root = fs::canonicalize(&project_path).map_err(|error| error.to_string())?;
    let file = resolved_path(&root.join(&relative_path))?;
    if !file.starts_with(&root) { return Err("配置文件超出当前项目".into()); }
    let current = match fs::read_to_string(&file) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if current != expected { return Err("配置文件已被其他操作修改，请重新读取并核对后保存".into()); }
    if let Some(parent) = file.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    super::file_history::record_file_version(&file, "baseline", "before.workflow_editor");
    super::file_sync::mark_app_write_path(&file);
    atomic_write(&file, contents.as_bytes())?;
    super::file_history::record_file_version(&file, "human", "workflow_editor");
    super::file_sync::mark_app_write_path(&file);
    Ok(())
}

#[cfg(test)]
mod workflow_file_tests {
    use super::*;

    #[test]
    fn workflow_save_checks_version_and_creates_only_allowed_project_files() {
        let root = std::env::temp_dir().join(format!("workflow-files-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let project = root.to_string_lossy().to_string();
        save_workflow_file(project.clone(), "business-modules.md".into(), None, "原始字典".into()).unwrap();
        assert!(save_workflow_file(project.clone(), "business-modules.md".into(), None, "过期覆盖".into()).is_err());
        assert_eq!(fs::read_to_string(root.join("business-modules.md")).unwrap(), "原始字典");
        save_workflow_file(project.clone(), "business-modules.md".into(), Some("原始字典".into()), "新字典".into()).unwrap();
        save_workflow_file(project.clone(), "prompts/规则.md".into(), None, "提示词".into()).unwrap();
        assert_eq!(fs::read_to_string(root.join("prompts/规则.md")).unwrap(), "提示词");
        for invalid in ["../outside.md", "prompts/../outside.md", "wiki/page.md", ".llm-wiki/config.md", "prompts/.hidden.md", "prompts/nested/rule.md"] {
            assert!(save_workflow_file(project.clone(), invalid.into(), None, "无效写入".into()).is_err(), "{invalid}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn workflow_save_cannot_follow_a_prompt_directory_outside_project() {
        let root = std::env::temp_dir().join(format!("workflow-links-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("workflow-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("prompts")).unwrap();
        assert!(save_workflow_file(root.to_string_lossy().into_owned(), "prompts/rule.md".into(), None, "越界".into()).is_err());
        assert!(!outside.join("rule.md").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
