//! 独立监听 Wiki 正文写入，不受来源监听开关或应用写入忽略规则影响。
use std::{collections::{BTreeSet, HashMap}, path::PathBuf, sync::{mpsc, Mutex, OnceLock}, time::Duration};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

static WATCHERS: OnceLock<Mutex<HashMap<String, RecommendedWatcher>>> = OnceLock::new();

/// 先监听再核对索引，覆盖导入、编辑、HTTP/MCP、外部修改和目录重命名。
#[tauri::command]
pub fn start_wiki_index_watcher(app: AppHandle, project_path: String) -> Result<String, String> {
    let root = std::fs::canonicalize(&project_path).map_err(|error| error.to_string())?;
    let wiki = root.join("wiki");
    let media = wiki.join("media");
    let (changes, pending) = mpsc::channel::<Option<Vec<PathBuf>>>();
    let index_project = root.to_string_lossy().into_owned();
    // 同一监听串行维护索引，合并原子写入、批量导入产生的文件事件，避免每次事件全库重算。
    std::thread::spawn(move || {
        while let Ok(change) = pending.recv() {
            let mut reconcile = change.is_none();
            let mut paths: BTreeSet<PathBuf> = change.into_iter().flatten().collect();
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(1) {
                match pending.recv_timeout(Duration::from_millis(100)) {
                    Ok(change) => { reconcile |= change.is_none(); paths.extend(change.into_iter().flatten()); }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if let Err(error) = super::search::evidence::refresh_relation_index(&index_project, if reconcile { None } else { Some(&paths) }) {
                eprintln!("[wiki-index] 关系索引更新失败，后续检索将核对实际版本：{error}");
            }
        }
    });
    let initial = changes.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        match result {
            Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
                if event.paths.iter().any(|path| path.starts_with(&wiki) && !path.starts_with(&media)) {
                    let _ = changes.send(Some(event.paths));
                    let _ = app.emit("embedding://wiki-changed", &project_path);
                }
            }
            // 丢失事件时也触发核对；定时核对负责系统休眠等未上报情况。
            Err(_) => { let _ = changes.send(None); let _ = app.emit("embedding://wiki-changed", &project_path); }
            _ => {}
        }
    }).map_err(|error| format!("Failed to create wiki index watcher: {error}"))?;
    watcher.watch(&root, RecursiveMode::Recursive)
        .map_err(|error| format!("Failed to watch wiki index: {error}"))?;
    // 先完成监听注册再初始化，初始化期间的写入会在下一批增量更新中补齐。
    let _ = initial.send(None);
    let id = uuid::Uuid::new_v4().to_string();
    WATCHERS.get_or_init(Default::default).lock().map_err(|_| "Wiki watcher lock poisoned")?
        .insert(id.clone(), watcher);
    Ok(id)
}

/// 按注册标识释放监听，旧项目的异步清理不会停止新项目监听。
#[tauri::command]
pub fn stop_wiki_index_watcher(watcher_id: String) -> Result<(), String> {
    WATCHERS.get_or_init(Default::default).lock().map_err(|_| "Wiki watcher lock poisoned")?
        .remove(&watcher_id);
    Ok(())
}
