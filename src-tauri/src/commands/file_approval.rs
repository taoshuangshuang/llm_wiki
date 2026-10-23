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
    let _guard = lock_mutations()?;
    let root = resolved_path(Path::new(&project_path))?;
    let mut state = load_state(&root)?;
    let item = state.proposals.iter_mut().find(|item| item.id == proposal_id)
        .ok_or("File change proposal not found")?;
    if item.status != "pending" { return Err("File change proposal was already reviewed".to_string()); }
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

/// 原文编辑器的人工保存入口，与模型的通用写入入口区分。
#[tauri::command]
pub fn save_human_file(path: String, contents: String) -> Result<(), String> {
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
