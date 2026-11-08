use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::commands::vectorstore;
use crate::panic_guard::run_guarded_async;
pub mod evidence;

const DEFAULT_RESULTS: usize = 20;
const RRF_K: f64 = 60.0;
const FILENAME_EXACT_BONUS: f64 = 200.0;
const PHRASE_IN_TITLE_BONUS: f64 = 50.0;
const PHRASE_IN_CONTENT_PER_OCC: f64 = 20.0;
const MAX_PHRASE_OCC_COUNTED: usize = 10;
const TITLE_TOKEN_WEIGHT: f64 = 5.0;
const CONTENT_TOKEN_WEIGHT: f64 = 1.0;
const SNIPPET_CONTEXT: usize = 80;
const SEARCH_EMBEDDING_TIMEOUT_SECS: u64 = 8;
const MAX_SEARCH_FILES: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchImageRef {
    pub url: String,
    pub alt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub title_match: bool,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_score: Option<f32>,
    pub images: Vec<SearchImageRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graph_related_to: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_context: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResponse {
    pub mode: String,
    pub results: Vec<ProjectSearchResult>,
    pub token_hits: usize,
    pub vector_hits: usize,
    pub graph_hits: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retrieval: Option<Value>,
}

#[derive(Debug, Clone)]
struct GraphPage {
    path: String,
    title: String,
    content: String,
    links: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLinkEntry {
    pub title: String,
    pub path: Option<String>,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLinksResponse {
    pub outgoing: Vec<PageLinkEntry>,
    pub backlinks: Vec<PageLinkEntry>,
    pub missing: Vec<PageLinkEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEmbeddingConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub output_dimensionality: Option<f64>,
    /// Extra HTTP headers to send with every embedding request, e.g.
    /// `X-Model-Provider-Id: siliconflow` for the mify gateway.
    /// Reserved names (Authorization, Content-Type, Host,
    /// Content-Length, x-goog-api-key) are skipped — they're managed
    /// by the client.
    #[serde(default)]
    pub extra_headers: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub max_chunk_chars: Option<usize>,
    #[serde(default)]
    pub overlap_chunk_chars: Option<usize>,
}

#[tauri::command]
pub async fn search_project(
    project_path: String,
    query: String,
    top_k: Option<usize>,
    include_content: Option<bool>,
    query_embedding: Option<Vec<f32>>,
    embedding_config: Option<SearchEmbeddingConfig>,
) -> Result<ProjectSearchResponse, String> {
    run_guarded_async("search_project", async move {
        search_with_evidence(project_path, query, top_k.unwrap_or(DEFAULT_RESULTS), include_content.unwrap_or(false), query_embedding, embedding_config).await
    })
    .await
}

const SOURCE_CONTENT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const SOURCE_CONTENT_EXTENSIONS: &[&str] = &[
    "md", "mdx", "txt", "org", "rst", "json", "jsonl", "ndjson", "yaml", "yml", "csv", "tsv",
    "html", "htm", "xml", "py", "js", "ts", "jsx", "tsx", "rs", "go", "java", "c", "cpp", "h",
    "rb", "php", "swift", "sql", "sh",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceContentHit {
    pub path: String,
    pub name: String,
    pub snippet: String,
    pub match_count: usize,
}

/// Keyword-only content search over the raw source files of a project.
/// Deliberately no vector channel — this powers the sources panel filter,
/// where the corpus is small and deterministic substring ranking is what
/// the user expects. Text-like files above the size cap are skipped.
#[tauri::command]
pub async fn search_source_content(
    project_path: String,
    query: String,
    top_k: Option<usize>,
) -> Result<Vec<SourceContentHit>, String> {
    let top_k = top_k.unwrap_or(10).clamp(1, 50);
    tokio::task::spawn_blocking(move || search_source_content_inner(&project_path, &query, top_k))
        .await
        .map_err(|err| format!("source content search worker failed: {err}"))?
}

fn search_source_content_inner(
    project_path: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<SourceContentHit>, String> {
    let phrase = trim_query_punctuation(query).to_lowercase();
    let tokens = tokenize_query(query);
    if phrase.is_empty() && tokens.is_empty() {
        return Ok(Vec::new());
    }
    let root = Path::new(project_path).join("raw/sources");
    let mut hits: Vec<SourceContentHit> = Vec::new();
    for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if !SOURCE_CONTENT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.len() > SOURCE_CONTENT_MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        let lower = content.to_lowercase();
        let phrase_occ = count_occurrences(&lower, &phrase);
        let token_score = tokens
            .iter()
            .filter(|token| lower.contains(token.as_str()))
            .count();
        if phrase_occ == 0 && token_score == 0 {
            continue;
        }
        let score = phrase_occ * 5 + token_score;
        let anchor = if phrase_occ > 0 {
            phrase.clone()
        } else {
            tokens
                .iter()
                .find(|token| lower.contains(token.as_str()))
                .cloned()
                .unwrap_or_default()
        };
        hits.push(SourceContentHit {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            snippet: build_snippet(&content, &anchor),
            match_count: score,
        });
    }
    hits.sort_by(|a, b| b.match_count.cmp(&a.match_count).then(a.name.cmp(&b.name)));
    hits.truncate(top_k);
    Ok(hits)
}

#[tauri::command]
pub async fn embedding_fetch(
    text: String,
    cfg: SearchEmbeddingConfig,
    max_retries: Option<usize>,
) -> Result<Vec<f32>, String> {
    run_guarded_async("embedding_fetch", async move {
        fetch_embedding_with_retry(&text, &cfg, max_retries.unwrap_or(3)).await
    })
    .await
}

#[tauri::command]
pub async fn embedding_fetch_batch(
    texts: Vec<String>,
    cfg: SearchEmbeddingConfig,
) -> Result<Vec<Vec<f32>>, String> {
    run_guarded_async("embedding_fetch_batch", async move {
        fetch_embedding_batch(&texts, &cfg).await
    })
    .await
}

#[tauri::command]
pub async fn get_page_links(
    project_path: String,
    file_path: String,
) -> Result<PageLinksResponse, String> {
    tokio::task::spawn_blocking(move || get_page_links_inner(&project_path, &file_path))
        .await
        .map_err(|err| format!("page links worker failed: {err}"))?
}

/// Build link relationships from Markdown source rather than the UI's lazy
/// file tree. Canonical paths enforce the project/wiki boundary, while the
/// returned paths stay project-relative so all desktop platforms share one
/// wire format and Windows separators never leak into frontend routing.
fn get_page_links_inner(project_path: &str, file_path: &str) -> Result<PageLinksResponse, String> {
    let project = fs::canonicalize(project_path)
        .map_err(|err| format!("Failed to resolve project path: {err}"))?;
    let file =
        fs::canonicalize(file_path).map_err(|err| format!("Failed to resolve page path: {err}"))?;
    let wiki_root = project.join("wiki");
    if !file.starts_with(&wiki_root)
        || !file.is_file()
        || file.extension().and_then(|value| value.to_str()) != Some("md")
    {
        return Err("Page links target must be an existing Markdown file under wiki/".to_string());
    }

    let mut pages = BTreeMap::<String, GraphPage>::new();
    let canonical_project = project.to_string_lossy();
    for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
        if pages.len() >= MAX_SEARCH_FILES
            || !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let path = relative_to_project(&canonical_project, entry.path());
        let title = extract_title(
            &content,
            entry
                .path()
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default(),
        );
        pages.insert(
            normalize_path(&path),
            GraphPage {
                path,
                title,
                links: extract_graph_links(&content),
                content,
            },
        );
    }

    let current_path = normalize_path(&relative_to_project(&canonical_project, &file));
    let current = pages
        .get(&current_path)
        .ok_or_else(|| "Page is not available in the current wiki index".to_string())?;
    let mut outgoing = Vec::new();
    let mut missing = Vec::new();
    for link in &current.links {
        if let Some(target_path) = resolve_reader_wikilink(&pages, link) {
            if target_path.as_str() == current_path {
                continue;
            }
            if let Some(target) = pages.get(target_path) {
                outgoing.push(PageLinkEntry {
                    title: target.title.clone(),
                    path: Some(target.path.clone()),
                    snippet: None,
                });
            }
        } else {
            missing.push(PageLinkEntry {
                title: link.clone(),
                path: None,
                snippet: None,
            });
        }
    }

    let mut backlinks = Vec::new();
    for (path, page) in &pages {
        if path == &current_path {
            continue;
        }
        let links_here = page.links.iter().any(|link| {
            resolve_reader_wikilink(&pages, link)
                .is_some_and(|target| target.as_str() == current_path)
        });
        if links_here {
            backlinks.push(PageLinkEntry {
                title: page.title.clone(),
                path: Some(page.path.clone()),
                snippet: Some(build_snippet(&page.content, &current.title)),
            });
        }
    }

    outgoing.sort_by(|a, b| a.title.cmp(&b.title));
    outgoing.dedup_by(|a, b| a.path == b.path);
    backlinks.sort_by(|a, b| a.title.cmp(&b.title));
    missing.sort_by(|a, b| a.title.cmp(&b.title));
    missing.dedup_by(|a, b| a.title == b.title);
    Ok(PageLinksResponse {
        outgoing,
        backlinks,
        missing,
    })
}

/// Mirror `resolveRelatedSlug` in the frontend reader. Path-shaped links must
/// match their project-relative path exactly; bare links resolve by exact
/// filename after adding `.md`. Deliberately avoid title and fuzzy aliases so
/// the links panel never claims a target that the rendered page cannot open.
fn resolve_reader_wikilink<'a>(
    pages: &'a BTreeMap<String, GraphPage>,
    link: &str,
) -> Option<&'a String> {
    let link = link.trim().replace('\\', "/");
    if link.contains('/') {
        return pages.get_key_value(&link).map(|(path, _)| path);
    }
    let filename = if link.ends_with(".md") {
        link
    } else {
        format!("{link}.md")
    };
    pages.keys().find(|path| {
        std::path::Path::new(path.as_str())
            .file_name()
            .is_some_and(|name| name == filename.as_str())
    })
}

fn validate_query_embedding(embedding: Vec<f32>) -> Result<Vec<f32>, String> {
    if embedding.is_empty() {
        return Err("queryEmbedding must not be empty".to_string());
    }
    if embedding.iter().any(|v| !v.is_finite()) {
        return Err("queryEmbedding must contain only finite numbers".to_string());
    }
    Ok(embedding)
}

pub async fn search_project_inner(
    project_path: String,
    query: String,
    top_k: usize,
    include_content: bool,
    query_embedding: Option<Vec<f32>>,
) -> Result<ProjectSearchResponse, String> {
    search_with_evidence(project_path, query, top_k, include_content, query_embedding, None).await
}

/// 旧搜索接口仅适配返回结构；召回、融合和正文展开全部由统一核心执行。
pub async fn search_with_evidence(
    project_path: String, query: String, top_k: usize, include_content: bool,
    query_embedding: Option<Vec<f32>>, embedding_config: Option<SearchEmbeddingConfig>,
) -> Result<ProjectSearchResponse, String> {
    let query_terms = tokenize_query(&query);
    let config = embedding_config.or_else(|| query_embedding.as_ref().map(|_| SearchEmbeddingConfig {
        enabled: true, endpoint: String::new(), api_key: String::new(), model: String::new(),
        output_dimensionality: None, extra_headers: None, max_chunk_chars: None, overlap_chunk_chars: None,
    }));
    let result = evidence::retrieve(evidence::Request {
        project_path, scene: "search".into(), targets: vec![evidence::Target { id: "query".into(), text: query, title: None, path: None }],
        scope: None, channels: None, budget: None, checkpoint: None,
    }, config, query_embedding).await?;
    let mut results: Vec<ProjectSearchResult> = Vec::new();
    let mut token_hits = 0;
    let mut vector_hits = 0;
    let mut graph_hits = 0;
    for entry in result["evidence"].as_array().into_iter().flatten().take(top_k.clamp(1, 8)) {
        let sources = entry["retrievalSources"].as_array().cloned().unwrap_or_default();
        token_hits += usize::from(sources.iter().any(|source| source["channel"] == "keyword"));
        vector_hits += usize::from(sources.iter().any(|source| source["channel"] == "vector"));
        graph_hits += usize::from(sources.iter().any(|source| source["channel"] == "graph"));
        let content = entry["text"].as_str().unwrap_or_default().to_string();
        let score = 1.0 / (RRF_K + entry["ranks"]["query"].as_f64().unwrap_or(1.0));
        if let Some(existing) = results.iter_mut().find(|existing| Some(existing.path.as_str()) == entry["path"].as_str()) {
            if let Some(context) = existing.evidence_context.as_mut() { context["evidence"].as_array_mut().unwrap().push(entry.clone()); }
            if let Some(body) = existing.content.as_mut() { body.push_str("\n\n"); body.push_str(&content); }
            continue;
        }
        results.push(ProjectSearchResult {
            path: entry["path"].as_str().unwrap_or_default().into(), title: entry["title"].as_str().unwrap_or_default().into(),
            snippet: content.chars().take(600).collect(), title_match: entry["title"].as_str().is_some_and(|title| query_terms.iter().any(|term| title.to_lowercase().contains(term))), score, vector_score: None, images: extract_image_refs(&content),
            content: include_content.then_some(content), graph_related_to: Vec::new(),
            evidence_context: Some(json!({"evidence":[entry],"relations":result["relations"],"execution":result["execution"]})),
        });
    }
    Ok(ProjectSearchResponse { mode: search_mode(token_hits == 0, vector_hits, graph_hits).into(), results, token_hits, vector_hits, graph_hits, retrieval: Some(result) })
}

pub(crate) fn extract_graph_links(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let target = rest[..end].split('|').next().unwrap_or_default().trim();
        if !target.is_empty() {
            links.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    for related in extract_related_frontmatter(content) {
        if !links.contains(&related) {
            links.push(related);
        }
    }
    links
}

fn extract_related_frontmatter(content: &str) -> Vec<String> { extract_list_frontmatter(content, "related") }

fn extract_list_frontmatter(content: &str, key: &str) -> Vec<String> {
    let normalized = content.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return Vec::new();
    };
    let Some(end) = rest.find("\n---") else {
        return Vec::new();
    };
    let lines: Vec<&str> = rest[..end].lines().collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let Some(value) = line.trim().strip_prefix(&format!("{key}:")) else {
            index += 1;
            continue;
        };
        let value = value.trim();
        if value.starts_with('[') && value.ends_with(']') {
            for item in value[1..value.len() - 1].split(',') {
                if let Some(item) = normalize_related_value(item) {
                    out.push(item);
                }
            }
        } else if value.is_empty() {
            index += 1;
            while index < lines.len() {
                let trimmed = lines[index].trim();
                let Some(item) = trimmed.strip_prefix('-') else {
                    break;
                };
                if let Some(item) = normalize_related_value(item) {
                    out.push(item);
                }
                index += 1;
            }
            continue;
        }
        index += 1;
    }
    out
}

fn normalize_related_value(value: &str) -> Option<String> {
    let value = value.trim().trim_matches('"').trim_matches('\'').trim();
    let value = value
        .strip_prefix("[[")
        .and_then(|value| value.strip_suffix("]]"))
        .unwrap_or(value)
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn search_mode(token_rank_empty: bool, vector_hits: usize, graph_hits: usize) -> &'static str {
    if graph_hits > 0 {
        "hybrid"
    } else if vector_hits == 0 {
        "keyword"
    } else if token_rank_empty {
        "vector"
    } else {
        "hybrid"
    }
}



fn score_file(
    project_path: &str,
    path: &Path,
    content: &str,
    tokens: &[String],
    query_phrase: &str,
    query: &str,
    include_content: bool,
) -> Option<ProjectSearchResult> {
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let title = extract_title(content, file_name);
    let title_text = format!("{title} {file_name}");
    let title_lower = title_text.to_lowercase();
    let content_lower = content.to_lowercase();
    let stem = file_name.trim_end_matches(".md").to_lowercase();

    let filename_exact = !query_phrase.is_empty() && stem == query_phrase;
    let title_has_phrase = !query_phrase.is_empty() && title_lower.contains(query_phrase);
    let content_phrase_occ =
        count_occurrences(&content_lower, query_phrase).min(MAX_PHRASE_OCC_COUNTED);
    let title_token_score = token_match_score(&title_text, tokens);
    let content_token_score = token_match_score(content, tokens);

    if !filename_exact
        && !title_has_phrase
        && content_phrase_occ == 0
        && title_token_score == 0
        && content_token_score == 0
    {
        return None;
    }

    let score = (if filename_exact {
        FILENAME_EXACT_BONUS
    } else {
        0.0
    }) + (if title_has_phrase {
        PHRASE_IN_TITLE_BONUS
    } else {
        0.0
    }) + content_phrase_occ as f64 * PHRASE_IN_CONTENT_PER_OCC
        + title_token_score as f64 * TITLE_TOKEN_WEIGHT
        + content_token_score as f64 * CONTENT_TOKEN_WEIGHT;

    let snippet_anchor = if content_phrase_occ > 0 {
        query_phrase.to_string()
    } else {
        tokens
            .iter()
            .find(|token| content_lower.contains(token.as_str()))
            .cloned()
            .unwrap_or_else(|| query.to_string())
    };

    Some(ProjectSearchResult {
        path: relative_to_project(project_path, path),
        title,
        snippet: build_snippet(content, &snippet_anchor),
        title_match: title_token_score > 0 || title_has_phrase,
        score,
        vector_score: None,
        images: extract_image_refs(content),
        content: include_content.then_some(content.to_string()),
        graph_related_to: Vec::new(), evidence_context: None,
    })
}

pub fn tokenize_query(query: &str) -> Vec<String> {
    let raw = query
        .to_lowercase()
        .split(is_query_separator)
        .filter(|token| token.chars().count() > 1)
        .filter(|token| !is_stop_word(token))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    let mut out = Vec::new();
    for token in raw {
        let chars = token.chars().collect::<Vec<_>>();
        let has_cjk = chars.iter().any(|c| ('\u{3400}'..='\u{9fff}').contains(c));
        if has_cjk && chars.len() > 2 {
            for pair in chars.windows(2) {
                out.push(pair.iter().collect());
            }
            for ch in &chars {
                let s = ch.to_string();
                if !is_stop_word(&s) {
                    out.push(s);
                }
            }
            out.push(token);
        } else {
            out.push(token);
        }
    }
    out.into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn is_query_separator(c: char) -> bool {
    c.is_whitespace()
        || c.is_ascii_punctuation()
        || matches!(
            c,
            '，' | '。'
                | '！'
                | '？'
                | '、'
                | '；'
                | '：'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '（'
                | '）'
                | '·'
                | '～'
                | '…'
        )
}

fn is_stop_word(token: &str) -> bool {
    matches!(
        token,
        "的" | "是"
            | "了"
            | "什么"
            | "在"
            | "有"
            | "和"
            | "与"
            | "对"
            | "从"
            | "the"
            | "is"
            | "a"
            | "an"
            | "what"
            | "how"
            | "are"
            | "was"
            | "were"
            | "do"
            | "does"
            | "did"
            | "be"
            | "been"
            | "being"
            | "have"
            | "has"
            | "had"
            | "it"
            | "its"
            | "in"
            | "on"
            | "at"
            | "to"
            | "for"
            | "of"
            | "with"
            | "by"
            | "this"
            | "that"
            | "these"
            | "those"
    )
}

fn trim_query_punctuation(value: &str) -> String {
    value.trim_matches(is_query_separator).to_string()
}

fn token_match_score(text: &str, tokens: &[String]) -> usize {
    let lower = text.to_lowercase();
    tokens
        .iter()
        .filter(|token| lower.contains(token.as_str()))
        .count()
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.match_indices(needle).count()
}

pub fn extract_title(content: &str, file_name: &str) -> String {
    let has_frontmatter = content.starts_with("---");
    let mut in_frontmatter = has_frontmatter;
    let mut frontmatter_closed = false;
    for line in content.lines().skip(if has_frontmatter { 1 } else { 0 }) {
        let trimmed = line.trim();
        if in_frontmatter && trimmed == "---" {
            in_frontmatter = false;
            frontmatter_closed = true;
            continue;
        }
        if in_frontmatter && trimmed.starts_with("title:") {
            return trimmed
                .trim_start_matches("title:")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
        }
        if has_frontmatter && !frontmatter_closed {
            continue;
        }
        if let Some(title) = trimmed.strip_prefix("# ") {
            return title.trim().to_string();
        }
    }
    file_name.trim_end_matches(".md").replace('-', " ")
}

pub fn extract_image_refs(content: &str) -> Vec<SearchImageRef> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    let mut rest = content;
    while let Some(start) = rest.find("![") {
        rest = &rest[start + 2..];
        let Some(alt_end) = rest.find("](") else {
            break;
        };
        let alt = &rest[..alt_end];
        rest = &rest[alt_end + 2..];
        let Some(url_end) = rest.find(')') else {
            break;
        };
        let url = &rest[..url_end];
        if !url.trim().is_empty()
            && !url.contains(char::is_whitespace)
            && seen.insert(url.to_string())
        {
            out.push(SearchImageRef {
                url: url.to_string(),
                alt: alt.to_string(),
            });
        }
        rest = &rest[url_end + 1..];
    }
    out
}

pub(crate) async fn fetch_embedding_with_retry(
    text: &str,
    cfg: &SearchEmbeddingConfig,
    max_retries: usize,
) -> Result<Vec<f32>, String> {
    let mut current = text.to_string();
    let mut attempts = 0usize;
    loop {
        attempts += 1;
        match fetch_embedding_once(&current, cfg).await {
            Ok(embedding) => return Ok(embedding),
            Err(EmbeddingFetchError::Oversize(message)) => {
                if attempts <= max_retries
                    && current.len() > 64
                    && halve_text_on_char_boundary(&mut current)
                {
                    eprintln!(
                        "[Embedding] auto-halving after oversize error at {} chars; retrying at {} chars ({attempts}/{})",
                        text.chars().count(),
                        current.chars().count(),
                        max_retries + 1
                    );
                    continue;
                }
                return Err(format!(
                    "Endpoint rejected input even at {} chars. Lower Knowledge workflow -> Common settings -> Vector database -> Max Chunk Chars. {message}",
                    current.len()
                ));
            }
            Err(EmbeddingFetchError::Other(message)) => return Err(message),
        }
    }
}

pub(crate) async fn fetch_embedding_batch(
    texts: &[String],
    cfg: &SearchEmbeddingConfig,
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() || texts.len() > 64 {
        return Err("Embedding batch must contain between 1 and 64 inputs".to_string());
    }
    if is_google_embedding_config(cfg) || is_doubao_multimodal_embedding_config(cfg) {
        return Err(
            "This embedding provider does not use the OpenAI-compatible batch format".to_string(),
        );
    }

    let endpoint = volcengine_embedding_endpoint(cfg);
    let mut req = crate::proxy::configure_http_client(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(
            SEARCH_EMBEDDING_TIMEOUT_SECS,
        ))
        .build()
        .map_err(|e| format!("Embedding HTTP client error: {e}"))?
        .post(&endpoint)
        .header("Content-Type", "application/json");
    if is_local_or_private_http_endpoint(&endpoint) {
        req = req.header("Origin", "http://localhost");
    }
    if !cfg.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.api_key.trim());
    }
    if let Some(extra) = cfg.extra_headers.as_ref() {
        for (name, value) in extra {
            let name = name.trim();
            let value = value.trim();
            if !name.is_empty()
                && !value.is_empty()
                && is_safe_extra_header_name(name)
                && !is_reserved_extra_header_name(name)
            {
                req = req.header(name, value);
            }
        }
    }
    let response = req
        .json(&json!({ "model": cfg.model, "input": texts }))
        .send()
        .await
        .map_err(|e| format!("Embedding batch request failed: {e}"))?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Embedding batch response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Embedding batch API HTTP {status}: {}",
            response_text.chars().take(200).collect::<String>()
        ));
    }
    let data: Value = serde_json::from_str(&response_text).map_err(|e| {
        format!(
            "Embedding batch response parse failed: {e}: {}",
            response_text.chars().take(200).collect::<String>()
        )
    })?;
    parse_embedding_batch_values(&data, texts.len())
}

pub(crate) fn supports_embedding_batch(cfg: &SearchEmbeddingConfig) -> bool {
    !is_google_embedding_config(cfg) && !is_doubao_multimodal_embedding_config(cfg)
}

fn parse_embedding_batch_values(data: &Value, expected: usize) -> Result<Vec<Vec<f32>>, String> {
    let entries = data
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Embedding batch response missing data array".to_string())?;
    if entries.len() != expected {
        return Err(format!(
            "Embedding batch returned {} vectors for {expected} inputs",
            entries.len()
        ));
    }
    let mut indexed = Vec::with_capacity(entries.len());
    for (position, entry) in entries.iter().enumerate() {
        let index = entry
            .get("index")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(position);
        if index >= expected {
            return Err("Embedding batch response contains an out-of-range index".to_string());
        }
        let values = entry
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| "Embedding batch response missing vector".to_string())?;
        let mut vector = Vec::with_capacity(values.len());
        for value in values {
            let number = value
                .as_f64()
                .ok_or_else(|| "Embedding batch response contains non-number values".to_string())?;
            if !number.is_finite() {
                return Err("Embedding batch response contains non-finite values".to_string());
            }
            vector.push(number as f32);
        }
        if vector.is_empty() {
            return Err("Embedding batch response vector is empty".to_string());
        }
        indexed.push((index, vector));
    }
    indexed.sort_by_key(|(index, _)| *index);
    if indexed.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err("Embedding batch response contains duplicate indexes".to_string());
    }
    let dimension = indexed.first().map(|(_, vector)| vector.len()).unwrap_or(0);
    if indexed.iter().any(|(_, vector)| vector.len() != dimension) {
        return Err("Embedding batch response contains inconsistent vector dimensions".to_string());
    }
    Ok(indexed.into_iter().map(|(_, vector)| vector).collect())
}

fn halve_text_on_char_boundary(text: &mut String) -> bool {
    let char_count = text.chars().count();
    if char_count <= 1 {
        return false;
    }
    let keep = (char_count / 2).max(1);
    *text = text.chars().take(keep).collect();
    true
}

enum EmbeddingFetchError {
    Oversize(String),
    Other(String),
}

async fn fetch_embedding_once(
    text: &str,
    cfg: &SearchEmbeddingConfig,
) -> Result<Vec<f32>, EmbeddingFetchError> {
    let is_google = is_google_embedding_config(cfg);
    let is_doubao_multimodal = is_doubao_multimodal_embedding_config(cfg);
    let endpoint = if is_google {
        google_embedding_endpoint(cfg)
    } else {
        volcengine_embedding_endpoint(cfg)
    };
    let mut req = crate::proxy::configure_http_client(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(
            SEARCH_EMBEDDING_TIMEOUT_SECS,
        ))
        .build()
        .map_err(|e| EmbeddingFetchError::Other(format!("Embedding HTTP client error: {e}")))?
        .post(&endpoint)
        .header("Content-Type", "application/json");
    // Browser-based local model servers often require a browser-like
    // Origin even when the request is routed through Rust. Keep this
    // reserved so user-supplied extra headers cannot override it.
    if is_local_or_private_http_endpoint(&endpoint) {
        req = req.header("Origin", "http://localhost");
    }
    if !cfg.api_key.trim().is_empty() {
        if is_google {
            req = req.header("x-goog-api-key", cfg.api_key.trim());
        } else {
            req = req.bearer_auth(cfg.api_key.trim());
        }
    }
    if let Some(extra) = cfg.extra_headers.as_ref() {
        for (name, value) in extra {
            let trimmed = name.trim();
            let value = value.trim();
            if trimmed.is_empty() || value.is_empty() || !is_safe_extra_header_name(trimmed) {
                continue;
            }
            if is_reserved_extra_header_name(trimmed) {
                continue;
            }
            req = req.header(trimmed, value);
        }
    }
    let body = if is_google {
        google_embedding_body(&cfg.model, text, cfg.output_dimensionality)
    } else if is_doubao_multimodal {
        doubao_multimodal_embedding_body(&cfg.model, text)
    } else {
        json!({ "model": cfg.model, "input": text })
    };
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| EmbeddingFetchError::Other(format!("Embedding request failed: {e}")))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| EmbeddingFetchError::Other(format!("Embedding response read failed: {e}")))?;
    if !status.is_success() {
        let preview = text.chars().take(200).collect::<String>();
        if looks_like_oversize_error(status.as_u16(), &text) {
            return Err(EmbeddingFetchError::Oversize(format!(
                "Embedding API HTTP {status}: {preview}"
            )));
        }
        return Err(EmbeddingFetchError::Other(format!(
            "Embedding API HTTP {status}: {preview}"
        )));
    }
    let data: Value = serde_json::from_str(&text).map_err(|e| {
        EmbeddingFetchError::Other(format!(
            "Embedding response parse failed: {e}: {}",
            text.chars().take(200).collect::<String>()
        ))
    })?;
    parse_embedding_values(&data, is_google, is_doubao_multimodal)
        .map_err(EmbeddingFetchError::Other)
}

fn looks_like_oversize_error(status: u16, body: &str) -> bool {
    if status == 413 {
        return true;
    }
    let lower = body.to_lowercase();
    lower.contains("too long")
        || lower.contains("maximum context")
        || lower.contains("max_tokens")
        || lower.contains("max tokens")
        || lower.contains("context length")
        || lower.contains("token limit")
        || lower.contains("exceeds")
        || lower.contains("input length")
}

fn parse_embedding_values(
    data: &Value,
    is_google: bool,
    is_doubao_multimodal: bool,
) -> Result<Vec<f32>, String> {
    let values = if is_google {
        data.get("embedding")
            .and_then(|v| v.get("values"))
            .and_then(Value::as_array)
    } else if is_doubao_multimodal {
        data.get("data")
            .and_then(|v| v.get("embedding"))
            .and_then(Value::as_array)
    } else {
        data.get("data")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|v| v.get("embedding"))
            .and_then(Value::as_array)
    }
    .ok_or_else(|| "Embedding response missing vector".to_string())?;
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        let n = value
            .as_f64()
            .ok_or_else(|| "Embedding response contains non-number values".to_string())?;
        if !n.is_finite() {
            return Err("Embedding response contains non-finite values".to_string());
        }
        out.push(n as f32);
    }
    if out.is_empty() {
        return Err("Embedding response vector is empty".to_string());
    }
    Ok(out)
}

fn is_safe_extra_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            matches!(
                b,
                b'!' | b'#'
                    | b'$'
                    | b'%'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'+'
                    | b'-'
                    | b'.'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'|'
                    | b'~'
                    | b'0'..=b'9'
                    | b'A'..=b'Z'
                    | b'a'..=b'z'
            )
        })
}

fn is_reserved_extra_header_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "authorization" | "content-type" | "host" | "content-length" | "origin" | "x-goog-api-key"
    )
}

fn is_google_embedding_config(cfg: &SearchEmbeddingConfig) -> bool {
    let endpoint = cfg.endpoint.to_lowercase();
    endpoint.contains("generativelanguage.googleapis.com") || endpoint.contains(":embedcontent")
}

fn is_local_or_private_http_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_matches('[')
        .trim_matches(']')
        .to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    let octets = host
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(octets) = octets else {
        return false;
    };
    if octets.len() != 4 {
        return false;
    }
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
        || octets[0] == 127
}

fn is_volcengine_embedding_endpoint(endpoint: &str) -> bool {
    let host = reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_lowercase()))
        .unwrap_or_else(|| {
            let trimmed = endpoint.trim();
            trimmed
                .split_once("://")
                .map(|(_, rest)| rest)
                .unwrap_or(trimmed)
                .split(['/', '?', '#'])
                .next()
                .unwrap_or("")
                .to_lowercase()
        });
    host == "volces.com" || host.ends_with(".volces.com") || host.contains("volcengine")
}

fn is_doubao_multimodal_embedding_config(cfg: &SearchEmbeddingConfig) -> bool {
    cfg.model
        .trim()
        .to_lowercase()
        .contains("doubao-embedding-vision")
}

fn volcengine_embedding_endpoint(cfg: &SearchEmbeddingConfig) -> String {
    let raw = cfg.endpoint.trim();
    if !is_volcengine_embedding_endpoint(raw) {
        return raw.to_string();
    }
    let suffix = if is_doubao_multimodal_embedding_config(cfg) {
        "/embeddings/multimodal"
    } else {
        "/embeddings"
    };
    append_endpoint_path(raw, suffix)
}

fn append_endpoint_path(endpoint: &str, target_suffix: &str) -> String {
    let suffix = target_suffix.trim_start_matches('/');
    match reqwest::Url::parse(endpoint) {
        Ok(mut url) => {
            let path = url.path().trim_end_matches('/').to_string();
            let lower_path = path.to_lowercase();
            let lower_suffix = format!("/{}", suffix.to_lowercase());
            if lower_path.ends_with(&lower_suffix) {
                url.set_path(if path.is_empty() { "/" } else { &path });
                return url.to_string();
            }
            if lower_path.ends_with("/embeddings/multimodal") && lower_suffix == "/embeddings" {
                let base = path.trim_end_matches("/multimodal");
                url.set_path(if base.is_empty() { "/" } else { base });
                return url.to_string();
            }
            if lower_path.ends_with("/embeddings") && lower_suffix == "/embeddings/multimodal" {
                url.set_path(&format!("{path}/multimodal"));
                return url.to_string();
            }
            let next = format!("{path}/{suffix}").replace("//", "/");
            url.set_path(&next);
            url.to_string()
        }
        Err(_) => {
            let (base, query) = endpoint.split_once('?').unwrap_or((endpoint, ""));
            let trimmed = base.trim_end_matches('/');
            let lower = trimmed.to_lowercase();
            let lower_suffix = format!("/{}", suffix.to_lowercase());
            let next = if lower.ends_with(&lower_suffix) {
                trimmed.to_string()
            } else if lower.ends_with("/embeddings/multimodal") && lower_suffix == "/embeddings" {
                trimmed.trim_end_matches("/multimodal").to_string()
            } else if lower.ends_with("/embeddings") && lower_suffix == "/embeddings/multimodal" {
                format!("{trimmed}/multimodal")
            } else {
                format!("{trimmed}/{suffix}")
            };
            if query.is_empty() {
                next
            } else {
                format!("{next}?{query}")
            }
        }
    }
}

fn google_embedding_endpoint(cfg: &SearchEmbeddingConfig) -> String {
    let raw = strip_google_api_key_query(cfg.endpoint.trim())
        .trim_end_matches('/')
        .to_string();
    if raw.to_lowercase().contains(":batchembedcontents") {
        return raw
            .replace(":batchEmbedContents", ":embedContent")
            .replace(":batchembedcontents", ":embedContent");
    }
    if raw.to_lowercase().contains(":embedcontent") {
        return raw;
    }
    let model = cfg.model.trim().trim_start_matches("models/");
    if raw.to_lowercase().contains("/models/") {
        format!("{raw}:embedContent")
    } else {
        format!("{raw}/models/{model}:embedContent")
    }
}

fn strip_google_api_key_query(endpoint: &str) -> String {
    if !endpoint.contains('?') {
        return endpoint.to_string();
    }
    match reqwest::Url::parse(endpoint) {
        Ok(mut url) => {
            let kept = url
                .query_pairs()
                .filter(|(key, _)| !key.eq_ignore_ascii_case("key"))
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>();
            url.query_pairs_mut().clear().extend_pairs(kept);
            url.to_string().trim_end_matches('?').to_string()
        }
        Err(_) => endpoint
            .split_once('?')
            .map(|(base, query)| {
                let kept = query
                    .split('&')
                    .filter(|pair| {
                        let key = pair.split_once('=').map(|(k, _)| k).unwrap_or(*pair);
                        !key.eq_ignore_ascii_case("key")
                    })
                    .collect::<Vec<_>>();
                if kept.is_empty() {
                    base.to_string()
                } else {
                    format!("{base}?{}", kept.join("&"))
                }
            })
            .unwrap_or_else(|| endpoint.to_string()),
    }
}

fn google_embedding_body(model: &str, text: &str, output_dimensionality: Option<f64>) -> Value {
    let model_path = if model.trim().starts_with("models/") {
        model.trim().to_string()
    } else {
        format!("models/{}", model.trim())
    };
    let mut body = json!({
        "model": model_path,
        "content": { "parts": [{ "text": text }] },
    });
    if let Some(dim) = output_dimensionality
        .filter(|dim| dim.is_finite() && *dim >= 1.0)
        .map(|dim| dim.floor() as u32)
    {
        body["output_dimensionality"] = json!(dim);
    }
    body
}

fn doubao_multimodal_embedding_body(model: &str, text: &str) -> Value {
    json!({
        "model": model,
        "encoding_format": "float",
        "input": [{ "type": "text", "text": text }],
    })
}

pub fn build_snippet(content: &str, query: &str) -> String {
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
    let idx = lower.find(&q).unwrap_or(0);
    let char_positions: Vec<usize> = content.char_indices().map(|(idx, _)| idx).collect();
    if char_positions.is_empty() {
        return String::new();
    }
    let match_char = char_positions
        .iter()
        .position(|byte| *byte >= idx)
        .unwrap_or(char_positions.len().saturating_sub(1));
    let query_chars = query.chars().count().max(1);
    let start_char = match_char.saturating_sub(SNIPPET_CONTEXT);
    let end_char = (match_char + query_chars + SNIPPET_CONTEXT).min(char_positions.len());
    let start = char_positions[start_char];
    let end = if end_char < char_positions.len() {
        char_positions[end_char]
    } else {
        content.len()
    };
    let mut snippet = content[start..end].replace('\n', " ");
    if start > 0 {
        snippet = format!("...{snippet}");
    }
    if end < content.len() {
        snippet.push_str("...");
    }
    snippet
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn relative_to_project(project_path: &str, path: &Path) -> String {
    let root = Path::new(project_path);
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn vector_page_id(path: &str) -> Option<String> {
    let normalized = normalize_path(path);
    let wiki_relative = normalized.strip_prefix("wiki/").unwrap_or(&normalized);
    if wiki_relative.len() < 3
        || !wiki_relative[wiki_relative.len() - 3..].eq_ignore_ascii_case(".md")
    {
        return None;
    }
    let id = wiki_relative[..wiki_relative.len() - 3].trim_matches('/');
    (!id.is_empty()).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_project() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("llm-wiki-search-test-{id}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(path.join("wiki/concepts")).unwrap();
        path
    }

    fn write_page(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }


    #[test]
    fn tokenizes_cjk_bigrams_and_chars() {
        let tokens = tokenize_query("默会知识");
        assert!(tokens.contains(&"默会".to_string()));
        assert!(tokens.contains(&"知识".to_string()));
        assert!(tokens.contains(&"默".to_string()));
    }

    #[test]
    fn extracts_image_refs_without_duplicates() {
        let refs = extract_image_refs("![a](wiki/media/x.png)\n![b](wiki/media/x.png)");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].alt, "a");
    }

    #[test]
    fn graph_links_include_frontmatter_related_and_dedupe_body_links() {
        let links = extract_graph_links("---\nrelated: [foo, \"[[bar]]\"]\n---\n# Page\n[[foo]]");
        assert_eq!(links, vec!["bar", "foo"]);

        let block_links = extract_graph_links(
            "---\r\nrelated:\r\n  - wiki/entities/alpha.md\r\n  - beta\r\n---\r\n# Page",
        );
        assert_eq!(block_links, vec!["wiki/entities/alpha.md", "beta"]);
    }

    #[test]
    fn extract_title_uses_frontmatter_or_heading_not_body_title_lines() {
        let with_frontmatter = "---\ntitle: Real Title\n---\n\ntitle: Body Label\n# Heading";
        assert_eq!(
            extract_title(with_frontmatter, "fallback-name.md"),
            "Real Title"
        );

        let without_frontmatter = "intro\ntitle: Body Label\n# Real Heading";
        assert_eq!(
            extract_title(without_frontmatter, "fallback-name.md"),
            "Real Heading"
        );

        assert_eq!(
            extract_title("plain body", "vector-database.md"),
            "vector database"
        );
    }

    #[test]
    fn explicit_query_embedding_is_validated() {
        assert!(validate_query_embedding(vec![0.1, 0.2]).is_ok());
        assert!(validate_query_embedding(vec![]).is_err());
        assert!(validate_query_embedding(vec![f32::NAN]).is_err());
        assert!(validate_query_embedding(vec![f32::INFINITY]).is_err());
    }

    #[test]
    fn google_embedding_endpoint_strips_key_and_normalizes_batch_endpoint() {
        let cfg = SearchEmbeddingConfig {
            enabled: true,
            endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=URL_KEY&alt=json".to_string(),
            api_key: "HEADER_KEY".to_string(),
            model: "gemini-embedding-001".to_string(),
            output_dimensionality: Some(768.0),
            extra_headers: None,
            max_chunk_chars: None,
            overlap_chunk_chars: None,
        };

        let endpoint = google_embedding_endpoint(&cfg);
        assert!(endpoint.contains(":embedContent"));
        assert!(!endpoint.contains(":batchEmbedContents"));
        assert!(!endpoint.contains("URL_KEY"));
        assert!(endpoint.contains("alt=json"));

        let body = google_embedding_body("gemini-embedding-001", "hello", Some(768.0));
        assert_eq!(body["model"], "models/gemini-embedding-001");
        assert_eq!(body["output_dimensionality"], 768);
    }

    #[test]
    fn volcengine_embedding_endpoint_only_appends_for_volcengine_hosts() {
        let cfg = SearchEmbeddingConfig {
            enabled: true,
            endpoint: "https://ark.cn-beijing.volces.com/api/v3".to_string(),
            api_key: "ARK_KEY".to_string(),
            model: "doubao-embedding-text-240715".to_string(),
            output_dimensionality: None,
            extra_headers: None,
            max_chunk_chars: None,
            overlap_chunk_chars: None,
        };
        assert_eq!(
            volcengine_embedding_endpoint(&cfg),
            "https://ark.cn-beijing.volces.com/api/v3/embeddings"
        );

        let custom = SearchEmbeddingConfig {
            endpoint: "https://gateway.example.com/proxy/volcengine?upstream=volces.com"
                .to_string(),
            ..cfg.clone()
        };
        assert_eq!(
            volcengine_embedding_endpoint(&custom),
            "https://gateway.example.com/proxy/volcengine?upstream=volces.com"
        );
    }

    #[test]
    fn doubao_multimodal_endpoint_and_body_use_vision_shape() {
        let cfg = SearchEmbeddingConfig {
            enabled: true,
            endpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings?trace=1".to_string(),
            api_key: "ARK_KEY".to_string(),
            model: "doubao-embedding-vision".to_string(),
            output_dimensionality: None,
            extra_headers: None,
            max_chunk_chars: None,
            overlap_chunk_chars: None,
        };

        assert_eq!(
            volcengine_embedding_endpoint(&cfg),
            "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal?trace=1"
        );

        let body = doubao_multimodal_embedding_body("doubao-embedding-vision", "hello");
        assert_eq!(body["model"], "doubao-embedding-vision");
        assert_eq!(body["encoding_format"], "float");
        assert_eq!(body["input"][0]["type"], "text");
        assert_eq!(body["input"][0]["text"], "hello");
    }

    #[test]
    fn volcengine_embedding_endpoint_does_not_duplicate_existing_suffixes() {
        let cfg = SearchEmbeddingConfig {
            enabled: true,
            endpoint: "https://ARK.cn-beijing.volces.com/api/v3/embeddings".to_string(),
            api_key: "ARK_KEY".to_string(),
            model: "doubao-embedding-text-240715".to_string(),
            output_dimensionality: None,
            extra_headers: None,
            max_chunk_chars: None,
            overlap_chunk_chars: None,
        };
        assert_eq!(
            volcengine_embedding_endpoint(&cfg),
            "https://ark.cn-beijing.volces.com/api/v3/embeddings"
        );

        let vision = SearchEmbeddingConfig {
            endpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal".to_string(),
            model: "doubao-embedding-vision".to_string(),
            ..cfg.clone()
        };
        assert_eq!(
            volcengine_embedding_endpoint(&vision),
            "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal"
        );

        let text_on_multimodal_endpoint = SearchEmbeddingConfig {
            model: "doubao-embedding-text-240715".to_string(),
            ..vision
        };
        assert_eq!(
            volcengine_embedding_endpoint(&text_on_multimodal_endpoint),
            "https://ark.cn-beijing.volces.com/api/v3/embeddings"
        );
    }

    #[test]
    fn doubao_multimodal_detection_is_model_driven_for_custom_gateways() {
        let cfg = SearchEmbeddingConfig {
            enabled: true,
            endpoint: "https://gateway.example.com/ark/embeddings/multimodal".to_string(),
            api_key: "KEY".to_string(),
            model: "doubao-embedding-vision".to_string(),
            output_dimensionality: None,
            extra_headers: None,
            max_chunk_chars: None,
            overlap_chunk_chars: None,
        };

        assert!(is_doubao_multimodal_embedding_config(&cfg));
        assert_eq!(
            volcengine_embedding_endpoint(&cfg),
            "https://gateway.example.com/ark/embeddings/multimodal"
        );

        let body = doubao_multimodal_embedding_body(&cfg.model, "hello");
        assert_eq!(body["input"][0]["type"], "text");
        assert_eq!(body["input"][0]["text"], "hello");
    }

    #[test]
    fn doubao_multimodal_response_shape_is_distinct_from_openai_shape() {
        let values =
            parse_embedding_values(&json!({ "data": { "embedding": [0.1, 0.2] } }), false, true)
                .expect("vision response should parse");
        assert_eq!(values, vec![0.1, 0.2]);

        assert!(
            parse_embedding_values(&json!({ "data": [{ "embedding": [0.1] }] }), false, true,)
                .is_err()
        );
    }

    #[test]
    fn extra_embedding_header_names_are_validated_and_reserved_names_are_skipped() {
        assert!(is_safe_extra_header_name("X-Model-Provider-Id"));
        assert!(is_safe_extra_header_name("x_trace.id"));
        assert!(!is_safe_extra_header_name(""));
        assert!(!is_safe_extra_header_name("Bad Header"));
        assert!(!is_safe_extra_header_name("中文"));

        assert!(is_reserved_extra_header_name("Authorization"));
        assert!(is_reserved_extra_header_name("content-type"));
        assert!(is_reserved_extra_header_name("Origin"));
        assert!(is_reserved_extra_header_name("X-Goog-Api-Key"));
        assert!(!is_reserved_extra_header_name("X-Model-Provider-Id"));
    }

    #[test]
    fn embedding_origin_header_is_limited_to_local_or_private_endpoints() {
        assert!(is_local_or_private_http_endpoint(
            "http://127.0.0.1:1234/v1/embeddings"
        ));
        assert!(is_local_or_private_http_endpoint(
            "http://192.168.1.20:11434/v1/embeddings"
        ));
        assert!(is_local_or_private_http_endpoint(
            "http://172.16.0.5/v1/embeddings"
        ));
        assert!(!is_local_or_private_http_endpoint(
            "https://api.openai.com/v1/embeddings"
        ));
    }

    #[test]
    fn embedding_halving_never_splits_cjk_codepoints() {
        let mut text = "默会知识库".to_string();
        assert!(halve_text_on_char_boundary(&mut text));
        assert_eq!(text, "默会");
    }

    #[test]
    fn google_embedding_body_floors_positive_dimensions_and_omits_invalid_values() {
        let body = google_embedding_body("gemini-embedding-001", "hello", Some(1.9));
        assert_eq!(body["output_dimensionality"], 1);

        let zero = google_embedding_body("gemini-embedding-001", "hello", Some(0.0));
        assert!(zero.get("output_dimensionality").is_none());

        let negative = google_embedding_body("gemini-embedding-001", "hello", Some(-4.0));
        assert!(negative.get("output_dimensionality").is_none());
    }

    #[test]
    fn search_mode_distinguishes_keyword_vector_and_hybrid() {
        assert_eq!(search_mode(false, 0, 0), "keyword");
        assert_eq!(search_mode(true, 3, 0), "vector");
        assert_eq!(search_mode(false, 3, 0), "hybrid");
        assert_eq!(search_mode(false, 0, 1), "hybrid");
    }

    #[tokio::test]
    async fn keyword_search_prefers_filename_exact_match() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/attention.md",
            "---\ntitle: Attention\n---\n\n# Attention\n\nbody about attention.",
        );
        write_page(
            &root,
            "wiki/concepts/random.md",
            "---\ntitle: Random\n---\n\n# Random\n\nattention is mentioned briefly.",
        );

        let out = search_project_inner(
            root.to_string_lossy().to_string(),
            "attention".into(),
            20,
            false,
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.mode, "keyword");
        assert_eq!(out.results[0].title, "Attention");
        assert!(out.results[0].score > 0.0);
        assert!(out.results[0].evidence_context.is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn keyword_search_does_not_force_unrelated_graph_neighbors() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/agent.md",
            "---\ntitle: Agent Runtime\n---\n\n# Agent Runtime\n\nagent runtime details. [[Tool Registry]]",
        );
        write_page(
            &root,
            "wiki/concepts/tool-registry.md",
            "---\ntitle: Tool Registry\n---\n\n# Tool Registry\n\nDefines callable tools.",
        );
        write_page(
            &root,
            "wiki/concepts/unrelated.md",
            "---\ntitle: Unrelated\n---\n\n# Unrelated\n\nNo graph connection.",
        );

        let out = search_project_inner(
            root.to_string_lossy().to_string(),
            "agent runtime".into(),
            10,
            false,
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.mode, "keyword");
        assert_eq!(out.graph_hits, 0);
        assert!(out
            .results
            .iter()
            .any(|result| result.title == "Agent Runtime"));
        assert!(!out.results.iter().any(|result| result.title == "Tool Registry"));
        assert!(!out.results.iter().any(|result| result.title == "Unrelated"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn page_links_resolve_outgoing_backlinks_and_missing_targets() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/Alpha.md",
            "---\ntitle: Alpha\n---\n# Alpha\n\n[[Beta|label]], [[Alpha]], [[Title Only]], and [[Missing Page]].",
        );
        write_page(
            &root,
            "wiki/concepts/Beta.md",
            "---\ntitle: Beta\n---\n# Beta\n\nBeta details.",
        );
        write_page(
            &root,
            "wiki/concepts/different-filename.md",
            "---\ntitle: Title Only\n---\n# Title Only\n",
        );
        write_page(
            &root,
            "wiki/concepts/gamma.md",
            "---\ntitle: Gamma\n---\n# Gamma\n\nGamma references [[Alpha]] here.",
        );

        let links = get_page_links_inner(
            root.to_str().unwrap(),
            root.join("wiki/concepts/Alpha.md").to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(links.outgoing.len(), 1);
        assert_eq!(links.outgoing[0].title, "Beta");
        assert_eq!(links.backlinks.len(), 1);
        assert_eq!(links.backlinks[0].title, "Gamma");
        assert!(links.backlinks[0]
            .snippet
            .as_deref()
            .unwrap()
            .contains("Alpha"));
        assert_eq!(links.missing.len(), 2);
        assert!(links
            .missing
            .iter()
            .any(|entry| entry.title == "Missing Page"));
        assert!(links
            .missing
            .iter()
            .any(|entry| entry.title == "Title Only"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn page_links_require_markdown_input_and_exact_reader_paths() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/current.md",
            "[[wiki/concepts/target.md]] [[target#section]]",
        );
        write_page(&root, "wiki/concepts/target.md", "# Target");
        write_page(&root, "wiki/concepts/not-markdown.txt", "text");

        let links = get_page_links_inner(
            root.to_str().unwrap(),
            root.join("wiki/concepts/current.md").to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(links.outgoing.len(), 1);
        assert_eq!(
            links.outgoing[0].path.as_deref(),
            Some("wiki/concepts/target.md")
        );
        assert_eq!(links.missing.len(), 1);
        assert_eq!(links.missing[0].title, "target#section");

        let error = get_page_links_inner(
            root.to_str().unwrap(),
            root.join("wiki/concepts/not-markdown.txt")
                .to_str()
                .unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("Markdown"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn keyword_search_handles_cjk_bigram_queries() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/tacit.md",
            "---\ntitle: 默会知识\n---\n\n# 默会知识\n\n默会知识强调难以言明的实践经验。",
        );

        let out = search_project_inner(
            root.to_string_lossy().to_string(),
            "默会知识".into(),
            20,
            false,
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.results[0].title, "默会知识");
        assert!(out.results[0].snippet.contains("默会知识"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn keyword_search_phrase_in_content_beats_scattered_tokens() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/phrase.md",
            "---\ntitle: Phrase\n---\n\n# Phrase\n\nThe phrase vector database appears together.",
        );
        write_page(
            &root,
            "wiki/concepts/scattered.md",
            "---\ntitle: Scattered\n---\n\n# Scattered\n\nvector appears here. database appears later.",
        );

        let out = search_project_inner(
            root.to_string_lossy().to_string(),
            "vector database".into(),
            20,
            false,
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.results[0].title, "Phrase");
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn source_content_search_ranks_and_snippets_raw_sources() {
        let root = tmp_project();
        write_page(
            &root,
            "raw/sources/dev/framework.md",
            "# 框架\n\nMDD 是元数据驱动的开发框架，MDD 强调模型优先。",
        );
        write_page(&root, "raw/sources/dev/binary.pdf", "not searchable");
        write_page(&root, "raw/sources/dev/other.md", "# 无关\n\n内容没有关键词。");
        write_page(
            &root,
            "raw/sources/dev/mention.md",
            "# 提及\n\n这里只提了一次 MDD。",
        );

        let hits = search_source_content_inner(
            root.to_str().unwrap(),
            "MDD 开发框架",
            10,
        )
        .unwrap();

        assert_eq!(hits.len(), 2);
        // 短语多次命中的文件排在前面
        assert!(hits[0].path.ends_with("framework.md"));
        assert!(hits[0].snippet.contains("MDD"));
        assert!(hits.iter().all(|hit| !hit.path.ends_with(".pdf")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_openai_batch_vectors_in_input_order() {
        let response = json!({
            "data": [
                { "index": 1, "embedding": [2.0, 2.5] },
                { "index": 0, "embedding": [1.0, 1.5] }
            ]
        });
        let vectors = parse_embedding_batch_values(&response, 2).unwrap();
        assert_eq!(vectors, vec![vec![1.0, 1.5], vec![2.0, 2.5]]);
    }

    #[test]
    fn rejects_duplicate_openai_batch_indexes() {
        let response = json!({
            "data": [
                { "index": 0, "embedding": [1.0] },
                { "index": 0, "embedding": [2.0] }
            ]
        });
        assert!(parse_embedding_batch_values(&response, 2)
            .unwrap_err()
            .contains("duplicate"));
    }
}
