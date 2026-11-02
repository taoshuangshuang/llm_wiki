//! 来源文件的追加式过程日志；独立于页面提交和业务状态，不参与导入决策。
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static LOG_LOCK: Mutex<()> = Mutex::new(());

/// 来源身份只用于计算文件名，禁止模型或来源路径控制日志写入位置。
fn log_path(project_path: &str, source_identity: &str) -> Result<PathBuf, String> {
    if !Path::new(project_path).is_absolute() || source_identity.trim().is_empty() {
        return Err("日志项目路径或来源身份无效".into());
    }
    let root = fs::canonicalize(project_path).map_err(|error| error.to_string())?;
    let metadata_directory = root.join(".llm-wiki");
    fs::create_dir_all(&metadata_directory).map_err(|error| error.to_string())?;
    if !fs::canonicalize(&metadata_directory).map_err(|error| error.to_string())?.starts_with(&root) {
        return Err("日志目录超出项目范围".into());
    }
    let directory = metadata_directory.join("ingest-logs");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    if !fs::canonicalize(&directory).map_err(|error| error.to_string())?.starts_with(&root) {
        return Err("日志目录超出项目范围".into());
    }
    let path = directory.join(format!("{:x}.jsonl", Sha256::digest(source_identity.as_bytes())));
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() { return Err("日志目标不是普通文件".into()); }
    }
    Ok(path)
}

/// 序列化整条记录后一次追加；并发来源、重试和后台审阅不会交叉写坏 JSON 行。
#[tauri::command]
pub async fn append_ingest_log(project_path: String, source_identity: String, entry: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOG_LOCK.lock().map_err(|_| "日志锁不可用")?;
        let path = log_path(&project_path, &source_identity)?;
        let mut bytes = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let mut file = OpenOptions::new().create(true).read(true).append(true).open(path).map_err(|error| error.to_string())?;
        // 异常退出可能留下尾部半行；保留现场并补换行，避免损坏下一条正常记录。
        if file.metadata().map_err(|error| error.to_string())?.len() > 0 {
            file.seek(SeekFrom::End(-1)).map_err(|error| error.to_string())?;
            let mut last = [0];
            file.read_exact(&mut last).map_err(|error| error.to_string())?;
            if last[0] != b'\n' { bytes.insert(0, b'\n'); }
        }
        file.write_all(&bytes).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

/// 与追加共用短锁，导出获得完整行组成的当前快照，尚未发生的事件不会被补造。
#[tauri::command]
pub async fn read_ingest_log(project_path: String, source_identity: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOG_LOCK.lock().map_err(|_| "日志锁不可用")?;
        let path = log_path(&project_path, &source_identity)?;
        match fs::read_to_string(path) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(error.to_string()),
        }
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实际文件追加验证并发不丢记录，同名但不同目录的来源互不混淆。
    #[tokio::test]
    async fn process_log_appends_complete_records_and_isolates_sources() {
        let root = std::env::temp_dir().join(format!("ingest-log-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let project = root.to_string_lossy().into_owned();
        let (first, second) = tokio::join!(
            append_ingest_log(project.clone(), "a/faq.md".into(), serde_json::json!({"event":"input","text":"第一行\n第二行"})),
            append_ingest_log(project.clone(), "a/faq.md".into(), serde_json::json!({"event":"failed"})),
        );
        first.unwrap(); second.unwrap();
        let raw = read_ingest_log(project.clone(), "a/faq.md".into()).await.unwrap();
        let entries: Vec<Value> = raw.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry["text"] == "第一行\n第二行"));
        assert!(read_ingest_log(project.clone(), "b/faq.md".into()).await.unwrap().is_empty());
        fs::write(log_path(&project, "partial.md").unwrap(), b"{\"unfinished\":").unwrap();
        append_ingest_log(project.clone(), "partial.md".into(), serde_json::json!({"event":"restarted"})).await.unwrap();
        let recovered = read_ingest_log(project.clone(), "partial.md".into()).await.unwrap();
        assert_eq!(recovered.lines().count(), 2);
        assert_eq!(serde_json::from_str::<Value>(recovered.lines().nth(1).unwrap()).unwrap()["event"], "restarted");
        assert!(append_ingest_log("relative".into(), "faq.md".into(), Value::Null).await.is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
