//! 有界、多目标证据召回核心；通道开关、版本核实和预算由所有调用方共用。
use super::*;
use aho_corasick::AhoCorasick;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use std::sync::{OnceLock, Mutex};
use tauri::Manager;
mod relation_index;
mod title_recall;
#[cfg(test)]
use relation_index::relations;

static GLOBAL_CONFIG_DIRECTORY: OnceLock<std::path::PathBuf> = OnceLock::new();

pub fn set_config_directory(path: std::path::PathBuf) { let _ = GLOBAL_CONFIG_DIRECTORY.set(path); }

fn read_config(path: &Path) -> Result<BTreeMap<String, bool>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| format!("检索配置无效：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn global_channels() -> Result<BTreeMap<String, bool>, String> {
    let mut channels = BTreeMap::from([("title".into(), true), ("vector".into(), true), ("keyword".into(), true), ("indexPage".into(), true), ("graph".into(), false)]);
    if let Some(directory) = GLOBAL_CONFIG_DIRECTORY.get() { channels.extend(read_config(&directory.join("retrieval-defaults.json"))?); }
    Ok(channels)
}

#[tauri::command]
pub fn retrieval_config(project_path: Option<String>) -> Result<Value, String> {
    let defaults = global_channels()?;
    let overrides = project_path.map(|path| read_config(&Path::new(&path).join(".llm-wiki/retrieval.json"))).transpose()?.unwrap_or_default();
    let mut effective = defaults.clone(); effective.extend(overrides.clone());
    Ok(json!({"defaults":defaults,"overrides":overrides,"effective":effective}))
}

#[tauri::command]
pub fn save_retrieval_config(app: tauri::AppHandle, project_path: Option<String>, channels: BTreeMap<String, bool>) -> Result<(), String> {
    if channels.keys().any(|key| !["title", "vector", "keyword", "indexPage", "graph"].contains(&key.as_str())) { return Err("未知检索通道".into()); }
    let _mutation = crate::mutation::lock()?;
    let path = match project_path {
        Some(path) => Path::new(&path).join(".llm-wiki/retrieval.json"),
        None => app.path().app_data_dir().map_err(|error| error.to_string())?.join("retrieval-defaults.json"),
    };
    crate::mutation::atomic_write(&path, &serde_json::to_vec_pretty(&channels).map_err(|error| error.to_string())?)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    #[serde(default)] pub corpus: String,
    pub include_paths: Option<Vec<String>>,
    pub exclude_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub context_char_limit: Option<usize>,
    pub candidate_limit: Option<usize>,
    pub query_limit: Option<usize>,
    pub time_limit_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Target {
    pub id: String,
    pub text: String,
    pub title: Option<String>,
    /// 审阅主页面已单独提供全文；只从本目标的召回范围排除自身，保留其他本轮页面。
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub project_path: String,
    pub scene: String,
    pub targets: Vec<Target>,
    pub scope: Option<Scope>,
    pub channels: Option<BTreeMap<String, bool>>,
    pub budget: Option<Budget>,
    /// 只复用当前语料、通道配置和查询完全一致的成功通道候选，随后重新 RRF。
    pub checkpoint: Option<Value>,
}

#[derive(Clone)]
struct Page { path: String, title: String, text: String, revision: String }

struct CachedPage { modified: std::time::SystemTime, size: u64, page: Page }
static PAGE_CACHE: OnceLock<Mutex<BTreeMap<std::path::PathBuf, CachedPage>>> = OnceLock::new();

#[derive(Clone)]
struct Candidate { path: String, rank: usize, channel: String, quote: Option<String> }

fn revision(text: &str) -> String { format!("sha256:{:x}", Sha256::digest(text.as_bytes())) }

/// 显式页面读取也标记实际消费的版本；它不是召回，不受召回通道开关限制。
pub(crate) fn page_snapshot(path: &str, text: &str) -> Value {
    json!({"path":path,"revision":revision(text),"range":{"startLine":1,"endLine":text.lines().count().max(1)},"text":text})
}

/// 显式读取页的引用元数据复用同一解析器；未读目标只返回关系，不附会目标事实。
pub(crate) fn page_relations(project_path: &str, path: &str) -> Result<Vec<Value>, String> {
    relation_index::for_page(project_path, path)
}

/// 文件监听独立维护关系索引，不依赖向量能力；检索仍核对实际读取版本以覆盖事件延迟。
pub(crate) fn refresh_relation_index(project_path: &str, paths: Option<&BTreeSet<std::path::PathBuf>>) -> Result<(), String> {
    relation_index::refresh(project_path, paths)
}

/// 查询入库变更涉及的全库引用方，包含指向尚未创建名称的依赖。
#[tauri::command]
pub fn wiki_reference_context(project_path: String, paths: Vec<String>, targets: Vec<String>) -> Result<Value, String> {
    relation_index::maintenance_context(&project_path, paths, targets)
}

fn safe_relative(path: &str, corpus: &str) -> bool {
    let prefix = if corpus == "sources" { "raw/sources/" } else { "wiki/" };
    path.starts_with(prefix) && !path.contains('\\') && path.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains(':') && !part.chars().any(char::is_control))
}

/// 项目文件只覆盖声明过的通道；调用方只能继续缩小集合。
fn enabled_channels(request: &Request, config: Option<&SearchEmbeddingConfig>) -> Result<BTreeMap<String, bool>, String> {
    let path = Path::new(&request.project_path).join(".llm-wiki/retrieval.json");
    let overrides = read_config(&path)?;
    Ok(global_channels()?.into_iter().map(|(channel, default)| {
        let allowed = overrides.get(&channel).copied().unwrap_or(default)
            && request.channels.as_ref().and_then(|channels| channels.get(&channel)).copied().unwrap_or(true);
        // 用户禁用 embedding 的既有语义优先，检索不得偷偷打开。
        let allowed = allowed && (channel != "vector" || config.is_some_and(|config| config.enabled));
        (channel, allowed)
    }).collect())
}

fn read_pages(request: &Request, corpus: &str, warnings: &mut Vec<String>, deadline: Instant) -> Result<BTreeMap<String, Page>, String> {
    let root = fs::canonicalize(&request.project_path).map_err(|error| error.to_string())?;
    let folder = root.join(if corpus == "sources" { "raw/sources" } else { "wiki" });
    let mut pages = BTreeMap::new();
    let mut read_chars = 0usize;
    for entry in WalkDir::new(folder).into_iter().filter_map(Result::ok) {
        if Instant::now() >= deadline { warnings.push("文件清单读取超时".into()); break; }
        if !entry.file_type().is_file() || entry.file_type().is_symlink() { continue; }
        if corpus != "sources" && !entry.path().extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")) { continue; }
        if pages.len() >= MAX_SEARCH_FILES { warnings.push("文件清单达到数量上限".into()); break; }
        if !fs::canonicalize(entry.path()).map_err(|error| error.to_string())?.starts_with(&root) { continue; }
        let path = relative_to_project(root.to_str().ok_or("项目路径无效")?, entry.path());
        if !safe_relative(&path, corpus) || path.split('/').any(|part| part.starts_with('.')) { continue; }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if corpus != "sources" && metadata.len() > 8_000_000 { warnings.push(format!("候选文件超过单页读取预算：{path}")); continue; }
        let modified = metadata.modified().map_err(|error| error.to_string())?;
        let cache = PAGE_CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
        let cached = cache.lock().map_err(|_| "检索派生缓存不可用")?.get(entry.path())
            .filter(|_| corpus != "sources")
            .filter(|cached| cached.modified == modified && cached.size == metadata.len()).map(|cached| cached.page.clone());
        if let Some(page) = cached {
            read_chars += page.text.chars().count();
            if read_chars > 16_000_000 { warnings.push("正文读取达到累计预算".into()); break; }
            pages.insert(path, page); continue;
        }
        let text = match read_evidence_text(entry.path(), corpus) { Ok(Some(text)) => text, Ok(None) => continue, Err(error) => { warnings.push(format!("未读取 {path}：{error}")); continue; } };
        read_chars += text.chars().count();
        if read_chars > 16_000_000 { warnings.push("正文读取达到累计预算".into()); break; }
        let title = extract_title(&text, entry.file_name().to_str().unwrap_or_default());
        let page = Page { path: path.clone(), title, revision: revision(&text), text };
        if metadata.len() <= 2_000_000 {
            let mut cache = cache.lock().map_err(|_| "检索派生缓存不可用")?;
            if cache.len() >= MAX_SEARCH_FILES || cache.values().map(|entry| entry.size).sum::<u64>() + metadata.len() > 64_000_000 { cache.clear(); }
            cache.insert(entry.path().to_path_buf(), CachedPage { modified, size: metadata.len(), page: page.clone() });
        }
        pages.insert(path, page);
    }
    Ok(pages)
}

/// 搜索只读已有、未过期的文档提取结果，不触发解析或将二进制原文件当正文。
fn read_evidence_text(path: &Path, corpus: &str) -> Result<Option<String>, String> {
    if corpus != "sources" { return fs::read_to_string(path).map(Some).map_err(|error| error.to_string()); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if ["md", "markdown", "org", "txt", "json", "csv", "tsv", "yaml", "yml", "xml", "html"].contains(&extension.as_str()) {
        return fs::read_to_string(path).map(Some).map_err(|error| error.to_string());
    }
    if ["pdf", "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm", "xls", "xlsx", "xlsm", "xlsb", "odt", "ods", "odp", "rtf", "epub", "mobi"].contains(&extension.as_str()) {
        return crate::commands::fs::read_preprocessed_cache(path).map(Some).ok_or_else(|| "没有可用的最新提取正文".into());
    }
    Ok(None)
}

/// 单遍计算各词是否出现，保留旧搜索的短语、标题和正文权重；候选阶段不构造不用的摘要或图片。
fn lexical_candidates(_request: &Request, pages: &BTreeMap<String, Page>, query: &str, scope: &Scope, deadline: Instant) -> Vec<Candidate> {
    let tokens = tokenize_query(query);
    let phrase = trim_query_punctuation(&query.to_lowercase());
    let matcher = AhoCorasick::new(&tokens).ok();
    let token_score = |lower: &str| -> usize {
        let Some(matcher) = matcher.as_ref() else { return tokens.iter().filter(|token| lower.contains(token.as_str())).count(); };
        let mut found = vec![false; tokens.len()];
        let mut count = 0;
        for hit in matcher.find_overlapping_iter(lower) {
            let index = hit.pattern().as_usize();
            if !found[index] { found[index] = true; count += 1; }
            if count == tokens.len() { break; }
        }
        count
    };
    let mut scored = pages.values().take_while(|_| Instant::now() < deadline).filter(|page| in_scope(&page.path, scope)).filter_map(|page| {
        let name = Path::new(&page.path).file_name().and_then(|name| name.to_str()).unwrap_or_default();
        let title = format!("{} {name}", page.title).to_lowercase();
        let body = page.text.to_lowercase();
        let filename_exact = !phrase.is_empty() && name.trim_end_matches(".md").to_lowercase() == phrase;
        let title_phrase = !phrase.is_empty() && title.contains(&phrase);
        let score = if filename_exact { FILENAME_EXACT_BONUS } else { 0.0 }
            + if title_phrase { PHRASE_IN_TITLE_BONUS } else { 0.0 }
            + count_occurrences(&body, &phrase).min(MAX_PHRASE_OCC_COUNTED) as f64 * PHRASE_IN_CONTENT_PER_OCC
            + token_score(&title) as f64 * TITLE_TOKEN_WEIGHT + token_score(&body) as f64 * CONTENT_TOKEN_WEIGHT;
        (score > 0.0).then(|| (page.path.clone(), score))
    }).collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scored.into_iter().take(8).enumerate().map(|(index, (path, _))| Candidate { path, rank: index + 1, channel: "keyword".into(), quote: None }).collect()
}

/// 各通道共用的正文候选范围；索引页保留在页面集合中用于导航，但不参与正文召回。
fn in_scope(path: &str, scope: &Scope) -> bool {
    path != "wiki/index.md" &&
        scope.include_paths.as_ref().is_none_or(|paths| paths.iter().any(|candidate| candidate == path)) &&
        scope.exclude_paths.as_ref().is_none_or(|paths| !paths.iter().any(|candidate| candidate == path))
}

fn indexed_candidates(pages: &BTreeMap<String, Page>, query: &str, scope: &Scope, edges: &[Value]) -> Vec<Candidate> {
    let tokens = tokenize_query(query);
    let mut candidates = edges.iter().filter(|edge| edge["fromPath"] == "wiki/index.md").filter_map(|edge| {
        let target = edge["toPath"].as_str()?;
        if !in_scope(target, scope) { return None; }
        let line = edge["nearbyText"].as_str().unwrap_or_default();
        let score = token_match_score(line, &tokens);
        (score > 0 && pages.contains_key(target)).then(|| (target.to_string(), score))
    }).collect::<Vec<_>>();
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let mut seen = BTreeSet::new();
    candidates.into_iter().filter(|(path, _)| seen.insert(path.clone())).take(8).enumerate()
        .map(|(index, (path, _))| Candidate { path, rank: index + 1, channel: "indexPage".into(), quote: None }).collect()
}

/// 按相关段落展开并返回真实行号，旧向量片段无法在当前正文定位时不伪造版本。
fn evidence_ranges(page: &Page, query: &str, quotes: &[String], remaining: usize, segments: &mut Vec<Value>) -> Vec<(usize, usize, String)> {
    let lines: Vec<&str> = page.text.lines().collect();
    let mut matches = Vec::new();
    for quote in quotes {
        if let Some(offset) = page.text.find(quote) {
            let start = page.text[..offset].bytes().filter(|byte| *byte == b'\n').count();
            matches.push((start, start + quote.lines().count().max(1)));
        }
    }
    if matches.is_empty() {
        let tokens = tokenize_query(query);
        if let Some((line, _)) = lines.iter().enumerate().map(|(line, text)| (line, token_match_score(text, &tokens))).filter(|(_, score)| *score > 0).max_by(|a, b| a.1.cmp(&b.1)) {
            let start = (0..=line).rev().find(|index| lines[*index].starts_with('#') || lines[*index].is_empty()).unwrap_or(0);
            let end = (line + 1..lines.len()).find(|index| lines[*index].starts_with('#')).unwrap_or(lines.len());
            matches.push((start, end));
        } else if page.text.chars().count() <= remaining { matches.push((0, lines.len())); }
    }
    matches.sort();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (start, end) in matches {
        if let Some(last) = ranges.last_mut().filter(|last| start <= last.1) { last.1 = last.1.max(end); }
        else { ranges.push((start, end)); }
    }
    ranges.into_iter().filter_map(|(start, end)| {
        let end = end.min(lines.len());
        let text = lines.get(start..end)?.join("\n");
        segments.push(json!({"startLine":start+1,"endLine":end,"chars":text.chars().count(),"remainingChars":remaining,
            "accepted":!text.trim().is_empty() && text.chars().count() <= remaining}));
        (!text.trim().is_empty() && text.chars().count() <= remaining).then_some((start + 1, end, text))
    }).take(5).collect()
}

#[tauri::command]
pub async fn retrieve_evidence(request: Request, embedding_config: Option<SearchEmbeddingConfig>, record_trace: Option<bool>) -> Result<Value, String> {
    retrieve_with_trace(request, embedding_config, None, record_trace.unwrap_or(false)).await
}

/// explicit_embedding 只供兼容旧搜索入口使用，仍遵守向量通道禁用设置。
pub async fn retrieve(request: Request, embedding_config: Option<SearchEmbeddingConfig>, explicit_embedding: Option<Vec<f32>>) -> Result<Value, String> {
    retrieve_with_trace(request, embedding_config, explicit_embedding, false).await
}

/// 详细过程只供日志采集使用，普通搜索与问答不生成额外上下文。
async fn retrieve_with_trace(request: Request, embedding_config: Option<SearchEmbeddingConfig>, explicit_embedding: Option<Vec<f32>>, record_trace: bool) -> Result<Value, String> {
    if !["ingest", "review", "qa", "search"].contains(&request.scene.as_str()) || request.targets.is_empty() || request.targets.len() > 64 { return Err("检索场景或目标数量无效".into()); }
    let mut target_ids = BTreeSet::new();
    if request.targets.iter().any(|target| target.id.trim().is_empty() || !target_ids.insert(target.id.clone()) || target.text.chars().count() > 16_000 || target.title.as_ref().is_some_and(|title| title.chars().count() > 16_000)) { return Err("检索目标身份重复、为空或查询超过预算".into()); }
    let enabled = enabled_channels(&request, embedding_config.as_ref())?;
    let scope = request.scope.clone().unwrap_or_default();
    let corpus = if scope.corpus.is_empty() { "wiki" } else { &scope.corpus };
    if !["wiki", "sources"].contains(&corpus) { return Err("检索语料范围无效".into()); }
    for path in scope.include_paths.iter().flatten().chain(scope.exclude_paths.iter().flatten()) { if !safe_relative(path, corpus) { return Err("检索路径超出指定语料".into()); } }
    if request.targets.iter().any(|target| target.path.as_ref().is_some_and(|path| !safe_relative(path, corpus))) { return Err("检索目标路径超出指定语料".into()); }
    let budget = request.budget.clone().unwrap_or_default();
    let started = Instant::now();
    let deadline = started + Duration::from_millis(budget.time_limit_ms.unwrap_or(60_000).min(60_000));
    let mut warnings = Vec::<String>::new();
    let mut reached = Vec::<String>::new();
    let mut states = Vec::<Value>::new();
    let mut evidence = Vec::<Value>::new();
    let mut results = Vec::<Value>::new();
    let query_limit = budget.query_limit.unwrap_or(32).min(64);
    let candidate_limit = budget.candidate_limit.unwrap_or(320).min(960);
    let mut remaining = budget.context_char_limit.unwrap_or(40_000).min(300_000);
    let initial_chars = remaining;
    let mut candidate_count = 0;
    let mut query_count = 0;
    let mut queries = Vec::<Value>::new();
    let mut trace = Vec::<Value>::new();
    if record_trace { trace.push(json!({"event":"effective-retrieval-config","channels":enabled,
        "contextCharLimit":initial_chars,"candidateLimit":candidate_limit,"queryLimit":query_limit,
        "timeLimitMs":budget.time_limit_ms.unwrap_or(60_000).min(60_000),"excludedEvidencePaths":["wiki/index.md"]})); }
    let mut failed = false;
    // 标题只处理调用方明确提供的页面标题，不把问答或来源正文猜成标题。
    let mut applicable = enabled.iter().any(|(channel, allowed)| *allowed && (channel != "title" || request.targets.iter().any(|target| target.title.as_ref().is_some_and(|title| !title.trim().is_empty()))));
    if corpus == "sources" { applicable = enabled["keyword"]; }
    if !applicable {
        warnings.push(if corpus == "sources" && enabled.values().any(|enabled| *enabled) { "当前来源语料只支持关键词召回；该通道未启用" } else { "所有适用召回通道已关闭，或其能力未启用" }.into());
        for target in &request.targets {
            for (channel, allowed) in &enabled {
                states.push(json!({"targetId":target.id,"channel":channel,"status":if *allowed {"skipped"} else {"disabled"},"reason":if *allowed {"当前语料不适用"} else {"有效配置未启用此通道"}}));
            }
        }
    }
    // 全部关闭时不扫描正文，也不假装正常无命中。
    let pages = if applicable { read_pages(&request, corpus, &mut warnings, deadline)? } else { BTreeMap::new() };
    let relation_started = Instant::now();
    let relation_index = if corpus == "wiki" && applicable && warnings.is_empty() {
        Some(relation_index::snapshot(&request.project_path, &pages)?)
    } else { None };
    if record_trace { trace.push(json!({"event":"relation-index-snapshot","elapsedMs":relation_started.elapsed().as_millis()})); }
    let config_version = revision(&serde_json::to_string(&json!({"algorithm":"title-recall-v1","channels":enabled,"embedding":embedding_config.as_ref().map(|config| json!({"endpoint":config.endpoint,"model":config.model,"dimensions":config.output_dimensionality}))})).map_err(|error| error.to_string())?);
    let corpus_version = revision(&serde_json::to_string(&pages.values().map(|page| (&page.path, &page.revision)).collect::<Vec<_>>()).map_err(|error| error.to_string())?);
    let checkpoint = request.checkpoint.as_ref().filter(|checkpoint| checkpoint["configVersion"] == config_version && checkpoint["corpusVersion"] == corpus_version);
    let mut channel_results = Vec::<Value>::new();
    let mut returned_relations = BTreeMap::<String, Value>::new();
    let mut used_relations = BTreeSet::<String>::new();
    for (target_index, target) in request.targets.iter().enumerate() {
        let mut scope = scope.clone();
        if let Some(path) = &target.path { scope.exclude_paths.get_or_insert_with(Vec::new).push(path.clone()); }
        let target_started = Instant::now();
        let mut target_failed = false;
        if target.text.trim().is_empty() || target_index >= query_limit || Instant::now() >= deadline || remaining == 0 || candidate_count >= candidate_limit || !applicable {
            reached.push(if !applicable { "disabled" } else { "task-budget" }.into());
            results.push(json!({"targetId":target.id,"status":"not_run","evidenceIds":[],"reason":reached.last()}));
            continue;
        }
        query_count += 1;
        let query_id = format!("query-{}", target.id);
        queries.push(json!({"id":query_id,"targetId":target.id,"text":target.text,"title":target.title}));
        let query_revision = revision(&serde_json::to_string(&json!({"text":target.text,"title":target.title,"path":target.path})).map_err(|error| error.to_string())?);
        let mut candidates = Vec::<Candidate>::new();
        for channel in ["title", "keyword", "indexPage", "vector", "graph"] {
            let channel_started = Instant::now();
            let candidate_offset = candidates.len();
            let mut status = if enabled[channel] { "completed" } else { "disabled" };
            let mut reason = None;
            if corpus == "sources" && ["title", "indexPage", "graph", "vector"].contains(&channel) { status = "skipped"; reason = Some("来源语料不适用".to_string()); }
            if channel == "title" && status == "completed" && target.title.as_ref().is_none_or(|title| title.trim().is_empty()) { status = "skipped"; reason = Some("未提供页面标题".into()); }
            if status == "completed" && Instant::now() >= deadline { status = "skipped"; reason = Some("检索达到时间预算".into()); reached.push("timeLimit".into()); target_failed = true; }
            let saved = checkpoint.and_then(|checkpoint| checkpoint["channelResults"].as_array()).and_then(|channels| channels.iter().find(|entry| entry["targetId"] == target.id && entry["queryRevision"] == query_revision && entry["channel"] == channel && entry["status"] == "completed"));
            let mut reused = false;
            if status == "completed" && channel != "graph" {
                if let Some(saved) = saved {
                    if let Some(entries) = saved["candidates"].as_array().filter(|entries| entries.len() <= if channel == "title" { 3 } else { 100 }) {
                        let mut restored = Vec::new();
                        let valid = entries.iter().all(|entry| {
                            let path = entry["path"].as_str().unwrap_or_default();
                            let Some(page) = pages.get(path) else { return false; };
                            let quote = entry["quote"].as_str().map(str::to_string);
                            let rank = entry["rank"].as_u64().unwrap_or(0) as usize;
                            if rank == 0 || rank > 100 || !in_scope(path, &scope) || entry["revision"] != page.revision || quote.as_ref().is_some_and(|text| !page.text.contains(text)) { return false; }
                            restored.push(Candidate { path: path.into(), channel: channel.into(), rank, quote });
                            true
                        });
                        if valid { candidates.extend(restored); reused = true; }
                    }
                }
            }
            if status == "completed" && !reused { match channel {
                "title" => candidates.extend(title_recall::candidates(&pages, target.title.as_deref().unwrap_or_default(), &scope, deadline)),
                "keyword" => candidates.extend(lexical_candidates(&request, &pages, &target.text, &scope, deadline)),
                "indexPage" => {
                    let edges = relation_index.as_ref().map(|index| index.outgoing("wiki/index.md")).unwrap_or_default();
                    candidates.extend(indexed_candidates(&pages, &target.text, &scope, edges));
                },
                "vector" => {
                    let vector = if target_index == 0 && explicit_embedding.is_some() { explicit_embedding.clone().ok_or_else(|| "没有查询向量".to_string()) }
                        else if let Some(config) = embedding_config.as_ref() { tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), fetch_embedding_with_retry(&target.text, config, 0)).await.map_err(|_| "向量召回达到时间预算".to_string()).and_then(|result| result) }
                        else { Err("Embedding 未配置".to_string()) };
                    match vector {
                        Ok(vector) => match vectorstore::vector_search_chunks(request.project_path.clone(), vector, 8).await {
                            Ok(chunks) => {
                                let mut seen = BTreeSet::new();
                                for chunk in chunks {
                                    let matches: Vec<&Page> = pages.values().filter(|page| vector_page_id(&page.path).as_deref() == Some(chunk.page_id.as_str()) || file_stem(&page.path) == chunk.page_id).collect();
                                    if matches.len() != 1 || !in_scope(&matches[0].path, &scope) { continue; }
                                    let page = matches[0];
                                    if !page.text.contains(&chunk.chunk_text) { status = "failed"; reason = Some("过期向量片段无法定位".into()); warnings.push(format!("过期向量证据无法定位：{}", page.path)); target_failed = true; continue; }
                                    let rank = if seen.insert(page.path.clone()) { seen.len() } else { candidates.iter().find(|entry| entry.channel == "vector" && entry.path == page.path).map(|entry| entry.rank).unwrap_or(1) };
                                    candidates.push(Candidate { path: page.path.clone(), channel: channel.into(), rank, quote: Some(chunk.chunk_text) });
                                }
                            }
                            Err(error) => { status = "failed"; reason = Some(error); target_failed = true; }
                        },
                        Err(error) => { status = "unavailable"; reason = Some(error); target_failed = true; }
                    }
                }
                "graph" => {
                    let mut seeds: BTreeSet<String> = candidates.iter().map(|entry| entry.path.clone()).take(8).collect();
                    if seeds.is_empty() {
                        let tokens = tokenize_query(&target.text);
                        seeds.extend(pages.values().filter(|page| in_scope(&page.path, &scope) && token_match_score(&page.title, &tokens) > 0).take(8).map(|page| page.path.clone()));
                        candidates.extend(seeds.iter().enumerate().map(|(index, path)| Candidate { path: path.clone(), channel: "graph".into(), rank: index + 1, quote: None }));
                    }
                    let mut neighbors = BTreeSet::new();
                    let edges = relation_index.as_ref().map(|index| index.for_pages(&seeds)).unwrap_or_default();
                    for edge in edges {
                        let from = edge["fromPath"].as_str().unwrap_or_default().to_string();
                        let to = edge["toPath"].as_str().unwrap_or_default().to_string();
                        if from == "wiki/index.md" && !enabled["indexPage"] || to == "wiki/index.md" { continue; }
                        if seeds.contains(&from) || seeds.contains(&to) {
                            let neighbor = if seeds.contains(&from) { to } else { from };
                            if in_scope(&neighbor, &scope) && pages.contains_key(&neighbor) && !seeds.contains(&neighbor) { neighbors.insert(neighbor); if let Some(id) = edge["id"].as_str() { used_relations.insert(id.into()); } }
                            if neighbors.len() >= 20 { break; }
                        }
                    }
                    let tokens = tokenize_query(&target.text);
                    let mut ranked: Vec<_> = neighbors.into_iter().filter_map(|path| { let score = token_match_score(&pages[&path].text, &tokens); (score > 0).then_some((path, score)) }).collect();
                    ranked.sort_by(|a, b| b.1.cmp(&a.1));
                    candidates.extend(ranked.into_iter().take(8).enumerate().map(|(index, (path, _))| Candidate { path, channel: "graph".into(), rank: index + 1, quote: None }));
                }
                _ => {}
            } }
            states.push(json!({"targetId":target.id,"channel":channel,"status":status,"reason":reason,"reused":reused,"elapsedMs":channel_started.elapsed().as_millis(),"candidates":candidates.len()-candidate_offset}));
            channel_results.push(json!({"targetId":target.id,"queryRevision":query_revision,"channel":channel,"status":status,
                "candidates":candidates[candidate_offset..].iter().map(|entry| json!({"path":entry.path,"revision":pages.get(&entry.path).map(|page| &page.revision),"rank":entry.rank,"quote":entry.quote})).collect::<Vec<_>>()}));
            if record_trace { trace.push(json!({"event":"channel-candidates","targetId":target.id,"channel":channel,
                "candidates":candidates[candidate_offset..].iter().map(|entry| json!({"path":entry.path,"rank":entry.rank,"quote":entry.quote})).collect::<Vec<_>>()})); }
        }
        if Instant::now() >= deadline { target_failed = true; reached.push("timeLimit".into()); }
        let available = candidate_limit.saturating_sub(candidate_count);
        if candidates.len() > available { candidates.truncate(available); reached.push("candidateLimit".into()); }
        candidate_count += candidates.len();
        let mut scores = BTreeMap::<String, f64>::new();
        let mut voted = BTreeSet::new();
        for candidate in &candidates { if voted.insert((candidate.path.clone(), candidate.channel.clone())) { *scores.entry(candidate.path.clone()).or_default() += 1.0 / (RRF_K + candidate.rank as f64); } }
        let mut ranked: Vec<_> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        // 标题候选有独立名额，先展开完整正文；不能在融合后被普通片段的前八名再次淘汰。
        let title_paths: Vec<_> = candidates.iter().filter(|entry| entry.channel == "title").map(|entry| entry.path.clone()).collect();
        let expansion_paths: Vec<_> = title_paths.iter().cloned().chain(ranked.iter().filter(|(path, _)| !title_paths.contains(path)).map(|(path, _)| path.clone())).collect();
        let target_budget = remaining / (request.targets.len() - target_index).max(1);
        if record_trace { trace.push(json!({"event":"fused-candidates","targetId":target.id,"ranking":ranked,"targetBudgetChars":target_budget,"taskRemainingChars":remaining})); }
        let mut consumed = 0;
        let mut ids = Vec::new();
        let mut ordinary_ids = 0;
        for path in expansion_paths {
            let is_title = title_paths.contains(&path);
            if !is_title && ordinary_ids >= 8 { break; }
            if Instant::now() >= deadline { target_failed = true; reached.push("timeLimit".into()); break; }
            let Some(page) = pages.get(&path) else { continue; };
            let current = read_evidence_text(&Path::new(&request.project_path).join(&path), corpus)?.unwrap_or_default();
            if revision(&current) != page.revision { warnings.push(format!("候选在检索期间变化：{path}")); target_failed = true; continue; }
            let quotes = candidates.iter().filter(|entry| entry.path == path).filter_map(|entry| entry.quote.clone()).collect::<Vec<_>>();
            let mut segments = Vec::new();
            let available_chars = target_budget.saturating_sub(consumed);
            let ranges = if is_title {
                // 与片段证据保持相同行号契约，末尾换行不形成额外的空行证据。
                let text = page.text.lines().collect::<Vec<_>>().join("\n");
                let chars = text.chars().count();
                segments.push(json!({"startLine":1,"endLine":page.text.lines().count(),"chars":chars,"remainingChars":available_chars,"accepted":chars <= available_chars,"fullTitleCandidate":true}));
                if !text.trim().is_empty() && chars <= available_chars { vec![(1, page.text.lines().count(), text)] } else { Vec::new() }
            } else { evidence_ranges(page, &target.text, &quotes, available_chars, &mut segments) };
            if record_trace { trace.push(json!({"event":"evidence-expansion","targetId":target.id,"path":path,"revision":page.revision,
                "remainingChars":target_budget.saturating_sub(consumed),"segments":segments,"returnedRanges":ranges.len()})); }
            if ranges.is_empty() { warnings.push(format!("候选正文未能在本次预算内展开：{path}")); target_failed = true; }
            for (start, end, text) in ranges {
                if !is_title && ordinary_ids >= 8 { break; }
                consumed += text.chars().count();
                let id = format!("{}:{start}:{end}", page.revision);
                let id = format!("{}-{id}", path);
                let source = candidates.iter().filter(|entry| entry.path == path).map(|entry| json!({"channel":entry.channel,"queryId":query_id,"rank":entry.rank})).collect::<Vec<_>>();
                if let Some(existing) = evidence.iter_mut().find(|entry| entry["id"] == id) {
                    existing["targetIds"].as_array_mut().unwrap().push(json!(target.id));
                    existing["ranks"][&target.id] = json!(ids.len() + 1);
                } else {
                    let edges = relation_index.as_ref().map(|index| index.for_pages(&BTreeSet::from([path.clone()]))).unwrap_or_default();
                    let relation_ids: Vec<_> = edges.into_iter().take(30).map(|mut edge| {
                        let id = edge["id"].as_str().unwrap_or_default().to_string();
                        edge["usedForRecall"] = json!(used_relations.contains(&id));
                        returned_relations.insert(id.clone(), edge);
                        json!(id)
                    }).collect();
                    let headings: Vec<_> = page.text.lines().take(start).filter(|line| line.starts_with('#')).map(|line| line.trim_start_matches('#').trim()).collect();
                    evidence.push(json!({"id":id,"targetIds":[target.id],"path":path,"title":page.title,"revision":page.revision,"headingPath":headings,
                        "range":{"startLine":start,"endLine":end},"text":text,"ranks":{&target.id:ids.len()+1},"retrievalSources":source,"relationIds":relation_ids}));
                }
                ids.push(id);
                if !is_title { ordinary_ids += 1; }
            }
        }
        remaining = remaining.saturating_sub(consumed);
        failed |= target_failed;
        results.push(json!({"targetId":target.id,"status":if target_failed {"incomplete"} else if ids.is_empty() {"no_match"} else {"matched"},"evidenceIds":ids,"elapsedMs":target_started.elapsed().as_millis(),"usage":{"candidates":candidates.len(),"contextChars":consumed}}));
    }
    let edges: Vec<_> = returned_relations.into_iter().map(|(id, mut edge)| {
        edge["usedForRecall"] = json!(used_relations.contains(&id));
        edge
    }).collect();
    let status = if !applicable {"disabled"} else if failed && evidence.is_empty() && warnings.is_empty() && states.iter().all(|state| state["status"] != "completed") {"failed"} else if failed || !warnings.is_empty() || !reached.is_empty() {"partial"} else {"completed"};
    let mut result = json!({"status":status,"evidence":evidence,"relations":edges,"targetResults":results,"execution":{
        "configVersion":config_version,"corpusVersion":corpus_version,"channelResults":channel_results,"queries":queries,
        "channelStates":states,"warnings":warnings,"budgetReached":reached,"elapsedMs":started.elapsed().as_millis(),
        "usage":{"candidates":candidate_count,"queries":query_count,"contextChars":initial_chars-remaining,"readChars":pages.values().map(|page| page.text.chars().count()).sum::<usize>()}
    }});
    if record_trace { result["execution"]["trace"] = json!(trace); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 长正文中的泛相关词不能挤掉标题相近的旧页；审阅需拿到旧页全文而非仅标题。
    #[tokio::test]
    async fn title_candidates_survive_body_ranking_and_reach_review_with_complete_text() {
        let (root, _) = fixture();
        let old_path = "wiki/concepts/old-term.md";
        let old = "---\ntitle: 元数据标签继承与计算运行机制\n---\n# 元数据标签继承与计算运行机制\n\n父子实体标签继承规则。\n\n## 补偿机制\n标签字段为 false 时去掉继承标签。";
        fs::write(root.join(old_path), old).unwrap();
        let noise = "特征分配 业务模型 租户 系统 发布 设计 属性 实体";
        for index in 0..8 { fs::write(root.join(format!("wiki/concepts/noise-{index}.md")), format!("# {noise} {index}\n\n{noise}" )).unwrap(); }
        for scene in ["ingest", "review"] {
            let request: Request = serde_json::from_value(json!({"projectPath":root,"scene":scene,
                "targets":[{"id":"term","title":"元数据标签机制","text":format!("元数据标签机制\n{noise}")}],
                "channels":{"title":true,"keyword":true,"indexPage":false,"vector":false,"graph":false}})).unwrap();
            let result = retrieve(request, None, None).await.unwrap();
            let evidence = result["evidence"].as_array().unwrap();
            let recalled = evidence.iter().find(|entry| entry["path"] == old_path).expect("标题相近的旧页必须进入核对材料");
            assert_eq!(recalled["text"], old);
            assert!(recalled["retrievalSources"].as_array().unwrap().iter().any(|source| source["channel"] == "title"));
            assert_eq!(evidence.iter().filter(|entry| entry["path"].as_str().unwrap().contains("noise-")).count(), 8);
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// 标题比较使用通用信号，兼容中文、英文、混合标题及不同文件名；同词的超长标题不应抢占名额。
    #[tokio::test]
    async fn title_recall_handles_languages_scope_and_disable_without_body_matches() {
        let (root, _) = fixture();
        for (query, title) in [("Redis缓存清理", "Redis 缓存失效与清理机制"),
            ("QuerySchema SQL构建", "QuerySchema SQL生成与构建流程"), ("Metadata cache", "Metadata cache invalidation")] {
            fs::write(root.join("wiki/concepts/old.md"), format!("---\ntitle: {title}\n---\n仅存在于旧页的完整事实。")).unwrap();
            fs::write(root.join("wiki/concepts/noise.md"), format!("# {query} {}\n\n无关内容。", "其他系统与操作指南".repeat(20))).unwrap();
            let request: Request = serde_json::from_value(json!({"projectPath":root,"scene":"review",
                "targets":[{"id":"page","title":query,"text":"正文中完全不同的事实"}],
                "scope":{"corpus":"wiki","includePaths":["wiki/concepts/old.md","wiki/concepts/noise.md"]},
                "channels":{"title":true,"keyword":false,"indexPage":false,"vector":false,"graph":false}})).unwrap();
            let result = retrieve(request.clone(), None, None).await.unwrap();
            assert_eq!(result["evidence"][0]["path"], "wiki/concepts/old.md", "{query}: {result}");
            assert!(!result["evidence"].as_array().unwrap().iter().any(|entry| entry["path"] == "wiki/concepts/noise.md"));
            let mut excluded = request.clone();
            excluded.scope.as_mut().unwrap().exclude_paths = Some(vec!["wiki/concepts/old.md".into()]);
            let result = retrieve(excluded, None, None).await.unwrap();
            assert!(result["evidence"].as_array().unwrap().is_empty());
            let mut disabled = request;
            disabled.channels.as_mut().unwrap().insert("title".into(), false);
            let result = retrieve(disabled, None, None).await.unwrap();
            assert_eq!(result["status"], "disabled");
            assert_eq!(result["execution"]["usage"]["readChars"], 0);
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// 标题改变必须使旧断点失效；预算不足不能伪装成完整查重或只给旧页标题。
    #[tokio::test]
    async fn title_recall_invalidates_checkpoints_and_reports_insufficient_budget() {
        let (root, _) = fixture();
        let old = "---\ntitle: 元数据标签继承与计算运行机制\n---\n# 标签计算\n完整的标签规则与补偿事实。\n";
        fs::write(root.join("wiki/concepts/old.md"), old).unwrap();
        let mut request: Request = serde_json::from_value(json!({"projectPath":root,"scene":"review",
            "targets":[{"id":"page","title":"元数据标签机制","text":"正文不变"}],
            "channels":{"title":true,"keyword":false,"indexPage":false,"vector":false,"graph":false}})).unwrap();
        let first = retrieve(request.clone(), None, None).await.unwrap();
        assert_eq!(first["evidence"][0]["text"], old.trim_end());
        request.checkpoint = Some(first["execution"].clone());
        let resumed = retrieve(request.clone(), None, None).await.unwrap();
        assert!(resumed["execution"]["channelStates"].as_array().unwrap().iter().any(|entry| entry["channel"] == "title" && entry["reused"] == true));
        request.targets[0].title = Some("完全不同的主题".into());
        let changed = retrieve(request.clone(), None, None).await.unwrap();
        assert!(changed["evidence"].as_array().unwrap().is_empty());
        assert!(changed["execution"]["channelStates"].as_array().unwrap().iter().all(|entry| entry["reused"] != true));
        request.targets[0].title = Some("元数据标签机制".into());
        request.budget = Some(Budget { context_char_limit: Some(5), ..Default::default() });
        let limited = retrieve(request, None, None).await.unwrap();
        assert_eq!(limited["status"], "partial");
        assert_eq!(limited["targetResults"][0]["status"], "incomplete");
        assert!(limited["evidence"].as_array().unwrap().is_empty());
        assert!(!limited["execution"]["warnings"].as_array().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn resume_reuses_successful_channels_and_invalidates_changed_corpus_or_query() {
        let (root, mut request) = fixture();
        let initial = retrieve(request.clone(), None, None).await.unwrap();
        request.checkpoint = Some(initial["execution"].clone());
        let resumed = retrieve(request.clone(), None, None).await.unwrap();
        assert_eq!(initial["evidence"], resumed["evidence"]);
        assert!(resumed["execution"]["channelStates"].as_array().unwrap().iter().any(|state| state["channel"] == "keyword" && state["reused"] == true));

        fs::write(root.join("wiki/concepts/new.md"), "# Cache\n新增缓存策略事实。").unwrap();
        let changed = retrieve(request.clone(), None, None).await.unwrap();
        assert_ne!(initial["execution"]["corpusVersion"], changed["execution"]["corpusVersion"]);
        assert!(changed["execution"]["channelStates"].as_array().unwrap().iter().all(|state| state["reused"] != true));

        request.checkpoint = Some(changed["execution"].clone());
        request.targets[0].text = "完全不同的查询".into();
        let query_changed = retrieve(request, None, None).await.unwrap();
        assert!(query_changed["execution"]["channelStates"].as_array().unwrap().iter().all(|state| state["reused"] != true));
        fs::remove_dir_all(root).unwrap();
    }

    fn fixture() -> (std::path::PathBuf, Request) {
        let root = std::env::temp_dir().join(format!("evidence-retrieval-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        for index in 0..8 { fs::write(root.join(format!("wiki/concepts/cache-{index}.md")), format!("# Cache {index}\n\n缓存策略 Cache 的事实 {index}。\n")).unwrap(); }
        fs::write(root.join("wiki/index.md"), "# Index\n- [[cache-0]] Cache 目录\n- [[cache-1]] Cache 目录\n").unwrap();
        let request = Request { project_path: root.to_string_lossy().into_owned(), scene: "review".into(),
            targets: vec![Target { id: "cache".into(), text: "Cache".into(), title: None, path: None }], scope: None, channels: None, budget: None, checkpoint: None };
        (root, request)
    }

    /// 保持现有关键词评分排序；优化候选扫描不能改变大小写、重叠词和短语加权契约。
    #[test]
    fn lexical_candidate_ranking_matches_existing_search_scores() {
        let root = Path::new("/project");
        let texts = ["# Cache\n缓存隔离配置 Cache build", "# QuerySchema\nQuerySchema build() 缓存配置", "# aa\naaaa", "# 系统级业务对象\n系统级业务对象没有系统级元数据", "# unrelated\n其他内容"];
        let pages: BTreeMap<_, _> = texts.iter().enumerate().map(|(index, text)| {
            let path = format!("wiki/page-{index}.md");
            (path.clone(), Page { path, title: extract_title(text, ""), text: text.to_string(), revision: revision(text) })
        }).collect();
        let request: Request = serde_json::from_value(json!({"projectPath":root,"scene":"review","targets":[{"id":"page","text":"Cache"}]})).unwrap();
        for query in ["Cache", "缓存隔离配置", "QuerySchema build()", "系统级业务对象没有系统级元数据", "aa aa", "🦀"] {
            let tokens = tokenize_query(query);
            let phrase = trim_query_punctuation(&query.to_lowercase());
            let mut expected: Vec<_> = pages.values().filter_map(|page| score_file("/project", &root.join(&page.path), &page.text, &tokens, &phrase, query, false).map(|hit| (page.path.clone(), hit.score))).collect();
            expected.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let actual = lexical_candidates(&request, &pages, query, &Scope::default(), Instant::now() + Duration::from_secs(10));
            assert_eq!(actual.iter().map(|entry| entry.path.clone()).collect::<Vec<_>>(), expected.into_iter().take(8).map(|entry| entry.0).collect::<Vec<_>>(), "{query}");
        }
    }

    /// 手动性能回归：长中文查询和五百余页不能耗尽首批预算、饿死后续页面。
    #[tokio::test]
    #[ignore = "显式运行的长查询性能回归"]
    async fn long_review_keyword_batch_does_not_starve_later_targets() {
        let (root, _) = fixture();
        let query = (0..120).map(|index| format!("元数据条件{index}特征配置")).collect::<Vec<_>>().join(" ");
        for index in 0..534 {
            fs::write(root.join(format!("wiki/concepts/large-{index}.md")), format!("# 工程 {index}\n\n{query}\n\n{}", "保留独有条件及来源归属。".repeat(60))).unwrap();
        }
        let request: Request = serde_json::from_value(json!({"projectPath":root,"scene":"review",
            "targets":(0..10).map(|index| json!({"id":format!("page-{index}"),"text":query})).collect::<Vec<_>>(),
            "channels":{"title":false,"keyword":true,"indexPage":false,"vector":false,"graph":false},
            "budget":{"timeLimitMs":5000,"contextCharLimit":300000}})).unwrap();
        let result = retrieve(request, None, None).await.unwrap();
        assert_eq!(result["targetResults"].as_array().unwrap().len(), 10);
        assert!(result["targetResults"].as_array().unwrap().iter().all(|target| target["status"] == "matched"), "{result}");
        assert_eq!(result["status"], "completed");
        fs::remove_dir_all(root).unwrap();
    }

    /// 本页已由审阅器直接提供，不应重复占用召回预算；同轮其他页仍必须能被召回。
    #[tokio::test]
    async fn review_targets_exclude_own_page_but_keep_current_round_peers() {
        let (root, _) = fixture();
        let own = "wiki/concepts/cache-0.md";
        let peer = "wiki/concepts/cache-1.md";
        let request: Request = serde_json::from_value(json!({"projectPath":root,"scene":"review",
            "targets":[{"id":"first","path":own,"title":"Cache 0","text":"缓存策略"},{"id":"second","path":peer,"title":"Cache 1","text":"缓存策略"}],
            "channels":{"title":true,"keyword":true,"indexPage":false,"vector":false,"graph":false}})).unwrap();
        let result = retrieve(request, None, None).await.unwrap();
        let evidence = result["evidence"].as_array().unwrap();
        for (id, own, peer) in [("first", own, peer), ("second", peer, own)] {
            assert!(!evidence.iter().any(|entry| entry["path"] == own && entry["targetIds"].as_array().unwrap().iter().any(|target| target == id)));
            assert!(evidence.iter().any(|entry| entry["path"] == peer && entry["targetIds"].as_array().unwrap().iter().any(|target| target == id)));
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// Node 集成评估只替换 Tauri 传输，实际召回仍执行本模块；默认测试不触发模型。
    #[tokio::test]
    #[ignore]
    async fn retrieval_transport_for_node_evaluation() {
        let input = std::env::var("LLM_WIKI_EVALUATION_REQUEST").expect("缺少评估请求路径");
        let output = std::env::var("LLM_WIKI_EVALUATION_RESULT").expect("缺少评估结果路径");
        let value: Value = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
        let config = std::env::var("LLM_WIKI_EVALUATION_CONFIG").ok().map(|path| {
            if let Some(directory) = Path::new(&path).parent() { set_config_directory(directory.to_path_buf()); }
            serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap()
        });
        if value["operation"] == "invoke" {
            let result = evaluation_invoke(value["command"].as_str().unwrap(), &value["args"]).await;
            let envelope = match result { Ok(value) => json!({"result":value}), Err(error) => json!({"error":error}) };
            fs::write(output, serde_json::to_vec(&envelope).unwrap()).unwrap();
            return;
        }
        let request: Request = serde_json::from_value(value).unwrap();
        let embedding = config.map(|config| serde_json::from_value(config["embeddingConfig"].clone()).unwrap());
        let result = retrieve_with_trace(request, embedding, None, std::env::var_os("LLM_WIKI_EVALUATION_TRACE").is_some()).await.unwrap();
        fs::write(output, serde_json::to_vec(&result).unwrap()).unwrap();
    }

    /// 仅供显式真实回放使用：替换 IPC 传输，写入仍执行实际原生版本保护和向量实现。
    async fn evaluation_invoke(command: &str, args: &Value) -> Result<Value, String> {
        let string = |key: &str| args[key].as_str().unwrap_or_default().to_string();
        match command {
            "compare_and_write_file" => {
                crate::commands::fs::compare_and_write_file(string("projectPath"), string("relativePath"), args["expected"].as_str().map(str::to_string), string("contents")).await?;
                Ok(Value::Null)
            }
            "embedding_fetch" => Ok(json!(embedding_fetch(string("text"), serde_json::from_value(args["cfg"].clone()).map_err(|error| error.to_string())?, args["maxRetries"].as_u64().map(|value| value as usize)).await?)),
            "embedding_fetch_batch" => Ok(json!(embedding_fetch_batch(serde_json::from_value(args["texts"].clone()).map_err(|error| error.to_string())?, serde_json::from_value(args["cfg"].clone()).map_err(|error| error.to_string())?).await?)),
            "vector_upsert_indexed_chunks" => {
                vectorstore::vector_upsert_indexed_chunks(string("projectPath"), string("pageId"), serde_json::from_value(args["chunks"].clone()).map_err(|error| error.to_string())?, string("fingerprint"), args["expectedContent"].as_str().map(str::to_string)).await?;
                Ok(Value::Null)
            }
            "vector_upsert_chunks" => { vectorstore::vector_upsert_chunks(string("projectPath"), string("pageId"), serde_json::from_value(args["chunks"].clone()).map_err(|error| error.to_string())?).await?; Ok(Value::Null) }
            "vector_delete_page" => { vectorstore::vector_delete_page(string("projectPath"), string("pageId")).await?; Ok(Value::Null) }
            "vector_optimize_chunks" => { vectorstore::vector_optimize_chunks(string("projectPath")).await?; Ok(Value::Null) }
            "vector_legacy_row_count" => Ok(json!(vectorstore::vector_legacy_row_count(string("projectPath")).await?)),
            _ => Err(format!("真实回放尚未支持原生命令：{command}")),
        }
    }

    #[tokio::test]
    async fn disabled_channels_are_not_reenabled_by_caller() {
        let (root, mut request) = fixture();
        fs::write(root.join(".llm-wiki/retrieval.json"), r#"{"keyword":false,"indexPage":false,"vector":false,"graph":false}"#).unwrap();
        request.channels = Some(BTreeMap::from([("keyword".into(), true)]));
        let result = retrieve(request, None, None).await.unwrap();
        assert_eq!(result["status"], "disabled");
        assert_eq!(result["execution"]["usage"]["readChars"], 0);
        assert_eq!(result["targetResults"][0]["status"], "not_run");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn independent_targets_have_capped_versioned_and_located_evidence() {
        let (root, mut request) = fixture();
        fs::write(root.join("wiki/concepts/redis.md"), "# Redis\n\nRedis 的独立事实。\n").unwrap();
        request.targets.push(Target { id: "redis".into(), text: "Redis".into(), title: None, path: None });
        let result = retrieve(request, None, None).await.unwrap();
        assert_eq!(result["status"], "completed");
        for target in result["targetResults"].as_array().unwrap() {
            assert_eq!(target["status"], "matched");
            assert!(target["evidenceIds"].as_array().unwrap().len() <= 8);
        }
        for evidence in result["evidence"].as_array().unwrap() {
            let text = fs::read_to_string(root.join(evidence["path"].as_str().unwrap())).unwrap();
            let start = evidence["range"]["startLine"].as_u64().unwrap() as usize;
            let end = evidence["range"]["endLine"].as_u64().unwrap() as usize;
            assert_eq!(text.lines().skip(start - 1).take(end - start + 1).collect::<Vec<_>>().join("\n"), evidence["text"]);
            assert_eq!(revision(&text), evidence["revision"]);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn scenes_share_contract_and_budget_does_not_become_no_match() {
        let (root, mut request) = fixture();
        let first = retrieve(request.clone(), None, None).await.unwrap();
        for scene in ["ingest", "qa", "search"] {
            request.scene = scene.into();
            let result = retrieve(request.clone(), None, None).await.unwrap();
            assert_eq!(result["evidence"], first["evidence"]);
        }
        request.budget = Some(Budget { query_limit: Some(0), ..Default::default() });
        let limited = retrieve(request, None, None).await.unwrap();
        assert_eq!(limited["status"], "partial");
        assert_eq!(limited["targetResults"][0]["status"], "not_run");
        fs::remove_dir_all(root).unwrap();
    }

    /// 索引只负责导航：关键词命中、图谱反向遍历均不能把目录当作正文证据。
    #[tokio::test]
    async fn navigation_index_is_excluded_from_keyword_and_graph_evidence() {
        for channel in ["keyword", "graph"] {
            let (root, mut request) = fixture();
            for index in 1..8 { fs::remove_file(root.join(format!("wiki/concepts/cache-{index}.md"))).unwrap(); }
            fs::write(root.join("wiki/index.md"), "# Navigation\n\n- [[cache-0]] Cache 目录\n").unwrap();
            fs::write(root.join(".llm-wiki/retrieval.json"), r#"{"graph":true}"#).unwrap();
            request.channels = Some(["keyword", "indexPage", "vector", "graph"].into_iter()
                .map(|name| (name.into(), name == channel)).collect());

            let result = retrieve(request, None, None).await.unwrap();
            let evidence = result["evidence"].as_array().unwrap();
            assert_eq!(result["status"], "completed", "{channel}: {result}");
            assert!(evidence.iter().all(|entry| entry["path"] != "wiki/index.md"), "{channel}: {result}");
            assert!(evidence.iter().any(|entry| entry["path"] == "wiki/concepts/cache-0.md"));
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// 目录正文不进入证据，但仍须通过目录中的描述召回实际文档。
    #[tokio::test]
    async fn navigation_index_still_recalls_linked_documents() {
        let (root, mut request) = fixture();
        fs::write(root.join("wiki/index.md"), "# Navigation\n\n- [[cache-0]] NavigationOnly\n").unwrap();
        request.targets[0].text = "NavigationOnly".into();
        request.channels = Some(["keyword", "indexPage", "vector", "graph"].into_iter()
            .map(|name| (name.into(), name == "indexPage")).collect());

        let result = retrieve(request, None, None).await.unwrap();
        assert_eq!(result["status"], "completed");
        let evidence = result["evidence"].as_array().unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0]["path"], "wiki/concepts/cache-0.md");
        assert_eq!(evidence[0]["retrievalSources"][0]["channel"], "indexPage");
        assert!(result["relations"].as_array().unwrap().iter().any(|edge|
            edge["fromPath"] == "wiki/index.md" && edge["toPath"] == "wiki/concepts/cache-0.md"));
        fs::remove_dir_all(root).unwrap();
    }

    /// 历史向量库中的目录切片也要排除，过期目录切片不能导致检索降级。
    #[tokio::test]
    async fn navigation_index_vectors_do_not_become_evidence_or_warnings() {
        for index_quote in ["# Index", "已删除的目录旧正文"] {
            let (root, mut request) = fixture();
            for (path, text) in [("wiki/index.md", index_quote), ("wiki/concepts/cache-0.md", "缓存策略 Cache 的事实 0。")] {
                vectorstore::vector_upsert_chunks(root.to_string_lossy().into_owned(), vector_page_id(path).unwrap(), vec![vectorstore::ChunkUpsertInput {
                    chunk_index: 0, chunk_text: text.into(), heading_path: String::new(), embedding: vec![1.0, 0.0],
                }]).await.unwrap();
            }
            request.channels = Some(["keyword", "indexPage", "vector", "graph"].into_iter()
                .map(|name| (name.into(), name == "vector")).collect());
            let config = SearchEmbeddingConfig { enabled: true, endpoint: "unused".into(), api_key: String::new(), model: "test".into(), output_dimensionality: None, extra_headers: None, max_chunk_chars: None, overlap_chunk_chars: None };

            let result = retrieve(request, Some(config), Some(vec![1.0, 0.0])).await.unwrap();
            assert_eq!(result["status"], "completed", "{result}");
            assert!(result["execution"]["warnings"].as_array().unwrap().is_empty());
            let evidence = result["evidence"].as_array().unwrap();
            assert_eq!(evidence.len(), 1);
            assert_eq!(evidence[0]["path"], "wiki/concepts/cache-0.md");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn source_evidence_uses_fresh_extraction_and_skips_hidden_files() {
        let (root, mut request) = fixture();
        fs::create_dir_all(root.join("raw/sources/.cache")).unwrap();
        fs::write(root.join("raw/sources/manual.pdf"), b"%PDF source").unwrap();
        fs::write(root.join("raw/sources/.cache/manual.pdf.txt"), "Exact Cache policy from original source.").unwrap();
        fs::write(root.join("raw/sources/.cache/secret.md"), "Cache secret").unwrap();
        request.scope = Some(Scope { corpus: "sources".into(), ..Default::default() });
        let result = retrieve(request, None, None).await.unwrap();
        let evidence = result["evidence"].as_array().unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0]["path"], "raw/sources/manual.pdf");
        assert!(evidence[0]["text"].as_str().unwrap().contains("Exact Cache policy"));
        fs::remove_dir_all(root).unwrap();
    }

    /// 日志能解释正文超额，但启用采集不改变原始检索结果或普通调用上下文。
    #[tokio::test]
    async fn diagnostic_trace_explains_budget_without_changing_evidence() {
        let (root, mut request) = fixture();
        request.channels = Some(["keyword", "indexPage", "vector", "graph"].into_iter()
            .map(|channel| (channel.into(), channel == "keyword")).collect());
        request.budget = Some(Budget { context_char_limit: Some(1), ..Default::default() });
        let ordinary = retrieve(request.clone(), None, None).await.unwrap();
        let traced = retrieve_with_trace(request, None, None, true).await.unwrap();
        assert_eq!(traced["evidence"], ordinary["evidence"]);
        let target_contract = |result: &Value| {
            let mut targets = result["targetResults"].clone();
            for target in targets.as_array_mut().unwrap() { target.as_object_mut().unwrap().remove("elapsedMs"); }
            targets
        };
        assert_eq!(target_contract(&traced), target_contract(&ordinary));
        assert_eq!(traced["status"], ordinary["status"]);
        assert!(ordinary["execution"].get("trace").is_none());
        assert!(traced["execution"]["trace"].as_array().unwrap().iter().any(|entry|
            entry["event"] == "evidence-expansion" && entry["segments"].as_array().is_some_and(|segments|
                segments.iter().any(|segment| segment["accepted"] == false && segment["chars"].as_u64() > segment["remainingChars"].as_u64()))));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stale_vector_quote_is_not_rebranded_as_current_evidence() {
        let (root, mut request) = fixture();
        let path = "wiki/concepts/cache-0.md";
        vectorstore::vector_upsert_chunks(root.to_string_lossy().into_owned(), vector_page_id(path).unwrap(), vec![vectorstore::ChunkUpsertInput {
            chunk_index: 0, chunk_text: "旧版已经删除的 Cache 事实".into(), heading_path: String::new(), embedding: vec![1.0, 0.0],
        }]).await.unwrap();
        request.channels = Some(BTreeMap::from([("keyword".into(), false), ("indexPage".into(), false), ("graph".into(), false)]));
        let config = SearchEmbeddingConfig { enabled: true, endpoint: "unused".into(), api_key: String::new(), model: "test".into(), output_dimensionality: None, extra_headers: None, max_chunk_chars: None, overlap_chunk_chars: None };
        let result = retrieve(request, Some(config), Some(vec![1.0, 0.0])).await.unwrap();
        assert_eq!(result["status"], "partial");
        assert!(result["evidence"].as_array().unwrap().is_empty());
        assert_eq!(result["targetResults"][0]["status"], "incomplete");
        assert!(result["execution"]["warnings"].as_array().unwrap().iter().any(|warning| warning.as_str().unwrap().contains("过期向量")));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn vector_chunks_keep_independent_facts_but_cannot_cast_repeated_page_votes() {
        let (root, mut request) = fixture();
        let path = "wiki/concepts/cache-0.md";
        let body = "# Cache\n\nCache fact one.\n\nCache fact two.";
        fs::write(root.join(path), body).unwrap();
        let chunks = ["Cache fact one.", "Cache fact two."].iter().enumerate().map(|(index, text)| vectorstore::ChunkUpsertInput {
            chunk_index: index as u32, chunk_text: (*text).into(), heading_path: "Cache".into(), embedding: vec![1.0, 0.0],
        }).collect();
        vectorstore::vector_upsert_chunks(root.to_string_lossy().into_owned(), vector_page_id(path).unwrap(), chunks).await.unwrap();
        request.channels = Some(BTreeMap::from([("keyword".into(), false), ("indexPage".into(), false), ("graph".into(), false)]));
        let config = SearchEmbeddingConfig { enabled: true, endpoint: "unused".into(), api_key: String::new(), model: "test".into(), output_dimensionality: None, extra_headers: None, max_chunk_chars: None, overlap_chunk_chars: None };
        let result = retrieve(request, Some(config), Some(vec![1.0, 0.0])).await.unwrap();
        let evidence = result["evidence"].as_array().unwrap();
        assert!(evidence.iter().any(|entry| entry["text"].as_str().unwrap().contains("fact one")));
        assert!(evidence.iter().any(|entry| entry["text"].as_str().unwrap().contains("fact two")));
        for entry in evidence { assert!(entry["retrievalSources"].as_array().unwrap().iter().all(|source| source["rank"] == 1)); }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relation_direction_ambiguity_and_code_examples_are_preserved() {
        let make = |path: &str, text: &str| Page { path: path.into(), title: "相同标题".into(), text: text.into(), revision: revision(text) };
        let pages = BTreeMap::from([
            ("wiki/a.md".into(), make("wiki/a.md", "[[b#section|别名]]\n```text\n[[fake]]\n```\n[[相同标题]]")),
            ("wiki/b.md".into(), make("wiki/b.md", "# B")),
        ]);
        let edges = relations(&pages);
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0]["fromPath"], "wiki/a.md");
        assert_eq!(edges[0]["toPath"], "wiki/b.md");
        assert_eq!(edges[0]["anchor"], "section");
        assert_eq!(edges[1]["resolution"], "ambiguous");
    }
}
