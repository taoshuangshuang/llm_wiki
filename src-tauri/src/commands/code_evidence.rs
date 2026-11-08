//! 冲突源码取证：仅查询项目已经绑定的仓库，固定当前提交与文件版本。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeEvidence {
    pub path: String,
    pub revision: String,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
    pub via: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeEvidenceResult {
    repository: String,
    commit: String,
    branch: String,
    dirty: bool,
    config_revision: String,
    evidence: Vec<CodeEvidence>,
    notes: Vec<String>,
}

#[derive(Clone)]
struct Candidate {
    path: PathBuf,
    line: usize,
    end: usize,
    via: String,
    name: String,
}

fn revision(bytes: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(bytes)) }

fn config_and_repository(project: &str, repository: &str) -> Result<(PathBuf, String), String> {
    let bytes = std::fs::read(Path::new(project).join("code-sources.json")).map_err(|e| e.to_string())?;
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let repository = std::fs::canonicalize(repository).map_err(|e| e.to_string())?;
    let bindings = config["moduleBindings"].as_object().ok_or("源码绑定配置无效")?;
    let authorized = bindings.values().filter_map(|binding| binding["repository"].as_str())
        .filter_map(|path| std::fs::canonicalize(path).ok()).any(|path| path == repository);
    if !authorized { return Err("仓库未包含在当前项目保存的源码绑定中".into()); }
    Ok((repository, revision(&bytes)))
}

fn contained_path(repository: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() || relative.contains(['\\', '\0', ':'])
        || path.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("源码路径无效".into());
    }
    let canonical = std::fs::canonicalize(repository.join(path)).map_err(|e| e.to_string())?;
    if !canonical.starts_with(repository) { return Err("源码路径超出绑定仓库".into()); }
    Ok(canonical)
}

/// 有界读取输出，超时或超量时由 kill_on_drop 终止子进程。
async fn output(command: &mut Command) -> Result<(i32, String), String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(path) = super::cli_resolver::child_path_env().await { command.env("PATH", path); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("无法读取取证命令输出")?;
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(20), stdout.take(2_000_001).read_to_end(&mut bytes))
        .await.map_err(|_| "源码检索超时")?.map_err(|e| e.to_string())?;
    if bytes.len() > 2_000_000 { return Err("源码检索输出超出限制".into()); }
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await.map_err(|_| "源码检索结束超时")?.map_err(|e| e.to_string())?;
    Ok((status.code().unwrap_or(-1), String::from_utf8_lossy(&bytes).into_owned()))
}

async fn git(repository: &Path, args: &[&str]) -> Result<(i32, String), String> {
    let executable = super::cli_resolver::find_cli_command("git", &["git.exe"]).await?;
    output(Command::new(executable).current_dir(repository)
        .args(["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false"]).args(args)).await
}

fn index_root(repository: &Path) -> Option<PathBuf> {
    repository.ancestors().find(|path| path.join(".codegraph/codegraph.db").is_file()).map(Path::to_path_buf)
}

fn source_file(repository: &Path, path: &Path) -> bool {
    !path.strip_prefix(repository).unwrap_or(path).components().filter_map(|part| part.as_os_str().to_str()).any(|part|
        part.starts_with('.') || matches!(part, "target" | "node_modules" | "dist" | "build"))
        && matches!(path.extension().and_then(|part| part.to_str()), Some("java" | "kt" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rs" | "xml" | "sql" | "yaml" | "yml" | "properties"))
}

fn graph_candidates(value: &Value, index: &Path, repository: &Path, via: &str) -> Vec<Candidate> {
    let nodes: Vec<&Value> = if let Some(items) = value.as_array() {
        items.iter().map(|item| &item["node"]).collect()
    } else {
        value["definitions"].as_array().into_iter().flatten()
            .flat_map(|definition| definition[via].as_array().into_iter().flatten()).collect()
    };
    nodes.into_iter().filter_map(|node| {
        let relative = node["filePath"].as_str()?;
        let file = std::fs::canonicalize(index.join(relative)).ok()?;
        if !file.starts_with(repository) || !file.is_file() || !source_file(repository, &file) { return None; }
        let kind = node["kind"].as_str().unwrap_or("");
        if !matches!(kind, "class" | "interface" | "method" | "function" | "file") { return None; }
        let line = node["startLine"].as_u64().unwrap_or(1) as usize;
        Some(Candidate { path: file, line, end: node["endLine"].as_u64().unwrap_or((line + 70) as u64) as usize,
            via: via.into(), name: node["name"].as_str().unwrap_or("").into() })
    }).collect()
}

async fn graph_json(executable: &Path, index: &Path, verb: &str, query: &str, file: Option<&str>) -> Result<Value, String> {
    let mut command = Command::new(executable);
    command.current_dir(index).arg(verb).arg(query).args(["--path"]).arg(index).args(["--json", "--limit", "24"]);
    if let Some(file) = file { command.args(["--file", file]); }
    let (success, text) = output(&mut command).await?;
    if success != 0 { return Err("CodeGraph 查询失败".into()); }
    serde_json::from_str(&text).map_err(|_| "CodeGraph 返回了无法解析的结果".into())
}

fn snippets(candidates: Vec<Candidate>, repository: &Path) -> (Vec<CodeEvidence>, Vec<String>) {
    let mut evidence = Vec::new();
    let mut notes = Vec::new();
    let mut consumed = BTreeSet::new();
    let mut chars = 0;
    for candidate in candidates {
        if evidence.len() >= 12 || chars >= 60_000 { notes.push("已达到本次源码证据预算".into()); break; }
        if std::fs::metadata(&candidate.path).map(|meta| meta.len() > 1_000_000).unwrap_or(true) {
            notes.push("部分候选文件不可读或超过 1 MB".into()); continue;
        }
        let Ok(bytes) = std::fs::read(&candidate.path) else { notes.push("部分候选文件不可读".into()); continue };
        let Ok(text) = std::str::from_utf8(&bytes) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        let start = candidate.line.saturating_sub(9);
        let end = candidate.end.max(candidate.line + 35).min(start + 180).min(lines.len());
        if start >= end { notes.push("索引行号与当前文件不一致".into()); continue; }
        if candidate.end > end { notes.push("较长符号仅提供部分行，结论需以展示片段为限".into()); }
        let slice = lines[start..end].join("\n");
        if !candidate.name.is_empty() && !slice.contains(&candidate.name) {
            notes.push("部分索引位置未在当前文件核实，已跳过".into()); continue;
        }
        let size = slice.chars().count();
        if size > 20_000 || chars + size > 60_000 { notes.push("部分源码片段超出字符预算".into()); continue; }
        let relative = candidate.path.strip_prefix(repository).unwrap().to_string_lossy().replace('\\', "/");
        if !consumed.insert((relative.clone(), start, end)) { continue; }
        chars += size;
        evidence.push(CodeEvidence { path: relative, revision: revision(&bytes), start_line: start + 1, end_line: end, text: slice, via: candidate.via });
    }
    notes.sort(); notes.dedup();
    (evidence, notes)
}

/// 取证只运行结构化参数的 CodeGraph/Git 读命令，不执行模型给出的命令。
#[tauri::command]
pub async fn collect_code_evidence(project_path: String, repository: String, queries: Vec<String>, paths: Vec<String>) -> Result<CodeEvidenceResult, String> {
    tokio::time::timeout(Duration::from_secs(60), collect_inner(project_path, repository, queries, paths))
        .await.map_err(|_| "本次仓库源码取证超过 60 秒".to_string())?
}

async fn collect_inner(project_path: String, repository: String, queries: Vec<String>, paths: Vec<String>) -> Result<CodeEvidenceResult, String> {
    let (repository, config_revision) = config_and_repository(&project_path, &repository)?;
    if queries.is_empty() || queries.len() > 6 || queries.iter().any(|query| query.len() > 120
        || query.is_empty() || !(query.chars().next().unwrap().is_alphanumeric() || query.starts_with(['_', '$']))
        || query.chars().any(|c| !c.is_alphanumeric() && !matches!(c, '_' | '.' | '$'))) {
        return Err("源码检索词需为有界的类名、方法名或代码标识符".into());
    }
    let preferred = paths.iter().map(|path| contained_path(&repository, path)).collect::<Result<Vec<_>, _>>()?;
    let (success, head) = git(&repository, &["rev-parse", "HEAD"]).await?;
    if success != 0 { return Err("无法读取仓库提交".into()); }
    let (_, branch) = git(&repository, &["symbolic-ref", "--short", "HEAD"]).await?;
    let mut candidates = Vec::new();
    let mut notes = Vec::new();
    if let Some(index) = index_root(&repository) {
        match super::cli_resolver::find_cli_command("codegraph", &["codegraph.cmd", "codegraph.exe"]).await {
            Ok(executable) => {
                for query in &queries {
                    match graph_json(&executable, &index, "query", query, None).await {
                        Ok(value) => candidates.extend(graph_candidates(&value, &index, &repository, "codegraph")),
                        Err(error) => notes.push(error),
                    }
                }
                candidates.sort_by_key(|item| (
                    !preferred.is_empty() && !preferred.iter().any(|path| item.path.starts_with(path)),
                    !queries.iter().any(|query| query == &item.name),
                ));
                let mut seeds = BTreeSet::new();
                for definition in candidates.clone().into_iter().filter(|item| seeds.insert((item.path.clone(), item.name.clone()))).take(3) {
                    let file = definition.path.strip_prefix(&index).unwrap().to_string_lossy().replace('\\', "/");
                    for direction in ["callers", "callees"] {
                        match graph_json(&executable, &index, direction, &definition.name, Some(&file)).await {
                            Ok(value) => candidates.extend(graph_candidates(&value, &index, &repository, direction)),
                            Err(error) => notes.push(error),
                        }
                    }
                }
            }
            Err(_) => notes.push("CodeGraph 命令不可用，使用 Git 文本检索补查".into()),
        }
    } else { notes.push("仓库及父目录没有 CodeGraph 索引，使用 Git 文本检索".into()); }
    // 文本补查同时覆盖当前未提交内容；少量命中补充索引缺失或过期的情况。
    let mut args = vec!["grep", "--untracked", "-n", "-I", "-m", "2", "-F"];
    for query in &queries { args.extend(["-e", query.as_str()]); }
    args.push("--");
    let (grep_status, matches) = git(&repository, &args).await?;
    if grep_status != 0 && grep_status != 1 { notes.push("Git 文本补查失败".into()); }
    let mut fallback = Vec::new();
    for line in matches.lines() {
        let mut parts = line.splitn(3, ':');
        let (Some(path), Some(line)) = (parts.next(), parts.next().and_then(|part| part.parse::<usize>().ok())) else { continue };
        if let Ok(path) = contained_path(&repository, path).and_then(|path| if source_file(&repository, &path) { Ok(path) } else { Err("非源码文件".into()) }) {
            fallback.push(Candidate { path, line, end: line + 35, via: "git-grep".into(), name: String::new() });
        }
    }
    fallback.sort_by_key(|item| (!preferred.is_empty() && !preferred.iter().any(|path| item.path.starts_with(path))) as u8);
    candidates.extend(fallback);
    candidates.sort_by_key(|item| !preferred.is_empty() && !preferred.iter().any(|path| item.path.starts_with(path)));
    let (evidence, snippet_notes) = snippets(candidates, &repository);
    notes.extend(snippet_notes);
    let (success, after_head) = git(&repository, &["rev-parse", "HEAD"]).await?;
    if success != 0 || head != after_head { return Err("取证期间仓库提交已变化".into()); }
    let (success, after_status) = git(&repository, &["status", "--porcelain=v1", "--untracked-files=normal"]).await?;
    if success != 0 { return Err("取证后工作区状态无法核实".into()); }
    if !after_status.trim().is_empty() { notes.push("包含本机未提交内容，文件哈希固定本次实际实现".into()); }
    if config_and_repository(&project_path, repository.to_str().ok_or("仓库路径无效")?)?.1 != config_revision {
        return Err("取证期间源码绑定已变化".into());
    }
    notes.sort(); notes.dedup();
    Ok(CodeEvidenceResult { repository: repository.to_string_lossy().into_owned(), commit: head.trim().into(),
        branch: branch.trim().into(), dirty: !after_status.trim().is_empty(), config_revision, evidence, notes })
}

/// 模型核验完成后再次核对提交和实际消费的文件版本。
#[tauri::command]
pub async fn verify_code_evidence(project_path: String, repository: String, commit: String, config_revision: String, evidence: Vec<CodeEvidence>) -> Result<bool, String> {
    let (repository, current_config) = config_and_repository(&project_path, &repository)?;
    if config_revision != current_config || evidence.len() > 12 { return Ok(false); }
    let (success, head) = git(&repository, &["rev-parse", "HEAD"]).await?;
    if success != 0 || head.trim() != commit { return Ok(false); }
    for item in evidence {
        let path = contained_path(&repository, &item.path)?;
        if std::fs::metadata(&path).map(|meta| meta.len() > 1_000_000).unwrap_or(true) { return Ok(false); }
        if revision(&std::fs::read(path).map_err(|e| e.to_string())?) != item.revision { return Ok(false); }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("code-evidence-{}", uuid::Uuid::new_v4()));
        let repository = root.join("repo");
        std::fs::create_dir_all(repository.join("src")).unwrap();
        std::fs::write(repository.join("src/Engine.java"), "class Engine {\n  boolean enabled() { return true; }\n}\n").unwrap();
        std::fs::write(root.join("code-sources.json"), json!({"version":1,"moduleBindings":{"query":{"repository":repository}}}).to_string()).unwrap();
        (root, repository)
    }

    #[tokio::test]
    async fn collection_reads_bound_repo_and_detects_changed_source() {
        let (root, repo) = fixture();
        assert_eq!(git(&repo, &["init", "-q"]).await.unwrap().0, 0);
        assert_eq!(git(&repo, &["add", "."]).await.unwrap().0, 0);
        assert_eq!(git(&repo, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]).await.unwrap().0, 0);
        let result = collect_code_evidence(root.to_string_lossy().into_owned(), repo.to_string_lossy().into_owned(),
            vec!["Engine".into()], vec!["src".into()]).await.unwrap();
        assert!(!result.evidence.is_empty());
        assert_eq!(result.evidence[0].path, "src/Engine.java");
        assert!(result.evidence[0].text.contains("return true"));
        assert!(verify_code_evidence(root.to_string_lossy().into_owned(), repo.to_string_lossy().into_owned(),
            result.commit.clone(), result.config_revision.clone(), result.evidence.clone()).await.unwrap());
        std::fs::write(repo.join("src/Engine.java"), "class Engine {}").unwrap();
        assert!(!verify_code_evidence(root.to_string_lossy().into_owned(), repo.to_string_lossy().into_owned(),
            result.commit, result.config_revision, result.evidence).await.unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn long_symbols_keep_real_line_bounds_and_report_partial_evidence() {
        let (root, repo) = fixture();
        let file = repo.join("src/Engine.java");
        std::fs::write(&file, format!("class Engine {{\n{}\n}}", "  // 更多实现\n".repeat(250))).unwrap();
        let (evidence, notes) = snippets(vec![Candidate { path: file, line: 1, end: 253,
            via: "codegraph".into(), name: "Engine".into() }], &repo);
        assert_eq!(evidence.len(), 1);
        assert_eq!((evidence[0].start_line, evidence[0].end_line), (1, 180));
        assert_eq!(evidence[0].text.lines().count(), 180);
        assert!(notes.iter().any(|note| note.contains("部分行")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn graph_candidates_exclude_other_repos_and_hidden_source_files() {
        let (root, repo) = fixture();
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("Secret.java"), "class Secret {}").unwrap();
        std::fs::create_dir_all(repo.join(".hidden")).unwrap();
        std::fs::write(repo.join(".hidden/Secret.java"), "class Secret {}").unwrap();
        let result = graph_candidates(&json!([
            {"node":{"filePath":"repo/src/Engine.java","name":"Engine","kind":"class","startLine":1}},
            {"node":{"filePath":"other/Secret.java","name":"Secret","kind":"class","startLine":1}},
            {"node":{"filePath":"repo/.hidden/Secret.java","name":"Secret","kind":"class","startLine":1}}
        ]), &root, &std::fs::canonicalize(&repo).unwrap(), "codegraph");
        assert_eq!(result.len(), 1);
        assert!(contained_path(&repo, "../other/Secret.java").is_err());
        assert!(config_and_repository(root.to_str().unwrap(), other.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore = "显式设置本机仓库环境变量后执行只读 CodeGraph 验证"]
    async fn local_codegraph_smoke() {
        let project = std::env::var("LLM_WIKI_SOURCE_SMOKE_PROJECT").unwrap();
        let repository = std::env::var("LLM_WIKI_SOURCE_SMOKE_REPOSITORY").unwrap();
        let symbol = std::env::var("LLM_WIKI_SOURCE_SMOKE_SYMBOL").unwrap();
        let result = collect_code_evidence(project.clone(), repository.clone(), vec![symbol], vec![]).await.unwrap();
        assert!(result.evidence.iter().any(|evidence| evidence.via == "codegraph"));
        assert!(verify_code_evidence(project, repository, result.commit.clone(), result.config_revision, result.evidence.clone()).await.unwrap());
        println!("CodeGraph 实仓取证通过，{} 个片段，commit {}", result.evidence.len(), result.commit);
    }
}
