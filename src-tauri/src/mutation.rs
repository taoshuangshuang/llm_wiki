//! 应用内短写入协调；版本核对与替换共用此锁，模型和网络等待不持锁。
use std::{fs::{self, OpenOptions}, io::Write, path::Path, sync::{Mutex, MutexGuard}};

static MUTATION_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock() -> Result<MutexGuard<'static, ()>, String> {
    MUTATION_LOCK.lock().map_err(|_| "文件提交锁不可用".to_string())
}

/// 同目录临时文件写入并同步后替换；失败不截断现有文件。
pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("文件缺少父目录")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".llm-wiki-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(contents).map_err(|error| error.to_string())?;
        if let Ok(metadata) = fs::metadata(path) { file.set_permissions(metadata.permissions()).map_err(|error| error.to_string())?; }
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        fs::File::open(parent).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}
