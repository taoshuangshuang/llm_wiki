//! 对话只负责提交原始材料；知识提取、查重、合并和索引统一由现有入库队列执行。
use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::tools::{
    atomic_replace_file, ensure_existing_ancestor_bound, ensure_project_bound_path,
    normalize_wiki_write_path, safe_project_join, WikiWriteOutput, MAX_WRITE_PAGE_BYTES,
};
use super::types::AgentReference;

const INBOX: &str = ".llm-wiki/conversation-ingest";
const SOURCES: &str = "raw/sources/conversations";
static INBOX_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationIngest {
    pub id: String,
    pub source_path: String,
    pub requested_path: String,
}

/// 原文和待处理凭据先可靠落盘；重复提交相同材料复用来源，不直接创建或覆盖知识页。
pub fn submit_conversation_ingest(
    project_path: &str,
    requested_path: &str,
    content: &str,
) -> Result<WikiWriteOutput, String> {
    if content.trim().is_empty() || content.len() > MAX_WRITE_PAGE_BYTES {
        return Err("对话入库内容为空或超过大小限制".to_string());
    }
    let requested_path = normalize_wiki_write_path(requested_path)?;
    let _guard = INBOX_LOCK.lock().map_err(|_| "对话入库锁不可用".to_string())?;
    let encoded = serde_json::to_vec(&(&requested_path, content)).map_err(|err| err.to_string())?;
    let id = format!("{:x}", Sha256::digest(encoded));
    let source_path = format!("{SOURCES}/{id}.md");
    let source = managed_file(project_path, &source_path, true)?;
    let existed_before = source.exists();
    if existed_before {
        if fs::read(&source).map_err(|err| err.to_string())? != content.as_bytes() {
            return Err("已留存的对话来源被修改，请核对原始资料后重试".to_string());
        }
    } else {
        let _approval = crate::commands::file_approval::guard_mutation(
            &source, Some(content.as_bytes()), "conversation.ingest",
        )?;
        atomic_replace_file(&source, content.as_bytes())?;
    }
    let job = ConversationIngest { id: id.clone(), source_path: source_path.clone(), requested_path };
    let receipt = managed_file(project_path, &format!("{INBOX}/{id}.json"), true)?;
    atomic_replace_file(&receipt, &serde_json::to_vec(&job).map_err(|err| err.to_string())?)?;
    Ok(WikiWriteOutput {
        reference: AgentReference {
            title: "对话材料（待入库）".to_string(),
            path: source_path,
            kind: "source".to_string(),
            snippet: Some(content.chars().take(500).collect()),
            score: None,
            knowledge_context: None,
        },
        existed_before,
        previous_content: None,
        ingest_queued: true,
        revision: None,
    })
}

/// 桌面处理器读取持久化凭据，关闭自动资料监控或应用重启也不会丢失对话入库请求。
#[tauri::command]
pub fn list_conversation_ingests(project_path: String) -> Result<Vec<ConversationIngest>, String> {
    let _guard = INBOX_LOCK.lock().map_err(|_| "对话入库锁不可用".to_string())?;
    let inbox = safe_project_join(&project_path, INBOX)?;
    if !inbox.exists() { return Ok(Vec::new()); }
    ensure_project_bound_path(&project_path, &inbox)?;
    let mut jobs = Vec::new();
    for entry in fs::read_dir(inbox).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json").filter(|id| valid_id(id)) else { continue; };
        let receipt = managed_file(&project_path, &format!("{INBOX}/{name}"), false)?;
        let job: ConversationIngest = serde_json::from_slice(&fs::read(receipt).map_err(|err| err.to_string())?)
            .map_err(|err| format!("对话入库凭据损坏：{name}：{err}"))?;
        if job.id != id || job.source_path != format!("{SOURCES}/{id}.md") {
            return Err(format!("对话入库凭据路径无效：{name}"));
        }
        normalize_wiki_write_path(&job.requested_path)?;
        managed_file(&project_path, &job.source_path, false)?;
        jobs.push(job);
    }
    jobs.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(jobs)
}

/// 只有公共队列确认持久化后才删除凭据；交接中断时，下次轮询或重启会重新交接。
#[tauri::command]
pub fn acknowledge_conversation_ingest(project_path: String, id: String) -> Result<(), String> {
    if !valid_id(&id) { return Err("对话入库凭据 ID 无效".to_string()); }
    let _guard = INBOX_LOCK.lock().map_err(|_| "对话入库锁不可用".to_string())?;
    let receipt = managed_file(&project_path, &format!("{INBOX}/{id}.json"), false)?;
    match fs::remove_file(receipt) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 检查现有祖先和最终路径，防止通过来源目录或凭据目录的符号链接越出项目。
fn managed_file(project_path: &str, relative: &str, create_parent: bool) -> Result<PathBuf, String> {
    let path = safe_project_join(project_path, relative)?;
    let parent = path.parent().ok_or_else(|| "入库路径缺少父目录".to_string())?;
    ensure_existing_ancestor_bound(project_path, parent)?;
    if create_parent {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        ensure_project_bound_path(project_path, parent)?;
    }
    if path.symlink_metadata().is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("对话入库拒绝读写符号链接文件".to_string());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_survives_reopen_and_identical_submission_reuses_source() {
        let root = std::env::temp_dir().join(format!("conversation-inbox-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let pp = root.to_str().unwrap();
        let first = submit_conversation_ingest(pp, "wiki/concepts/缓存.md", "# 缓存\n确认的事实").unwrap();
        let second = submit_conversation_ingest(pp, "wiki/concepts/缓存.md", "# 缓存\n确认的事实").unwrap();
        assert_eq!(first.reference.path, second.reference.path);
        let pending = list_conversation_ingests(pp.to_string()).unwrap();
        assert_eq!(pending.len(), 1);
        acknowledge_conversation_ingest(pp.to_string(), pending[0].id.clone()).unwrap();
        assert!(list_conversation_ingests(pp.to_string()).unwrap().is_empty());
        assert!(root.join(first.reference.path).exists(), "交接后继续保留原始材料");
        assert!(acknowledge_conversation_ingest(pp.to_string(), "../secret".to_string()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn conversation_ingest_rejects_source_directory_symlink_escape() {
        let root = std::env::temp_dir().join(format!("conversation-bound-{}", uuid::Uuid::new_v4()));
        let outside = root.with_extension("outside");
        fs::create_dir_all(root.join("raw/sources")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(SOURCES)).unwrap();
        assert!(submit_conversation_ingest(root.to_str().unwrap(), "wiki/concepts/a.md", "# A").is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
