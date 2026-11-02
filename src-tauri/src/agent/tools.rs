use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::fs::OpenOptions;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use walkdir::WalkDir;

use crate::commands::external_search::file_url_for_path;
use crate::commands::search::{self, SearchEmbeddingConfig};

use super::types::{AgentKnowledgeContext, AgentReference, AgentVersionSummary};
use super::workspace::{agent_workspace_path, AGENT_WORKSPACE_DIR};

// Tool I/O limits are backend security boundaries. Do not relax them only in
// the UI: API and MCP callers can invoke the same tools without going through
// React components.
const MAX_READ_PAGE_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_WRITE_PAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_WORKSPACE_WRITE_BYTES: usize = 2 * 1024 * 1024;
// Rollback snapshots are sent to the trusted desktop UI only for the current
// process lifetime. Bound them independently from write size so a large Agent
// artifact cannot multiply IPC and in-memory chat costs merely to enable Undo.
const MAX_WORKSPACE_ROLLBACK_BYTES: u64 = 512 * 1024;
const MAX_GRAPH_SEARCH_FILES: usize = 10_000;
const WEB_SEARCH_TIMEOUT_SECS: u64 = 30;
const SHELL_EXEC_TIMEOUT_SECS: u64 = 30;
const MAX_SHELL_COMMAND_CHARS: usize = 4_000;
const MAX_SHELL_OUTPUT_CHARS: usize = 20_000;
const MAX_SHELL_GENERATED_FILES: usize = 50;
const SHELL_OUTPUT_DRAIN_TIMEOUT_SECS: u64 = 1;
const DEFAULT_ANYTXT_ENDPOINT: &str = "http://127.0.0.1:9920";
const DEFAULT_ANYTXT_LIMIT: usize = 20;
const ANYTXT_LAST_MODIFY_END: i64 = 2_147_483_647;
static WIKI_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolEffect {
    Read,
    Write,
    Network,
    Process,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub effects: Vec<ToolEffect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
}

#[allow(dead_code)]
pub trait AgentTool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn execute<'a>(
        &'a self,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
}

pub trait ToolRegistry {
    #[allow(dead_code)]
    fn specs(&self) -> Vec<ToolSpec>;
    fn execute<'a>(
        &'a self,
        name: &'a str,
        input: Value,
        context: ToolContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct BuiltinToolRegistry;

#[derive(Clone)]
pub struct ToolContext<'a> {
    pub project_path: &'a str,
    /// 审阅身份由请求上下文提供，不能由模型工具参数选择写入方式。
    pub review_conversation: bool,
    pub embedding_config: Option<SearchEmbeddingConfig>,
    pub web_search_config: Option<WebSearchConfig>,
    pub anytxt_config: Option<AnyTxtConfig>,
}

impl ToolRegistry for BuiltinToolRegistry {
    fn specs(&self) -> Vec<ToolSpec> {
        builtin_tool_specs()
    }

    fn execute<'a>(
        &'a self,
        name: &'a str,
        input: Value,
        context: ToolContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async move {
            match name {
                "wiki.write_page" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "wiki.write_page requires path".to_string())?;
                    let content = input
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "wiki.write_page requires content".to_string())?;
                    let output = if context.review_conversation {
                        write_wiki_page_at_revision(
                            context.project_path,
                            path,
                            content,
                            input
                                .get("allowOverwrite")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            input.get("expectedRevision").and_then(Value::as_str),
                        )?
                    } else {
                        super::ingest::submit_conversation_ingest(context.project_path, path, content)?
                    };
                    serde_json::to_value(output)
                        .map_err(|err| format!("Failed to serialize wiki.write_page result: {err}"))
                }
                "wiki.patch_page" => {
                    if !context.review_conversation {
                        return Err("wiki.patch_page 仅用于审阅会话的已授权修改；普通会话请使用 wiki.write_page 提交入库".into());
                    }
                    let request: WikiPatchRequest = serde_json::from_value(input)
                        .map_err(|error| format!("wiki.patch_page 参数无效：{error}"))?;
                    let output = patch_wiki_page(context.project_path, request)?;
                    serde_json::to_value(output).map_err(|error| error.to_string())
                }
                "wiki.list_pages" => {
                    let request = serde_json::from_value(input).map_err(|e| format!("wiki.list_pages 参数无效：{e}"))?;
                    serde_json::to_value(super::wiki_files::list_pages(context.project_path, request)?).map_err(|e| e.to_string())
                }
                "source.read_file" => {
                    let request = serde_json::from_value(input).map_err(|e| format!("source.read_file 参数无效：{e}"))?;
                    serde_json::to_value(super::wiki_files::read_source(context.project_path, request)?).map_err(|e| e.to_string())
                }
                "wiki.move_page" => {
                    let request = serde_json::from_value(input).map_err(|e| format!("wiki.move_page 参数无效：{e}"))?;
                    let output = super::wiki_move::move_wiki_page(context.project_path.into(), request, context.embedding_config).await?;
                    serde_json::to_value(output).map_err(|e| e.to_string())
                }
                "wiki.delete_page" => {
                    let path = input.get("path").and_then(Value::as_str)
                        .filter(|p| !p.trim().is_empty()).ok_or("wiki.delete_page requires path")?;
                    let output = super::wiki_delete::delete_wiki_pages(context.project_path.to_string(), vec![path.to_string()]).await?;
                    serde_json::to_value(output).map_err(|e| e.to_string())
                }
                "wiki.search" => {
                    let query = tool_query(&input, "wiki.search")?;
                    let top_k = tool_top_k(&input);
                    let include_content = input
                        .get("includeContent")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    serde_json::to_value(
                        run_wiki_search(
                            context.project_path.to_string(),
                            query,
                            top_k,
                            include_content,
                            context.embedding_config,
                        )
                        .await?,
                    )
                    .map_err(|err| format!("Failed to serialize wiki.search result: {err}"))
                }
                "wiki.read_page" => {
                    let range: super::wiki_files::ReadSourceRequest = serde_json::from_value(input.clone())
                        .map_err(|error| format!("wiki.read_page 参数无效：{error}"))?;
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                        .ok_or_else(|| "wiki.read_page requires path".to_string())?;
                    let content = read_wiki_page(context.project_path, path)?;
                    let normalized_path = normalize_rel_path(path);
                    let mut knowledge_context = Some(read_knowledge_context(context.project_path, &normalized_path, &content)?);
                    attach_latest_version(
                        context.project_path,
                        &normalized_path,
                        &mut knowledge_context,
                    );
                    knowledge_context.get_or_insert_with(Default::default).evidence.push(search::evidence::page_snapshot(&normalized_path, &content));
                    let page = super::wiki_files::read_text_range(&content, range, "wiki_markdown")?;
                    let mut output = serde_json::to_value(page).map_err(|error| error.to_string())?;
                    output["knowledgeContext"] = serde_json::to_value(knowledge_context).map_err(|error| error.to_string())?;
                    Ok(output)
                }
                "workspace.write_file" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.write_file requires path".to_string())?;
                    let content = input
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.write_file requires content".to_string())?;
                    serde_json::to_value(write_workspace_file(context.project_path, path, content)?)
                        .map_err(|err| {
                            format!("Failed to serialize workspace.write_file result: {err}")
                        })
                }
                "workspace.append_file" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.append_file requires path".to_string())?;
                    let content = input
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.append_file requires content".to_string())?;
                    serde_json::to_value(append_workspace_file(
                        context.project_path,
                        path,
                        content,
                    )?)
                    .map_err(|err| {
                        format!("Failed to serialize workspace.append_file result: {err}")
                    })
                }
                "source.search" => {
                    let result = run_scoped_search(context.project_path, tool_query(&input, "source.search")?, tool_top_k(&input), "sources").await?;
                    serde_json::to_value(result)
                        .map_err(|err| format!("Failed to serialize source.search result: {err}"))
                }
                "graph.search" => {
                    let result = run_scoped_search(context.project_path, tool_query(&input, "graph.search")?, tool_top_k(&input), "graph").await?;
                    serde_json::to_value(result)
                        .map_err(|err| format!("Failed to serialize graph.search result: {err}"))
                }
                "web.search" => {
                    let query = tool_query(&input, "web.search")?;
                    serde_json::to_value(
                        run_web_search(query, context.web_search_config, tool_top_k(&input))
                            .await?,
                    )
                    .map_err(|err| format!("Failed to serialize web.search result: {err}"))
                }
                "anytxt.search" => {
                    let query = tool_query(&input, "anytxt.search")?;
                    serde_json::to_value(
                        run_anytxt_search(query, context.anytxt_config, tool_top_k(&input)).await?,
                    )
                    .map_err(|err| format!("Failed to serialize anytxt.search result: {err}"))
                }
                "shell.exec" => {
                    let command = input
                        .get("command")
                        .or_else(|| input.get("query"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "shell.exec requires command".to_string())?;
                    let timeout_secs = input
                        .get("timeoutSeconds")
                        .or_else(|| input.get("timeout_seconds"))
                        .and_then(Value::as_u64)
                        .unwrap_or(SHELL_EXEC_TIMEOUT_SECS)
                        .clamp(1, SHELL_EXEC_TIMEOUT_SECS);
                    serde_json::to_value(
                        run_shell_exec(context.project_path, command, timeout_secs).await?,
                    )
                    .map_err(|err| format!("Failed to serialize shell.exec result: {err}"))
                }
                other => Err(format!("Unknown Agent tool: {other}")),
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearchToolOutput {
    #[serde(default)]
    pub retrieval: Option<Value>,
    pub mode: String,
    pub token_hits: usize,
    pub vector_hits: usize,
    pub graph_hits: usize,
    pub references: Vec<AgentReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecToolOutput {
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    #[serde(default)]
    pub generated_files: Vec<WorkspaceWriteOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWriteOutput {
    pub path: String,
    pub bytes: usize,
    #[serde(default)]
    pub existed_before: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiWriteOutput {
    #[serde(flatten)]
    pub reference: AgentReference,
    #[serde(default)]
    pub existed_before: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_content: Option<String>,
    /// 对话材料仅提交公共入库队列，不能把此状态解释为知识页已经完成写入。
    #[serde(default)]
    pub ingest_queued: bool,
    /// 直接保存后的正文版本；排队入库尚无 Wiki 版本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedWikiWriteOutput {
    pub path: String,
    pub bytes: usize,
    pub allow_overwrite: bool,
    pub verified: bool,
    pub existed_before: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfig {
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub ollama_url: Option<String>,
    #[serde(default)]
    pub sear_xng_url: Option<String>,
    #[serde(default)]
    pub sear_xng_categories: Option<Vec<String>>,
    #[serde(default)]
    pub serp_api_engine: Option<String>,
    #[serde(default)]
    pub provider_configs: Option<BTreeMap<String, WebSearchProviderOverride>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchProviderOverride {
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub ollama_url: Option<String>,
    #[serde(default)]
    pub sear_xng_url: Option<String>,
    #[serde(default)]
    pub sear_xng_categories: Option<Vec<String>>,
    #[serde(default)]
    pub serp_api_engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnyTxtConfig {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub filter_dir: Option<String>,
    #[serde(default)]
    pub filter_ext: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

impl WebSearchConfig {
    fn resolved(&self) -> Self {
        let provider = self.provider.trim().to_ascii_lowercase();
        let Some(override_cfg) = self
            .provider_configs
            .as_ref()
            .and_then(|configs| configs.get(&provider))
        else {
            return self.clone();
        };
        Self {
            provider: self.provider.clone(),
            api_key: override_cfg
                .api_key
                .clone()
                .unwrap_or_else(|| self.api_key.clone()),
            ollama_url: override_cfg
                .ollama_url
                .clone()
                .or_else(|| self.ollama_url.clone()),
            sear_xng_url: override_cfg
                .sear_xng_url
                .clone()
                .or_else(|| self.sear_xng_url.clone()),
            sear_xng_categories: override_cfg
                .sear_xng_categories
                .clone()
                .or_else(|| self.sear_xng_categories.clone()),
            serp_api_engine: override_cfg
                .serp_api_engine
                .clone()
                .or_else(|| self.serp_api_engine.clone()),
            provider_configs: self.provider_configs.clone(),
        }
    }
}

// Keep the spec list close to the executor even though the current planner
// still uses fixed tool names. API/MCP tool discovery and future native
// tool-calling should use this list instead of duplicating tool metadata.
#[allow(dead_code)]
pub fn builtin_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "wiki.search".to_string(),
            description: "Search generated LLM Wiki pages using backend keyword/vector retrieval."
                .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "wiki.read_page".to_string(),
            description: "按精确项目路径读取 Wiki 原文，保留换行。行列从 1 开始；长文根据 nextStartLine/nextStartColumn 续读并传 revision。truncated=true 时不能声称已读全文。".to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" },
                    "startLine":{"type":"integer","minimum":1}, "endLine":{"type":"integer","minimum":1},
                    "startColumn":{"type":"integer","minimum":1}, "maxChars":{"type":"integer","minimum":1,"maximum":12000},
                    "revision":{"type":"string"} },
                "required": ["path"]
            })),
        },
        ToolSpec {
            name: "source.search".to_string(),
            description:
                "Search raw source files stored under raw/sources for exact keyword snippets."
                    .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "web.search".to_string(),
            description: "Search external web sources when the user enables web search."
                .to_string(),
            effects: vec![ToolEffect::Network],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "graph.search".to_string(),
            description: "Retrieve graph relationships, neighbors, backlinks, dependencies, and connections between project entities. Use concise entity or concept names rather than a full question."
                .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "anytxt.search".to_string(),
            description: "Search files indexed by an AnyTXT JSON-RPC service.".to_string(),
            effects: vec![ToolEffect::Network, ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "wiki.write_page".to_string(),
            description:
                "Write authorized Wiki changes. In a review conversation, persist complete Markdown directly to the exact Wiki path; replacing an existing page requires allowOverwrite=true. In an ordinary conversation, retain the material as a source and submit shared ingest; the path is a topic hint. ingestQueued distinguishes queued ingestion from a completed page write."
                    .to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "项目相对路径，例如 wiki/queries/new-page.md。文件名和目录名禁止英文单引号、双引号及控制或不可见字符；去除 wiki/ 和 .md 后最多 256 个 Unicode 字符。标题和正文可以保留引号，链接使用实际文件名。"
                    },
                    "content": { "type": "string" },
                    "expectedRevision": { "type": "string", "description":"覆盖审阅页面时传读取结果的 revision；版本变化则拒绝。局部修改优先 wiki.patch_page。" },
                    "allowOverwrite": {
                        "type": "boolean",
                        "description": "Required as true for a user-authorized replacement of an existing page in a review conversation. Ordinary conversations always use shared ingest; this flag cannot force direct replacement."
                    }
                },
                "required": ["path", "content"]
            })),
        },
        ToolSpec {
            name: "wiki.patch_page".into(),
            description: "审阅会话中局部修改已授权页面。oldText 必须逐字且唯一匹配已读取的原文，newText 为替换片段，expectedRevision 为读取时版本。返回实际写入结果；版本冲突或匹配歧义时不修改文件，需重新读取。".into(),
            effects: vec![ToolEffect::Write],
            parameters: Some(json!({"type":"object","properties":{
                "path":{"type":"string"}, "expectedRevision":{"type":"string"},
                "oldText":{"type":"string","minLength":1}, "newText":{"type":"string"}
            },"required":["path","expectedRevision","oldText","newText"],"additionalProperties":false})),
        },
        ToolSpec {
            name: "wiki.list_pages".into(),
            description: "按路径前缀列举真实 Wiki 页面，返回 total、nextOffset、snapshot。查找全部重复副本时使用；只有 truncated=false 才表示列完，后续分页须传同一 snapshot。".into(),
            effects: vec![ToolEffect::Read],
            parameters: Some(json!({"type":"object","properties":{
                "prefix":{"type":"string","description":"默认 wiki/，支持 wiki/data-models/table- 等文件名前缀。"},
                "offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":500},
                "snapshot":{"type":"string"}
            },"additionalProperties":false})),
        },
        ToolSpec {
            name: "source.read_file".into(),
            description: "按精确 raw/sources/ 路径读取来源原文及行号；支持 startLine、endLine、startColumn、maxChars。长文依 nextStartLine/nextStartColumn 续读并携带 revision；二进制资料只读最新提取正文，未提取或已过期会明确失败。".into(),
            effects: vec![ToolEffect::Read],
            parameters: Some(json!({"type":"object","properties":{
                "path":{"type":"string"},"startLine":{"type":"integer","minimum":1},
                "endLine":{"type":"integer","minimum":1},"startColumn":{"type":"integer","minimum":1},
                "maxChars":{"type":"integer","minimum":1,"maximum":12000},"revision":{"type":"string"}
            },"required":["path"],"additionalProperties":false})),
        },
        ToolSpec {
            name: "wiki.move_page".into(),
            description: "移动或重命名用户已明确授权的 Wiki 页面，同步迁移目录、正文链接、related、相对资源和索引。先读取精确源路径，并建议传读取结果中的 expectedRevision；toPath 已存在时拒绝覆盖。返回实际路径、warnings 和 indexingPendingPaths，不自动关闭审阅项。".into(),
            effects: vec![ToolEffect::Write],
            parameters: Some(json!({"type":"object","properties":{
                "path":{"type":"string"},"toPath":{"type":"string"},"expectedRevision":{"type":"string"}
            },"required":["path","toPath"],"additionalProperties":false})),
        },
        ToolSpec {
            name: "wiki.delete_page".to_string(),
            description: "删除用户明确要求移除的 Wiki Markdown 页面，同时清理目录、正文链接、related 引用及旧向量。先读取精确目标并确认需要保留的内容已合并；来源和审阅材料不构成授权。返回实际删除路径及清理警告，不自动解决审阅项。".to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(json!({ "type": "object", "properties": {
                "path": { "type": "string", "description": "已读取并核对的项目相对路径，例如 wiki/concepts/duplicate.md；不支持目录、通配符或符号链接。" }
            }, "required": ["path"], "additionalProperties": false })),
        },
        ToolSpec {
            name: "llm.generate".to_string(),
            description: "Generate a final assistant answer from retrieved context.".to_string(),
            effects: vec![ToolEffect::Network],
            parameters: None,
        },
        ToolSpec {
            name: "skills.load".to_string(),
            description: "Load instruction-only project skills from .llm-wiki/skills.".to_string(),
            effects: vec![ToolEffect::Read],
            parameters: None,
        },
        ToolSpec {
            name: "skill.read_file".to_string(),
            description:
                "Read a text reference file from an active skill directory by relative path."
                    .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "skill": {
                        "type": "string",
                        "description": "Optional active skill name; required when multiple skills are active."
                    },
                    "path": {
                        "type": "string",
                        "description": "Relative path inside the active skill directory, such as references/types.md."
                    }
                },
                "required": ["path"]
            })),
        },
        ToolSpec {
            name: "workspace.write_file".to_string(),
            description:
                "Write a generated artifact file under the visible agent-workspace directory."
                    .to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path under agent-workspace, such as cover-image/cover.svg."
                    },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            })),
        },
        ToolSpec {
            name: "workspace.append_file".to_string(),
            description:
                "Append generated artifact content under agent-workspace. Use after workspace.write_file for large HTML/PPT files."
                    .to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path under agent-workspace, matching the file being appended."
                    },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            })),
        },
        ToolSpec {
            name: "shell.exec".to_string(),
            description:
                "Run a project-scoped shell command requested by an active skill instruction."
                    .to_string(),
            effects: vec![ToolEffect::Read, ToolEffect::Process],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": SHELL_EXEC_TIMEOUT_SECS }
                },
                "required": ["command"]
            })),
        },
    ]
}

fn tool_query<'a>(input: &'a Value, tool: &str) -> Result<&'a str, String> {
    input
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .ok_or_else(|| format!("{tool} requires query"))
}

fn tool_top_k(input: &Value) -> usize {
    input
        .get("topK")
        .or_else(|| input.get("top_k"))
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(5)
        .clamp(1, 10)
}

#[cfg(test)]
pub fn write_wiki_page_with_options(
    project_path: &str,
    rel_path: &str,
    content: &str,
    allow_overwrite: bool,
) -> Result<AgentReference, String> {
    Ok(write_wiki_page_with_activity(project_path, rel_path, content, allow_overwrite)?.reference)
}

pub fn write_wiki_page_verified(
    project_path: &str,
    rel_path: &str,
    content: &str,
    allow_overwrite: bool,
) -> Result<VerifiedWikiWriteOutput, String> {
    let output = write_wiki_page_with_activity(project_path, rel_path, content, allow_overwrite)?;
    Ok(VerifiedWikiWriteOutput {
        path: output.reference.path,
        bytes: content.len(),
        allow_overwrite,
        verified: true,
        existed_before: output.existed_before,
    })
}

fn write_wiki_page_with_activity(
    project_path: &str,
    rel_path: &str,
    content: &str,
    allow_overwrite: bool,
) -> Result<WikiWriteOutput, String> {
    write_wiki_page_at_revision(project_path, rel_path, content, allow_overwrite, None)
}

/// 在同一提交锁内校验读取版本并保存，避免覆盖模型读取后发生的其他修改。
fn write_wiki_page_at_revision(
    project_path: &str, rel_path: &str, content: &str, allow_overwrite: bool,
    expected_revision: Option<&str>,
) -> Result<WikiWriteOutput, String> {
    let _mutation = crate::mutation::lock()?;
    write_wiki_page_locked(project_path, rel_path, content, allow_overwrite, expected_revision)
}

/// 精确替换一个已确认片段；失败或匹配不唯一时不改变文件，不进行模糊匹配。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WikiPatchRequest {
    path: String,
    expected_revision: String,
    old_text: String,
    new_text: String,
}

fn patch_wiki_page(project_path: &str, request: WikiPatchRequest) -> Result<WikiWriteOutput, String> {
    if request.old_text.is_empty() || request.old_text == request.new_text {
        return Err("wiki.patch_page 的 oldText 不能为空，且必须与 newText 不同".into());
    }
    let _mutation = crate::mutation::lock()?;
    let current = read_wiki_page(project_path, &request.path)?;
    if super::wiki_files::revision(&current) != request.expected_revision {
        return Err("页面版本已变化，请重新读取目标片段后再修改".into());
    }
    let first_match = current.find(&request.old_text);
    // 从首个字符之后继续查找，也识别 aaa 中 aa 这样的重叠匹配。
    if first_match.is_none_or(|start| {
        let next = start + request.old_text.chars().next().unwrap().len_utf8();
        current[next..].contains(&request.old_text)
    }) {
        return Err("oldText 必须精确且唯一匹配当前页面；请读取对应行并补充上下文，不要重写整页".into());
    }
    let updated = current.replacen(&request.old_text, &request.new_text, 1);
    write_wiki_page_locked(project_path, &request.path, &updated, true, Some(&request.expected_revision))
}

/// 调用方持有提交锁；整页与局部修改共用审批、原子写入、验证和版本历史。
fn write_wiki_page_locked(
    project_path: &str, rel_path: &str, content: &str, allow_overwrite: bool,
    expected_revision: Option<&str>,
) -> Result<WikiWriteOutput, String> {
    let _write_guard = WIKI_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "wiki.write_page lock is unavailable".to_string())?;
    if content.len() > MAX_WRITE_PAGE_BYTES {
        return Err("wiki.write_page content is too large".to_string());
    }
    let rel = normalize_wiki_write_path(rel_path)?;
    let path = safe_project_join(project_path, &rel)?;
    if let Some(parent) = path.parent() {
        // Check the deepest existing ancestor before creating directories. If a
        // project already contains a symlink under `wiki/`, this prevents even
        // empty intermediate directories from being created outside the project.
        ensure_existing_ancestor_bound(project_path, parent)?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create wiki page directory: {err}"))?;
        ensure_project_bound_path(project_path, parent)?;
    }
    // Create-only by default. Prompt injection in retrieved context must not be
    // able to silently truncate an existing wiki page.
    if path.exists() && !allow_overwrite {
        return Err(
            "wiki.write_page refuses to overwrite an existing page without allowOverwrite=true"
                .to_string(),
        );
    }
    if path
        .symlink_metadata()
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("wiki.write_page refuses to overwrite a symlink".to_string());
    }
    let existed_before = path.is_file();
    if let Some(expected) = expected_revision {
        let current = fs::read_to_string(&path).map_err(|error| format!("无法核对页面版本：{error}"))?;
        if super::wiki_files::revision(&current) != expected {
            return Err("页面版本已变化，请重新读取后再修改".into());
        }
    }
    let _approval = crate::commands::file_approval::guard_mutation(&path, Some(content.as_bytes()), "wiki.write_page")?;
    let previous_bytes = existed_before
        .then(|| fs::read(&path))
        .transpose()
        .map_err(|err| format!("Failed to read existing wiki page before replacement: {err}"))?;
    let previous_content = workspace_rollback_snapshot(&path);
    crate::commands::file_history::record_file_version(&path, "baseline", "before.wiki.write_page");
    atomic_replace_file(&path, content.as_bytes())?;
    let persisted =
        fs::read(&path).map_err(|err| format!("Failed to verify persisted wiki page: {err}"))?;
    if persisted != content.as_bytes() {
        let rollback = if let Some(previous) = previous_bytes {
            atomic_replace_file(&path, &previous)
        } else {
            fs::remove_file(&path).map_err(|err| format!("Failed to remove unverified page: {err}"))
        };
        return Err(match rollback {
            Ok(()) => "Persisted wiki page did not match the requested content; the previous state was restored".to_string(),
            Err(err) => format!("Persisted wiki page did not match the requested content, and rollback failed: {err}"),
        });
    }
    crate::commands::file_history::record_file_version(&path, "agent", "wiki.write_page");
    Ok(WikiWriteOutput {
        reference: AgentReference {
            title: extract_markdown_title(content).unwrap_or_else(|| {
                Path::new(&rel)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Wiki page")
                    .replace('-', " ")
            }),
            path: rel.clone(),
            kind: "wiki".to_string(),
            snippet: Some(trim_text(&collapse_markdown_preview(content), 500))
                .filter(|value| !value.trim().is_empty()),
            score: None,
            knowledge_context: None,
        },
        existed_before,
        previous_content,
        ingest_queued: false,
        revision: Some(super::wiki_files::revision(content)),
    })
}

pub(super) fn atomic_replace_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve wiki page parent directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "wiki.write_page path must be valid UTF-8".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(
        ".{file_name}.llm-wiki-{}-{nonce}.tmp",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|err| format!("Failed to create wiki page temp file: {err}"))?;
    if let Err(err) = file.write_all(content).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Failed to write wiki page temp file: {err}"));
    }
    drop(file);

    #[cfg(not(windows))]
    {
        if let Err(err) = fs::rename(&temp, path) {
            let _ = fs::remove_file(&temp);
            return Err(format!("Failed to replace wiki page: {err}"));
        }
    }

    #[cfg(windows)]
    {
        let backup = parent.join(format!(
            ".{file_name}.llm-wiki-{}-{nonce}.bak",
            std::process::id()
        ));
        let had_target = path.exists();
        if had_target {
            fs::rename(path, &backup)
                .map_err(|err| format!("Failed to stage existing wiki page: {err}"))?;
        }
        if let Err(err) = fs::rename(&temp, path) {
            if had_target {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(&temp);
            return Err(format!("Failed to replace wiki page: {err}"));
        }
        if had_target {
            let _ = fs::remove_file(backup);
        }
    }

    Ok(())
}

fn write_workspace_file(
    project_path: &str,
    rel_path: &str,
    content: &str,
) -> Result<WorkspaceWriteOutput, String> {
    if content.len() > MAX_WORKSPACE_WRITE_BYTES {
        return Err("workspace.write_file content is too large".to_string());
    }
    let (rel, path) =
        resolve_workspace_write_target(project_path, rel_path, "workspace.write_file")?;
    if path
        .symlink_metadata()
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("workspace.write_file refuses to overwrite a symlink".to_string());
    }
    let existed_before = path.is_file();
    let previous_content = workspace_rollback_snapshot(&path);
    let _approval = crate::commands::file_approval::guard_mutation(&path, Some(content.as_bytes()), "workspace.write_file")?;
    crate::commands::file_history::record_file_version(
        &path,
        "baseline",
        "before.workspace.write_file",
    );
    fs::write(&path, content).map_err(|err| format!("workspace.write_file failed: {err}"))?;
    crate::commands::file_history::record_file_version(&path, "agent", "workspace.write_file");
    Ok(WorkspaceWriteOutput {
        path: format!("{AGENT_WORKSPACE_DIR}/{rel}"),
        bytes: content.len(),
        existed_before,
        previous_content,
    })
}

fn append_workspace_file(
    project_path: &str,
    rel_path: &str,
    content: &str,
) -> Result<WorkspaceWriteOutput, String> {
    if content.len() > MAX_WORKSPACE_WRITE_BYTES {
        return Err("workspace.append_file content is too large".to_string());
    }
    let (rel, path) =
        resolve_workspace_write_target(project_path, rel_path, "workspace.append_file")?;
    if path
        .symlink_metadata()
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("workspace.append_file refuses to overwrite a symlink".to_string());
    }
    let existed_before = path.is_file();
    let previous_content = workspace_rollback_snapshot(&path);
    let _approval = crate::commands::file_approval::guard_append(&path, content.as_bytes())?;
    crate::commands::file_history::record_file_version(
        &path,
        "baseline",
        "before.workspace.append_file",
    );
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(content.as_bytes())
        })
        .map_err(|err| format!("workspace.append_file failed: {err}"))?;
    crate::commands::file_history::record_file_version(&path, "agent", "workspace.append_file");
    let bytes = fs::metadata(&path)
        .map(|metadata| metadata.len() as usize)
        .unwrap_or(content.len());
    Ok(WorkspaceWriteOutput {
        path: format!("{AGENT_WORKSPACE_DIR}/{rel}"),
        bytes,
        existed_before,
        previous_content,
    })
}

fn workspace_rollback_snapshot(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_WORKSPACE_ROLLBACK_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn resolve_workspace_write_target(
    project_path: &str,
    rel_path: &str,
    tool_name: &str,
) -> Result<(String, PathBuf), String> {
    let rel = normalize_workspace_write_path(rel_path)
        .map_err(|err| err.replace("workspace.write_file", tool_name))?;
    let project = Path::new(project_path);
    if !project.is_dir() {
        return Err(format!("{tool_name} project directory is not available"));
    }
    let workspace = agent_workspace_path(project);
    fs::create_dir_all(&workspace)
        .map_err(|err| format!("{tool_name} failed to create workspace: {err}"))?;
    ensure_project_bound_path(project_path, &workspace)?;
    let path = workspace.join(&rel);
    if let Some(parent) = path.parent() {
        ensure_existing_ancestor_bound(project_path, parent)?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("{tool_name} failed to create directory: {err}"))?;
        ensure_project_bound_path(project_path, parent)?;
    }
    Ok((rel, path))
}

pub async fn run_wiki_search(
    project_path: String,
    query: &str,
    top_k: usize,
    include_content: bool,
    embedding_config: Option<SearchEmbeddingConfig>,
) -> Result<WikiSearchToolOutput, String> {
    let search = search::search_with_evidence(
        project_path.clone(),
        query.to_string(),
        top_k,
        include_content,
        None,
        embedding_config,
    )
    .await?;
    // 正文证据与关系已由统一检索取得，不再重复全库扫描重建图。
    let references = search
        .results
        .iter()
        .map(|result| {
            let normalized_path = normalize_rel_path(&result.path);
            let mut context = AgentKnowledgeContext::default();
            context.related_to = result.graph_related_to.clone();
            if let Some(evidence) = result.evidence_context.as_ref() {
                context.evidence = evidence["evidence"].as_array().cloned().unwrap_or_default();
                context.relations = evidence["relations"].as_array().cloned().unwrap_or_default();
                context.link_count = context.relations.len();
                for edge in &context.relations {
                    if edge["fromPath"] == normalized_path {
                        if let Some(to) = edge["toPath"].as_str() { context.outgoing_links.push(to.to_string()); }
                    } else if let Some(from) = edge["fromPath"].as_str() { context.backlinks.push(from.to_string()); }
                }
            }
            let mut knowledge_context = Some(context);
            attach_latest_version(&project_path, &normalized_path, &mut knowledge_context);
            AgentReference {
                title: result.title.clone(),
                path: result.path.clone(),
                kind: if result.graph_related_to.is_empty() {
                    "wiki".to_string()
                } else {
                    "graph".to_string()
                },
                snippet: Some(result.snippet.clone()).filter(|s| !s.trim().is_empty()),
                score: Some(result.score),
                knowledge_context,
            }
        })
        .collect();
    Ok(WikiSearchToolOutput {
        retrieval: search.retrieval,
        mode: search.mode,
        token_hits: search.token_hits,
        vector_hits: search.vector_hits,
        graph_hits: search.graph_hits,
        references,
    })
}

/// 专用检索工具只收窄统一核心的语料和通道，不能绕开用户关闭的通道。
async fn run_scoped_search(project_path: &str, query: &str, top_k: usize, scope: &str) -> Result<Value, String> {
    let channels = BTreeMap::from([
        ("keyword".into(), scope == "sources"), ("indexPage".into(), false),
        ("vector".into(), false), ("graph".into(), scope == "graph"),
    ]);
    let result = search::evidence::retrieve(search::evidence::Request {
        project_path: project_path.into(), scene: "qa".into(),
        targets: vec![search::evidence::Target { id: "question".into(), text: query.into(), title: None, path: None }],
        scope: Some(search::evidence::Scope { corpus: if scope == "sources" { "sources" } else { "wiki" }.into(), ..Default::default() }),
        channels: Some(channels), budget: None, checkpoint: None,
    }, None, None).await?;
    let mut references: Vec<AgentReference> = Vec::new();
    for evidence in result["evidence"].as_array().into_iter().flatten().take(top_k.clamp(1, 5)) {
        let path = evidence["path"].as_str().unwrap_or_default();
        let relations: Vec<Value> = result["relations"].as_array().into_iter().flatten().filter(|edge| edge["fromPath"] == path || edge["toPath"] == path).cloned().collect();
        if let Some(existing) = references.iter_mut().find(|entry| entry.path == path) {
            existing.knowledge_context.as_mut().unwrap().evidence.push(evidence.clone());
            continue;
        }
        references.push(AgentReference {
            title: evidence["title"].as_str().unwrap_or(path).into(), path: path.into(), kind: if scope == "sources" { "source" } else { "graph" }.into(),
            snippet: evidence["text"].as_str().map(str::to_string), score: None,
            knowledge_context: Some(AgentKnowledgeContext { evidence: vec![evidence.clone()], link_count: relations.len(), relations, ..Default::default() }),
        });
    }
    Ok(json!({"references":references,"retrieval":{"status":result["status"],"targetResults":result["targetResults"],"execution":result["execution"]}}))
}

async fn run_shell_exec(
    project_path: &str,
    command: &str,
    timeout_secs: u64,
) -> Result<ShellExecToolOutput, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("shell.exec command is empty".to_string());
    }
    if command.chars().count() > MAX_SHELL_COMMAND_CHARS {
        return Err("shell.exec command is too long".to_string());
    }
    let cwd = Path::new(project_path);
    if !cwd.is_dir() {
        return Err("shell.exec project directory is not available".to_string());
    }
    let workspace = agent_workspace_path(cwd);
    fs::create_dir_all(&workspace)
        .map_err(|err| format!("shell.exec failed to create {AGENT_WORKSPACE_DIR}: {err}"))?;
    ensure_project_bound_path(project_path, &workspace)?;
    let before_files = snapshot_workspace_files(&workspace);
    #[cfg(windows)]
    let mut child = {
        let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd".into());
        let mut cmd = Command::new(shell);
        cmd.args(["/C", command]);
        cmd
    };
    #[cfg(not(windows))]
    let mut child = {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", command]);
        cmd
    };
    apply_sanitized_shell_env(&mut child, project_path, &workspace);
    child
        .current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = child
        .spawn()
        .map_err(|err| format!("shell.exec failed to start: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "shell.exec failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "shell.exec failed to capture stderr".to_string())?;
    let stdout_task = tokio::spawn(read_limited_output(stdout, MAX_SHELL_OUTPUT_CHARS));
    let stderr_task = tokio::spawn(read_limited_output(stderr, MAX_SHELL_OUTPUT_CHARS));
    let status = timeout(Duration::from_secs(timeout_secs), child.wait()).await;
    let (exit_code, timed_out, timeout_message) = match status {
        Ok(Ok(status)) => (status.code(), false, None),
        Ok(Err(err)) => return Err(format!("shell.exec failed while waiting: {err}")),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            (
                None,
                true,
                Some(format!("Command timed out after {timeout_secs}s")),
            )
        }
    };
    let stdout = await_shell_output(stdout_task, "stdout").await?;
    let mut stderr = await_shell_output(stderr_task, "stderr").await?;
    if let Some(message) = timeout_message {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(&message);
    }
    let generated_files = changed_workspace_files(&workspace, before_files);
    for output in &generated_files {
        if let Some(relative) = output.path.strip_prefix(&format!("{AGENT_WORKSPACE_DIR}/")) {
            crate::commands::file_history::record_file_version(
                &workspace.join(relative),
                "agent",
                "shell.exec",
            );
        }
    }
    Ok(ShellExecToolOutput {
        command: command.to_string(),
        exit_code,
        stdout,
        stderr,
        timed_out,
        generated_files,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkspaceFileSnapshot {
    len: u64,
    modified: Option<SystemTime>,
    content_hash: Option<u64>,
}

fn snapshot_workspace_files(workspace: &Path) -> BTreeMap<String, WorkspaceFileSnapshot> {
    let mut files = BTreeMap::new();
    for entry in WalkDir::new(workspace).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(workspace) else {
            continue;
        };
        let Some(rel) = rel.to_str().map(|value| value.replace('\\', "/")) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        files.insert(
            rel,
            WorkspaceFileSnapshot {
                len: metadata.len(),
                modified: metadata.modified().ok(),
                content_hash: workspace_file_content_hash(entry.path(), metadata.len()),
            },
        );
    }
    files
}

fn workspace_file_content_hash(path: &Path, len: u64) -> Option<u64> {
    // Shell-generated artifacts can be rewritten faster than some filesystems
    // update mtimes, especially on Windows/external/network volumes. A bounded
    // content signature prevents same-size rewrites from disappearing from the
    // generated-output list without turning every shell command into an
    // unbounded full-workspace read.
    const FULL_HASH_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
    const EDGE_SAMPLE_BYTES: u64 = 64 * 1024;

    let mut file = fs::File::open(path).ok()?;
    let mut hasher = DefaultHasher::new();
    len.hash(&mut hasher);
    if len <= FULL_HASH_LIMIT_BYTES {
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        bytes.hash(&mut hasher);
    } else {
        let sample = EDGE_SAMPLE_BYTES as usize;
        let mut head = vec![0_u8; sample];
        file.read_exact(&mut head).ok()?;
        head.hash(&mut hasher);
        file.seek(SeekFrom::End(-(EDGE_SAMPLE_BYTES as i64))).ok()?;
        let mut tail = vec![0_u8; sample];
        file.read_exact(&mut tail).ok()?;
        tail.hash(&mut hasher);
    }
    Some(hasher.finish())
}

fn changed_workspace_files(
    workspace: &Path,
    before: BTreeMap<String, WorkspaceFileSnapshot>,
) -> Vec<WorkspaceWriteOutput> {
    let after = snapshot_workspace_files(workspace);
    after
        .into_iter()
        .filter_map(|(rel, snapshot)| {
            if before.get(&rel) == Some(&snapshot) {
                return None;
            }
            Some(WorkspaceWriteOutput {
                path: format!("{AGENT_WORKSPACE_DIR}/{rel}"),
                bytes: snapshot.len as usize,
                existed_before: before.contains_key(&rel),
                previous_content: None,
            })
        })
        .take(MAX_SHELL_GENERATED_FILES)
        .collect()
}

async fn await_shell_output(mut handle: JoinHandle<String>, label: &str) -> Result<String, String> {
    match timeout(
        Duration::from_secs(SHELL_OUTPUT_DRAIN_TIMEOUT_SECS),
        &mut handle,
    )
    .await
    {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(err)) => Err(format!("shell.exec {label} task failed: {err}")),
        Err(_) => {
            handle.abort();
            Ok(format!(
                "[{label} output was still open after command exit and was truncated]"
            ))
        }
    }
}

fn apply_sanitized_shell_env(command: &mut Command, project_path: &str, workspace: &Path) {
    // This is environment minimization, not an OS sandbox. `shell.exec` is only
    // reachable after an exact user approval in the Agent runtime, and approved
    // commands can still access the user's normal filesystem through the shell.
    // Keep generated artifacts in `LLM_WIKI_AGENT_WORKSPACE`, but do not imply
    // stronger process isolation here without adding a real sandbox layer.
    command.env_clear();
    preserve_shell_env(command, &["PATH", "LANG", "LC_ALL", "LC_CTYPE"]);
    #[cfg(not(windows))]
    {
        preserve_shell_env(
            command,
            &[
                "HOME",
                "USER",
                "LOGNAME",
                "SHELL",
                "TMPDIR",
                "XDG_CONFIG_HOME",
                "XDG_CACHE_HOME",
                "XDG_DATA_HOME",
            ],
        );
    }
    #[cfg(windows)]
    {
        preserve_shell_env(
            command,
            &[
                "ComSpec",
                "SystemRoot",
                "WINDIR",
                "PATHEXT",
                "USERPROFILE",
                "USERNAME",
                "HOMEDRIVE",
                "HOMEPATH",
                "TEMP",
                "TMP",
                "APPDATA",
                "LOCALAPPDATA",
                "ProgramData",
            ],
        );
    }
    command.env("LLM_WIKI_PROJECT", project_path);
    command.env("LLM_WIKI_PROJECT_PATH", project_path);
    command.env("LLM_WIKI_AGENT_WORKSPACE", workspace);
}

fn preserve_shell_env(command: &mut Command, keys: &[&str]) {
    for key in keys {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

async fn read_limited_output<R>(mut reader: R, max_chars: usize) -> String
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut kept = Vec::new();
    let max_bytes = max_chars.saturating_mul(4);
    let mut buffer = [0_u8; 8192];
    loop {
        let Ok(n) = reader.read(&mut buffer).await else {
            break;
        };
        if n == 0 {
            break;
        }
        if kept.len() < max_bytes {
            let remaining = max_bytes - kept.len();
            kept.extend_from_slice(&buffer[..n.min(remaining)]);
        }
    }
    let mut text = String::from_utf8_lossy(&kept).to_string();
    if text.chars().count() > max_chars {
        text = trim_text(&text, max_chars);
    }
    text
}

pub async fn run_web_search(
    query: &str,
    config: Option<WebSearchConfig>,
    top_k: usize,
) -> Result<Vec<AgentReference>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let Some(config) = config else {
        return Err(
            "Web search is enabled for this turn but no search provider is configured.".to_string(),
        );
    };
    let config = config.resolved();
    let provider = config.provider.trim().to_ascii_lowercase();
    if provider.is_empty() || provider == "none" {
        return Err("Web search provider is not configured.".to_string());
    }
    let max_results = web_search_result_limit(&provider, top_k);
    let client = crate::proxy::configure_http_client(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(WEB_SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("Failed to build web search client: {err}"))?;
    let raw = match provider.as_str() {
        "firecrawl" => firecrawl_search(&client, query, &config, max_results).await?,
        "searxng" => searxng_search(&client, query, &config, max_results).await?,
        "tavily" => tavily_search(&client, query, &config, max_results).await?,
        "ollama" => ollama_search(&client, query, &config, max_results).await?,
        "brave" => brave_search(&client, query, &config, max_results).await?,
        "bocha" => bocha_search(&client, query, &config, max_results).await?,
        "serpapi" => serpapi_search(&client, query, &config, max_results).await?,
        other => {
            return Err(format!(
                "Web search provider '{other}' is not supported by the Rust Agent yet"
            ))
        }
    };
    Ok(web_items_to_references(raw, max_results))
}

fn web_search_result_limit(provider: &str, requested: usize) -> usize {
    // Bocha documents a 1-50 range. Existing providers retain the historical
    // 20-result ceiling so adding Bocha cannot increase their request cost.
    let provider_max = if provider == "bocha" { 50 } else { 20 };
    requested.clamp(1, provider_max)
}

pub async fn run_anytxt_search(
    query: &str,
    config: Option<AnyTxtConfig>,
    top_k: usize,
) -> Result<Vec<AgentReference>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let config = config.unwrap_or_default();
    if config.enabled == Some(false) {
        return Ok(Vec::new());
    }
    let endpoint = config
        .endpoint
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_ANYTXT_ENDPOINT)
        .trim()
        .trim_end_matches('/');
    let endpoint = normalize_anytxt_endpoint(endpoint);
    let limit = top_k
        .clamp(1, 100)
        .min(config.limit.unwrap_or(DEFAULT_ANYTXT_LIMIT).clamp(1, 100));
    // AnyTXT has its own query syntax. The caller may already have rewritten
    // natural language into keyword form, so do not run the source-search
    // tokenizer here; pass the pattern through unchanged.
    let pattern = query.to_string();
    let filter_dir = config.filter_dir.unwrap_or_default();
    let filter_ext = config
        .filter_ext
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "*".to_string());
    let client = crate::proxy::configure_http_client(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(WEB_SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("Failed to build AnyTXT client: {err}"))?;
    let mut input = json!({
        "pattern": pattern,
        "filterExt": filter_ext,
        "lastModifyBegin": 0,
        "lastModifyEnd": ANYTXT_LAST_MODIFY_END,
        "limit": limit.to_string(),
        "offset": 0,
        "order": 0
    });
    if !filter_dir.trim().is_empty() {
        input["filterDir"] = Value::String(filter_dir);
    }
    let response = client
        .post(&endpoint)
        .header("Accept", "application/json")
        .json(&json!({
            "id": 1,
            "jsonrpc": "2.0",
            "method": "ATRpcServer.Searcher.V1.GetResult",
            "params": { "input": input }
        }))
        .send()
        .await
        .map_err(|err| {
            format!("AnyTXT search failed. Check that ATGUI.exe or the AnyTXT service is running at {endpoint}: {err}")
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read AnyTXT response: {err}"))?;
    if !status.is_success() {
        return Err(format!("AnyTXT HTTP {status}: {}", trim_text(&text, 300)));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| format!("AnyTXT returned invalid JSON: {}", trim_text(&text, 300)))?;
    if let Some(error) = value.get("error") {
        return Err(format!(
            "AnyTXT error: {}",
            trim_text(&error.to_string(), 300)
        ));
    }
    let mut references = Vec::new();
    for item in extract_anytxt_items(&value).into_iter().take(limit) {
        let fragment = if !item.fid.trim().is_empty() {
            get_anytxt_fragment(&client, &endpoint, &item.fid, &pattern)
                .await
                .unwrap_or_default()
        } else {
            String::new()
        };
        references.push(AgentReference {
            title: item.title,
            path: file_url_for_path(&item.path),
            kind: "anytxt".to_string(),
            snippet: Some(trim_text(
                if fragment.trim().is_empty() {
                    &item.snippet
                } else {
                    &fragment
                },
                1200,
            ))
            .filter(|s| !s.trim().is_empty()),
            score: None,
            knowledge_context: None,
        });
    }
    Ok(references)
}

#[derive(Debug, Clone)]
struct AnyTxtItem {
    fid: String,
    title: String,
    path: String,
    snippet: String,
}

fn extract_anytxt_items(value: &Value) -> Vec<AnyTxtItem> {
    let result = value.get("result").unwrap_or(value);
    let candidates = first_anytxt_array(
        result,
        &[
            &[][..],
            &["items"],
            &["files"],
            &["results"],
            &["list"],
            &["value"],
            &["data"],
            &["output"],
            &["output", "items"],
            &["output", "files"],
            &["output", "results"],
            &["output", "list"],
            &["output", "value"],
            &["output", "data"],
            &["data", "items"],
            &["data", "files"],
            &["data", "results"],
            &["data", "list"],
            &["data", "value"],
            &["data", "output"],
            &["data", "output", "items"],
            &["data", "output", "files"],
            &["data", "output", "results"],
            &["data", "output", "list"],
            &["data", "output", "value"],
        ],
    )
    .unwrap_or_default();
    let fields = first_anytxt_fields(
        result,
        &[
            &["field"][..],
            &["fields"],
            &["output", "field"],
            &["output", "fields"],
            &["data", "field"],
            &["data", "fields"],
            &["data", "output", "field"],
            &["data", "output", "fields"],
        ],
    )
    .unwrap_or_default();
    candidates
        .into_iter()
        .filter_map(|item| {
            let record = normalize_anytxt_record(item, &fields);
            let fid = string_field(&record, &["fid", "id", "fileId", "file_id"]);
            let raw_path = string_field(
                &record,
                &[
                    "path",
                    "file",
                    "filePath",
                    "file_path",
                    "fullPath",
                    "full_path",
                    "filename",
                    "fileName",
                    "name",
                ],
            );
            let path = if raw_path.is_empty() && !fid.is_empty() {
                format!("anytxt://{fid}")
            } else {
                raw_path
            };
            let title = string_field(&record, &["title", "name", "fileName", "filename"])
                .trim()
                .to_string();
            let title = if title.is_empty() {
                Path::new(&path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("AnyTXT result")
                    .to_string()
            } else {
                title
            };
            let snippet = string_field(
                &record,
                &[
                    "snippet",
                    "fragment",
                    "content",
                    "contents",
                    "text",
                    "summary",
                    "highlight",
                    "hitText",
                    "hit_text",
                ],
            );
            if path.is_empty() && snippet.is_empty() {
                None
            } else {
                Some(AnyTxtItem {
                    fid,
                    title,
                    path,
                    snippet,
                })
            }
        })
        .collect()
}

fn first_anytxt_array(value: &Value, paths: &[&[&str]]) -> Option<Vec<Value>> {
    for path in paths {
        let Some(candidate) = value_at_path(value, path) else {
            continue;
        };
        if let Some(items) = candidate.as_array() {
            return Some(items.clone());
        }
    }
    None
}

fn first_anytxt_fields(value: &Value, paths: &[&[&str]]) -> Option<Vec<String>> {
    for path in paths {
        let Some(candidate) = value_at_path(value, path) else {
            continue;
        };
        let Some(items) = candidate.as_array() else {
            continue;
        };
        let fields = items
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if !fields.is_empty() {
            return Some(fields);
        }
    }
    None
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn normalize_anytxt_record(item: Value, fields: &[String]) -> serde_json::Map<String, Value> {
    match item {
        Value::Object(object) => object,
        Value::Array(row) if !fields.is_empty() => fields
            .iter()
            .cloned()
            .zip(row)
            .collect::<serde_json::Map<String, Value>>(),
        other => {
            let mut object = serde_json::Map::new();
            object.insert("text".to_string(), other);
            object
        }
    }
}

fn string_field(record: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        let Some(value) = record.get(*key) else {
            continue;
        };
        if let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) {
            return text.trim().to_string();
        }
        if let Some(number) = value.as_i64() {
            return number.to_string();
        }
        if let Some(number) = value.as_u64() {
            return number.to_string();
        }
    }
    String::new()
}

async fn get_anytxt_fragment(
    client: &reqwest::Client,
    endpoint: &str,
    fid: &str,
    pattern: &str,
) -> Result<String, String> {
    let response = client
        .post(endpoint)
        .header("Accept", "application/json")
        .json(&json!({
            "id": 2,
            "jsonrpc": "2.0",
            "method": "ATRpcServer.Searcher.V1.GetFragment",
            "params": { "input": { "fid": fid, "pattern": pattern } }
        }))
        .send()
        .await
        .map_err(|err| format!("AnyTXT fragment failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read AnyTXT fragment response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "AnyTXT fragment HTTP {status}: {}",
            trim_text(&text, 300)
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "AnyTXT fragment returned invalid JSON: {}",
            trim_text(&text, 300)
        )
    })?;
    if let Some(error) = value.get("error") {
        return Err(format!(
            "AnyTXT fragment error: {}",
            trim_text(&error.to_string(), 300)
        ));
    }
    Ok(extract_anytxt_fragment_text(
        value.get("result").unwrap_or(&Value::Null),
    ))
}

fn extract_anytxt_fragment_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .map(extract_anytxt_fragment_text)
            .filter(|item| !item.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    let Some(object) = value.as_object() else {
        return String::new();
    };
    for key in ["text", "fragment", "content", "snippet", "html"] {
        if let Some(text) = object.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    for key in ["output", "result", "data", "fragments", "items", "list"] {
        if let Some(next) = object.get(key) {
            let text = extract_anytxt_fragment_text(next);
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn normalize_anytxt_endpoint(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("http://{value}")
    }
}

#[derive(Debug, Clone)]
struct WebSearchItem {
    title: String,
    url: String,
    snippet: String,
}

async fn firecrawl_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let override_cfg = config
        .provider_configs
        .as_ref()
        .and_then(|values| values.get("firecrawl"));
    let base = override_cfg
        .and_then(|value| value.base_url.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://api.firecrawl.dev")
        .trim_end_matches('/');
    let mut request = client
        .post(format!("{base}/v2/search"))
        .header("Accept", "application/json");
    if let Some(key) = override_cfg
        .and_then(|value| value.api_key.as_deref())
        .filter(|value| !value.trim().is_empty())
    {
        request = request.bearer_auth(key.trim());
    }
    let response = request
        .json(&json!({ "query": query, "limit": max_results }))
        .send()
        .await
        .map_err(|err| format!("Network error reaching Firecrawl Search: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Firecrawl response: {err}"))?;
    let parsed: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "Firecrawl search returned invalid JSON: {}",
            trim_text(&text, 300)
        )
    })?;
    if !status.is_success() || parsed.get("success").and_then(Value::as_bool) == Some(false) {
        let msg = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(friendly_firecrawl_error)
            .unwrap_or_else(|| format!("Firecrawl search failed ({status})"));
        return Err(msg);
    }
    let items = extract_web_items(&parsed, &["data", "results"]);
    Ok(items.into_iter().map(normalize_web_result).collect())
}

async fn searxng_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let base = config
        .sear_xng_url
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "SearXNG URL is required for web.search".to_string())?;
    let mut url = normalize_searxng_url(base)?;
    let categories = config
        .sear_xng_categories
        .clone()
        .unwrap_or_else(|| vec!["general".to_string()]);
    url.push_str(&format!(
        "?q={}&format=json&categories={}",
        url_encode(query),
        url_encode(&categories.join(","))
    ));
    let response = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("Network error reaching SearXNG: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read SearXNG response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "SearXNG search failed ({status}): {}",
            trim_text(&text, 300)
        ));
    }
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| format!("SearXNG returned invalid JSON: {}", trim_text(&text, 300)))?;
    let items = parsed
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .take(max_results)
        .map(normalize_web_result)
        .collect())
}

async fn tavily_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "Tavily")?;
    let response = client
        .post("https://api.tavily.com/search")
        .json(&json!({
            "api_key": key,
            "query": query,
            "max_results": max_results,
            "search_depth": "advanced",
            "include_answer": false
        }))
        .send()
        .await
        .map_err(|err| format!("Network error reaching Tavily: {err}"))?;
    parse_web_json_response(response, "Tavily", |value| {
        value
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(normalize_web_result)
            .collect()
    })
    .await
}

async fn ollama_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "Ollama")?;
    let base = config
        .ollama_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://ollama.com")
        .trim()
        .trim_end_matches('/');
    let url = format!("{base}/api/web_search");
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .bearer_auth(key)
        .json(&json!({
            "query": query,
            "max_results": max_results
        }))
        .send()
        .await
        .map_err(|err| format!("Network error reaching Ollama Web Search: {err}"))?;
    parse_web_json_response(response, "Ollama Web Search", |value| {
        value
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(normalize_web_result)
            .collect()
    })
    .await
}

async fn brave_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "Brave")?;
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
        url_encode(query),
        max_results.min(20)
    );
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key)
        .send()
        .await
        .map_err(|err| format!("Network error reaching Brave Search: {err}"))?;
    parse_web_json_response(response, "Brave Search", |value| {
        value
            .get("web")
            .and_then(|web| web.get("results"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(normalize_web_result)
            .collect()
    })
    .await
}

async fn bocha_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "Bocha")?;
    let response = client
        .post("https://api.bocha.cn/v1/web-search")
        .header("Accept", "application/json")
        .bearer_auth(key)
        .json(&json!({
            "query": query,
            "freshness": "noLimit",
            "summary": true,
            "count": max_results.clamp(1, 50)
        }))
        .send()
        .await
        .map_err(|err| format!("Network error reaching Bocha Search: {err}"))?;
    parse_web_json_response(response, "Bocha Search", parse_bocha_results).await
}

fn parse_bocha_results(value: Value) -> Vec<WebSearchItem> {
    value
        .get("data")
        .and_then(|data| data.get("webPages"))
        .and_then(|pages| pages.get("value"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| WebSearchItem {
            title: item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled")
                .to_string(),
            url: item
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            snippet: item
                .get("summary")
                .and_then(Value::as_str)
                .or_else(|| item.get("snippet").and_then(Value::as_str))
                .unwrap_or("")
                .to_string(),
        })
        .collect()
}

async fn serpapi_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "SerpApi")?;
    let engine = config.serp_api_engine.as_deref().unwrap_or("google");
    let url = format!(
        "https://serpapi.com/search?engine={}&q={}&api_key={}&num={}",
        url_encode(engine),
        url_encode(query),
        url_encode(key),
        max_results
    );
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("Network error reaching SerpApi: {err}"))?;
    parse_web_json_response(response, "SerpApi", |value| {
        for key in [
            "organic_results",
            "news_results",
            "images_results",
            "video_results",
            "videos_results",
            "shopping_results",
        ] {
            if let Some(items) = value.get(key).and_then(Value::as_array) {
                return items.iter().cloned().map(normalize_web_result).collect();
            }
        }
        Vec::new()
    })
    .await
}

async fn parse_web_json_response(
    response: reqwest::Response,
    provider: &str,
    parse: impl FnOnce(Value) -> Vec<WebSearchItem>,
) -> Result<Vec<WebSearchItem>, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read {provider} response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "{provider} search failed ({status}): {}",
            trim_text(&text, 300)
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "{provider} returned invalid JSON: {}",
            trim_text(&text, 300)
        )
    })?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(format!("{provider} search failed: {error}"));
    }
    if let Some(message) = provider_payload_error(provider, &value) {
        return Err(message);
    }
    Ok(parse(value))
}

fn provider_payload_error(provider: &str, value: &Value) -> Option<String> {
    if provider == "Bocha Search" {
        let code = value.get("code").and_then(Value::as_i64);
        if code != Some(200) {
            let message = value
                .get("msg")
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
                .unwrap_or("unknown API error");
            return Some(format!(
                "{provider} failed (code {}): {message}",
                code.unwrap_or(0)
            ));
        }
    }
    if provider == "Brave Search" && value.get("web").is_none() {
        let message = value.get("message").and_then(Value::as_str)?;
        return Some(format!("{provider} search failed: {message}"));
    }
    None
}

fn web_items_to_references(raw: Vec<WebSearchItem>, max_results: usize) -> Vec<AgentReference> {
    raw.into_iter()
        .take(max_results)
        .filter(|item| !item.url.trim().is_empty())
        .map(|item| AgentReference {
            title: item.title,
            path: item.url,
            kind: "web".to_string(),
            snippet: Some(item.snippet).filter(|s| !s.trim().is_empty()),
            score: None,
            knowledge_context: None,
        })
        .collect()
}

fn normalize_web_result(value: Value) -> WebSearchItem {
    let metadata = value.get("metadata");
    let title = value
        .get("title")
        .or_else(|| metadata.and_then(|m| m.get("title")))
        .and_then(Value::as_str)
        .unwrap_or("Untitled")
        .to_string();
    let url = value
        .get("url")
        .or_else(|| value.get("link"))
        .or_else(|| metadata.and_then(|m| m.get("sourceURL")))
        .or_else(|| metadata.and_then(|m| m.get("url")))
        .or_else(|| value.get("original"))
        .or_else(|| value.get("thumbnail"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let snippet = value
        .get("snippet")
        .or_else(|| value.get("content"))
        .or_else(|| value.get("description"))
        .or_else(|| metadata.and_then(|m| m.get("description")))
        .or_else(|| value.get("summary"))
        .or_else(|| value.get("markdown"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    WebSearchItem {
        title,
        url,
        snippet,
    }
}

fn extract_web_items(value: &Value, keys: &[&str]) -> Vec<Value> {
    for key in keys {
        let Some(candidate) = value.get(*key) else {
            continue;
        };
        if let Some(items) = candidate.as_array() {
            return items.clone();
        }
        if let Some(items) = extract_nested_web_items(candidate) {
            return items;
        }
    }
    Vec::new()
}

fn extract_nested_web_items(value: &Value) -> Option<Vec<Value>> {
    let object = value.as_object()?;
    for key in ["web", "results", "items"] {
        if let Some(items) = object.get(key).and_then(Value::as_array) {
            return Some(items.clone());
        }
    }
    None
}

fn required_api_key<'a>(config: &'a WebSearchConfig, provider: &str) -> Result<&'a str, String> {
    let key = config.api_key.trim();
    if key.is_empty() {
        Err(format!(
            "{provider} web.search requires an API key in Settings."
        ))
    } else {
        Ok(key)
    }
}

fn normalize_searxng_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("SearXNG URL is required".to_string());
    }
    let mut url = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    if !url.ends_with("/search") {
        url.push_str("/search");
    }
    Ok(url)
}

fn friendly_firecrawl_error(error: &str) -> String {
    if error
        .to_ascii_lowercase()
        .contains("ip address looks suspicious")
    {
        "Firecrawl Search rejected this IP for key-free access. Add a Firecrawl API key in Settings or choose another Web Search provider.".to_string()
    } else {
        format!("Firecrawl search failed: {error}")
    }
}

/// 显式读取与搜索共享版本和引用协议，保留原方向及歧义，避免第二套图解析。
fn read_knowledge_context(project_path: &str, path: &str, content: &str) -> Result<AgentKnowledgeContext, String> {
    let relations = search::evidence::page_relations(project_path, path)?;
    let mut context = AgentKnowledgeContext { tags: extract_frontmatter_list(content, "tags"), link_count: relations.len(), relations, ..Default::default() };
    for edge in &context.relations {
        if edge["fromPath"] == path {
            if let Some(to) = edge["toPath"].as_str() { context.outgoing_links.push(to.into()); }
        } else if let Some(from) = edge["fromPath"].as_str() { context.backlinks.push(from.into()); }
    }
    Ok(context)
}

fn attach_latest_version(project_path: &str, relative_path: &str, context: &mut Option<AgentKnowledgeContext>) {
    let Some(context) = context else { return };
    context.latest_version = crate::commands::file_history::latest_file_version(&Path::new(project_path).join(relative_path))
        .map(|(timestamp, author, tool)| AgentVersionSummary { timestamp, author, tool });
}

fn extract_frontmatter_list(content: &str, key: &str) -> Vec<String> {
    let normalized = content.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return Vec::new();
    };
    let Some(end) = rest.find("\n---") else {
        return Vec::new();
    };
    let prefix = format!("{key}:");
    let lines: Vec<&str> = rest[..end].lines().collect();
    for (index, line) in lines.iter().enumerate() {
        let Some(value) = line.trim().strip_prefix(&prefix) else {
            continue;
        };
        let inline = value.trim();
        if inline.starts_with('[') && inline.ends_with(']') {
            return inline[1..inline.len() - 1]
                .split(',')
                .map(|item| item.trim().trim_matches(['\'', '"']).to_string())
                .filter(|item| !item.is_empty())
                .collect();
        }
        let mut values = Vec::new();
        for next in lines.iter().skip(index + 1) {
            let trimmed = next.trim();
            let Some(item) = trimmed.strip_prefix('-') else {
                break;
            };
            let item = item.trim().trim_matches(['\'', '"']);
            if !item.is_empty() {
                values.push(item.to_string());
            }
        }
        return values;
    }
    Vec::new()
}

pub fn read_wiki_page(project_path: &str, rel_path: &str) -> Result<String, String> {
    let rel = normalize_rel_path(rel_path);
    if !is_public_read_rel(&rel) || !rel.to_ascii_lowercase().starts_with("wiki/") {
        return Err("wiki.read_page path must stay under wiki/".to_string());
    }
    let path = safe_project_join(project_path, &rel)?;
    let meta = fs::metadata(&path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            missing_wiki_page_error(project_path, &rel)
        } else {
            format!("Failed to read page metadata for {rel}: {err}")
        }
    })?;
    if !meta.is_file() {
        return Err("wiki.read_page path is not a file".to_string());
    }
    if meta.len() as usize > MAX_READ_PAGE_BYTES {
        return Err("wiki.read_page file is too large".to_string());
    }
    fs::read_to_string(path).map_err(|err| format!("Failed to read wiki page: {err}"))
}

/// 只列举磁盘上真实存在的同名候选，不自动换页读取，避免目录猜错后误用其他页面。
fn missing_wiki_page_error(project_path: &str, rel: &str) -> String {
    let mut error = format!(
        "wiki.read_page page not found: {rel}. No page content was read. Use exact paths from wiki.search or attached files; do not infer directories from titles or page types."
    );
    let Some(filename) = Path::new(rel).file_name() else {
        return error;
    };
    let candidates: BTreeSet<String> = WalkDir::new(Path::new(project_path).join("wiki"))
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .take(MAX_GRAPH_SEARCH_FILES)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == filename)
        .filter(|entry| ensure_project_bound_path(project_path, entry.path()).is_ok())
        .map(|entry| relative_to_project(project_path, entry.path()))
        .collect();
    if !candidates.is_empty() {
        error.push_str("\nExisting pages with the same filename (not yet read):");
        for candidate in candidates.iter().take(5) {
            error.push_str(&format!("\n- {candidate}"));
        }
        error.push_str("\nRetry wiki.read_page with the correct existing path. Do not create or move a page merely to satisfy a failed read.");
    }
    error
}

#[cfg(test)]
async fn search_graph(project_path: &str, query: &str, top_k: usize) -> Result<Vec<AgentReference>, String> {
    let result = run_scoped_search(project_path, query, top_k, "graph").await?;
    serde_json::from_value(result["references"].clone()).map_err(|error| error.to_string())
}

#[cfg(test)]
async fn search_sources(project_path: &str, query: &str, top_k: usize) -> Result<Vec<AgentReference>, String> {
    let result = run_scoped_search(project_path, query, top_k, "sources").await?;
    serde_json::from_value(result["references"].clone()).map_err(|error| error.to_string())
}

pub(super) fn safe_project_join(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path);
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("path must be project-relative".to_string());
    }
    let joined = root.join(rel_path);
    if joined.exists() {
        let root_canon = root
            .canonicalize()
            .map_err(|err| format!("Failed to resolve project path: {err}"))?;
        let joined_canon = joined
            .canonicalize()
            .map_err(|err| format!("Failed to resolve requested path: {err}"))?;
        if !joined_canon.starts_with(root_canon) {
            return Err("path escapes project directory".to_string());
        }
    }
    Ok(joined)
}

pub(super) fn ensure_existing_ancestor_bound(project_path: &str, path: &Path) -> Result<(), String> {
    let mut cursor = path;
    while !cursor.exists() {
        cursor = cursor
            .parent()
            .ok_or_else(|| "path must have an existing project ancestor".to_string())?;
    }
    ensure_project_bound_path(project_path, cursor)
}

pub(super) fn ensure_project_bound_path(project_path: &str, path: &Path) -> Result<(), String> {
    let root_canon = Path::new(project_path)
        .canonicalize()
        .map_err(|err| format!("Failed to resolve project path: {err}"))?;
    let path_canon = path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve requested path: {err}"))?;
    if !path_canon.starts_with(root_canon) {
        return Err("path escapes project directory".to_string());
    }
    Ok(())
}

fn is_public_read_rel(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    if lower.split('/').any(|segment| segment.starts_with('.')) {
        return false;
    }
    lower == "purpose.md"
        || lower == "schema.md"
        || lower.starts_with("wiki/")
        || lower.starts_with("raw/sources/")
}

fn normalize_rel_path(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

pub(super) fn normalize_wiki_write_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err("wiki.write_page path must stay inside the project".to_string());
    }
    let rel = normalize_rel_path(path);
    let lower = rel.to_ascii_lowercase();
    if !lower.starts_with("wiki/") || !lower.ends_with(".md") {
        return Err("wiki.write_page path must be a Markdown file under wiki/".to_string());
    }
    if lower.split('/').any(|segment| segment.starts_with('.')) {
        return Err("wiki.write_page cannot write hidden paths".to_string());
    }
    let rel_path = Path::new(&rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("wiki.write_page path must stay inside the project".to_string());
    }
    for segment in rel.split('/') {
        validate_portable_path_segment(segment)?;
    }
    // 生成页面必须同时满足索引的 ID 约定，不能等到重建时才失败。
    crate::commands::vectorstore::validate_page_id_for_v2(&rel[5..rel.len() - 3])
        .map_err(|reason| format!("wiki.write_page 文件名无法建立索引：{reason}；请修改名称，正文不受限制"))?;
    Ok(rel)
}

fn normalize_workspace_write_path(path: &str) -> Result<String, String> {
    let rel = normalize_rel_path(path);
    let lower = rel.to_ascii_lowercase();
    // Wiki 页面必须经过 Wiki 写入链路，不能变成工作区副本；明确给出纠正方式。
    if lower.starts_with("wiki/") {
        return Err("workspace.write_file cannot write Wiki pages. Use wiki.write_page with a project-relative path under wiki/, complete Markdown content, and allowOverwrite=true only for a user-authorized update of an existing page. Do not write a copy under agent-workspace.".to_string());
    }
    if rel.is_empty()
        || lower.starts_with("raw/")
        || lower.split('/').any(|segment| segment.starts_with('.'))
    {
        return Err(
            "workspace.write_file path must be a relative file under agent-workspace".to_string(),
        );
    }
    let rel_path = Path::new(&rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("workspace.write_file path must stay inside agent-workspace".to_string());
    }
    for segment in rel.split('/') {
        validate_workspace_path_segment(segment)?;
    }
    Ok(rel)
}

fn validate_workspace_path_segment(segment: &str) -> Result<(), String> {
    validate_portable_path_segment(segment)
        .map_err(|err| err.replace("wiki.write_page", "workspace.write_file"))
}

fn validate_portable_path_segment(segment: &str) -> Result<(), String> {
    if segment.is_empty() {
        return Err("wiki.write_page path contains an empty segment".to_string());
    }
    if segment.ends_with([' ', '.']) {
        return Err(
            "wiki.write_page path contains a segment ending with a space or dot, which is not portable to Windows"
                .to_string(),
        );
    }
    if segment
        .chars()
        .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') || ch <= '\u{1f}')
    {
        return Err(
            "wiki.write_page path contains characters that are invalid on Windows".to_string(),
        );
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err("wiki.write_page path uses a Windows reserved device name".to_string());
    }
    Ok(())
}

fn extract_markdown_title(content: &str) -> Option<String> {
    for line in content.lines().take(80) {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("title:") {
            let title = title.trim().trim_matches('"').trim_matches('\'');
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let heading = heading.trim();
            if !heading.is_empty() {
                return Some(heading.to_string());
            }
        }
    }
    None
}

fn collapse_markdown_preview(content: &str) -> String {
    content
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && trimmed != "---" && !trimmed.starts_with("title:")
        })
        .take(12)
        .collect::<Vec<_>>()
        .join(" ")
}

fn relative_to_project(project_path: &str, path: &Path) -> String {
    path.strip_prefix(project_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}



fn trim_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(max_chars).collect::<String>())
    }
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            b' ' => vec!['+'],
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::*;

    #[test]
    fn builtin_tool_specs_include_expected_tools() {
        let names = builtin_tool_specs()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"wiki.search".to_string()));
        assert!(names.contains(&"wiki.read_page".to_string()));
        assert!(names.contains(&"source.search".to_string()));
        assert!(names.contains(&"graph.search".to_string()));
        assert!(names.contains(&"anytxt.search".to_string()));
        assert!(names.contains(&"wiki.write_page".to_string()));
        assert!(names.contains(&"wiki.patch_page".to_string()));
        assert!(names.contains(&"wiki.delete_page".to_string()));
        for name in ["wiki.list_pages", "source.read_file", "wiki.move_page"] {
            assert!(names.iter().any(|tool| tool == name));
        }
        assert!(names.contains(&"llm.generate".to_string()));
        assert!(names.contains(&"skills.load".to_string()));
        assert!(names.contains(&"skill.read_file".to_string()));
        assert!(names.contains(&"workspace.write_file".to_string()));
        assert!(names.contains(&"workspace.append_file".to_string()));
        assert!(names.contains(&"shell.exec".to_string()));
    }

    /// Wiki 范围读取保留 CRLF、中文及长行，按返回游标接续后逐字还原全文。
    #[tokio::test]
    async fn wiki_read_preserves_ranges_and_continuation_metadata() {
        let root = std::env::temp_dir().join(format!("wiki-range-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        let text = format!("# 标题\r\n{}\n末尾链接 [[目标]]\n", "中文 空白\t".repeat(20));
        let path = "wiki/concepts/range.md";
        fs::write(root.join(path), &text).unwrap();
        let context = ToolContext { project_path: root.to_str().unwrap(), review_conversation: true,
            embedding_config: None, web_search_config: None, anytxt_config: None };
        let (mut line, mut column, mut revision) = (1, 1, Value::Null);
        let mut actual = String::new();
        loop {
            let part = BuiltinToolRegistry.execute("wiki.read_page", json!({"path":path,
                "startLine":line,"startColumn":column,"maxChars":23,"revision":revision}), context.clone()).await.unwrap();
            actual.push_str(part["content"].as_str().unwrap());
            revision = part["revision"].clone();
            if !part["truncated"].as_bool().unwrap() { break; }
            line = part["nextStartLine"].as_u64().unwrap();
            column = part["nextStartColumn"].as_u64().unwrap();
        }
        assert_eq!(actual, text);
        let tail = BuiltinToolRegistry.execute("wiki.read_page", json!({"path":path,"startLine":3}), context.clone()).await.unwrap();
        assert_eq!(tail["content"], "末尾链接 [[目标]]\n");
        fs::write(root.join(path), "外部修改").unwrap();
        let error = BuiltinToolRegistry.execute("wiki.read_page", json!({"path":path,"revision":revision}), context).await.unwrap_err();
        assert!(error.contains("已变化"));
        fs::remove_dir_all(root).unwrap();
    }

    /// 局部替换只改变唯一原文；过期版本、歧义匹配和普通入库会话均不得改变页面。
    #[tokio::test]
    async fn wiki_patch_preserves_unrelated_content_and_rejects_conflicts() {
        let root = std::env::temp_dir().join(format!("wiki-patch-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::write(root.join(".llm-wiki/history-settings.json"), r#"{"enabled":true,"maxVersionsPerFile":10}"#).unwrap();
        let path = "wiki/concepts/long.md";
        let prefix = format!("# 长页面\r\n{}", "保留正文 与格式\t\r\n".repeat(700));
        let text = format!("{prefix}参见 [[旧概念]]\r\n尾部不变\r\n");
        fs::write(root.join(path), &text).unwrap();
        let context = ToolContext { project_path: root.to_str().unwrap(), review_conversation: true,
            embedding_config: None, web_search_config: None, anytxt_config: None };
        let version = super::super::wiki_files::revision(&text);
        let patch = json!({"path":path,"expectedRevision":version,"oldText":"参见 [[旧概念]]","newText":"参见 [[新概念]]"});
        let result = BuiltinToolRegistry.execute("wiki.patch_page", patch.clone(), context.clone()).await.unwrap();
        assert_eq!(result["ingestQueued"], false);
        let expected = text.replace("[[旧概念]]", "[[新概念]]");
        assert_eq!(fs::read_to_string(root.join(path)).unwrap(), expected);
        assert!(crate::commands::file_history::latest_file_version(&root.join(path)).is_some());
        let error = BuiltinToolRegistry.execute("wiki.patch_page", patch.clone(), context.clone()).await.unwrap_err();
        assert!(error.contains("版本已变化"));
        let error = BuiltinToolRegistry.execute("wiki.write_page", json!({"path":path,"content":"不应覆盖",
            "allowOverwrite":true,"expectedRevision":version}), context.clone()).await.unwrap_err();
        assert!(error.contains("版本已变化"));
        let current = super::super::wiki_files::revision(&expected);
        for old_text in ["保留正文", "不存在的片段", ""] {
            assert!(BuiltinToolRegistry.execute("wiki.patch_page", json!({"path":path,"expectedRevision":current,
                "oldText":old_text,"newText":"替换"}), context.clone()).await.is_err());
            assert_eq!(fs::read_to_string(root.join(path)).unwrap(), expected);
        }
        let ordinary = ToolContext { review_conversation: false, ..context.clone() };
        assert!(BuiltinToolRegistry.execute("wiki.patch_page", patch, ordinary).await.unwrap_err().contains("仅用于审阅"));
        // 重要页面继续生成审批草稿，补丁不能绕过原有保护。
        crate::commands::file_approval::set_important_file(root.to_string_lossy().into_owned(), root.join(path).to_string_lossy().into_owned(), true).unwrap();
        let error = BuiltinToolRegistry.execute("wiki.patch_page", json!({"path":path,"expectedRevision":current,
            "oldText":"参见 [[新概念]]","newText":"参见 [[再次修改]]"}), context).await.unwrap_err();
        assert!(error.contains("FILE_APPROVAL_REQUIRED"));
        assert_eq!(fs::read_to_string(root.join(path)).unwrap(), expected);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_wiki_page_rejects_traversal() {
        let err = read_wiki_page("/tmp/project", "../secret.md").unwrap_err();
        assert!(err.contains("wiki.read_page"));
    }

    /// 页面存在但目录猜错时，应返回准确候选路径，不能把其他页面内容冒充请求结果。
    #[test]
    fn read_wiki_page_missing_path_reports_existing_filename_candidates() {
        let root = std::env::temp_dir().join(format!("llm-wiki-missing-page-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/integrations")).unwrap();
        let filename = "YPD应用构建六步接入指引.md";
        let requested = format!("wiki/designs/{filename}");
        let actual = format!("wiki/integrations/{filename}");
        let content = "# 页面原文\n不能将候选内容冒充已读取的请求结果。";
        fs::write(root.join(&actual), content).unwrap();

        let error = read_wiki_page(root.to_str().unwrap(), &requested).unwrap_err();
        let actual_content = read_wiki_page(root.to_str().unwrap(), &actual).unwrap();
        let unknown_error = read_wiki_page(root.to_str().unwrap(), "wiki/designs/不存在.md").unwrap_err();
        fs::remove_dir_all(root).unwrap();

        assert!(error.contains(&requested), "应指出失败的具体路径：{error}");
        assert!(error.contains(&actual), "应列出真实同名文件：{error}");
        assert!(error.contains("Retry wiki.read_page"));
        assert!(!error.contains(content));
        assert_eq!(actual_content, content);
        assert!(unknown_error.contains("wiki/designs/不存在.md"));
        assert!(unknown_error.contains("wiki.search"));
        assert!(!unknown_error.contains(&actual), "不能把无关页面当作候选");
    }

    #[test]
    fn knowledge_context_indexes_tags_links_backlinks_and_latest_version() {
        let root = std::env::temp_dir().join(format!("llm-wiki-context-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki/entities")).unwrap();
        fs::write(
            root.join(".llm-wiki/history-settings.json"),
            r#"{"enabled":true,"maxVersionsPerFile":10}"#,
        )
        .unwrap();
        let alpha = root.join("wiki/entities/alpha.md");
        let beta = root.join("wiki/entities/beta.md");
        fs::write(
            &alpha,
            "---\r\ntitle: Alpha\r\ntags: [core, test]\r\n---\r\n# Alpha\r\n\r\n[[Beta]]",
        )
        .unwrap();
        fs::write(
            &beta,
            "---\ntitle: Beta\ntags:\n  - linked\n---\n# Beta\n\n[[entities/alpha]]",
        )
        .unwrap();
        crate::commands::file_history::record_file_version(&alpha, "agent", "test.write");

        let mut alpha_context = Some(read_knowledge_context(root.to_str().unwrap(), "wiki/entities/alpha.md", &fs::read_to_string(&alpha).unwrap()).unwrap());
        attach_latest_version(
            root.to_str().unwrap(),
            "wiki/entities/alpha.md",
            &mut alpha_context,
        );
        let alpha_context = alpha_context.as_ref().unwrap();
        let beta_context = read_knowledge_context(root.to_str().unwrap(), "wiki/entities/beta.md", &fs::read_to_string(root.join("wiki/entities/beta.md")).unwrap()).unwrap();

        assert_eq!(alpha_context.tags, vec!["core", "test"]);
        assert_eq!(alpha_context.outgoing_links, vec!["wiki/entities/beta.md"]);
        assert_eq!(alpha_context.backlinks, vec!["wiki/entities/beta.md"]);
        assert_eq!(alpha_context.link_count, 2);
        assert_eq!(
            alpha_context.latest_version.as_ref().unwrap().tool,
            "test.write"
        );
        assert_eq!(beta_context.tags, vec!["linked"]);
        assert_eq!(beta_context.backlinks, vec!["wiki/entities/alpha.md"]);

        let _ = fs::remove_dir_all(root);
    }

    /// 通过真实工具入口删除重复页，核对文件、引用和索引的完整输出契约。
    #[tokio::test]
    async fn delete_page_tool_cleans_references_and_preserves_other_pages() {
        let root = std::env::temp_dir().join(format!("llm-wiki-delete-tool-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::write(root.join("wiki/concepts/duplicate.md"), "---\ntitle: 重复页\n---\n# 旧内容").unwrap();
        fs::write(root.join("wiki/index.md"), "# 目录\n- [[concepts/duplicate|重复页]]\n- [[kept]]\n").unwrap();
        fs::write(root.join("wiki/concepts/kept.md"), "---\nrelated: [concepts/duplicate, other]\n---\n[[concepts/duplicate|旧说明]] [[other]]").unwrap();
        let result = BuiltinToolRegistry.execute("wiki.delete_page", json!({"path": "wiki/concepts/duplicate.md"}), ToolContext {
            project_path: root.to_str().unwrap(), review_conversation: true,
            embedding_config: None, web_search_config: None, anytxt_config: None,
        }).await;
        assert!(result.is_ok(), "专用工具必须可执行：{result:?}");
        let output = result.unwrap();
        assert_eq!(output["deletedPaths"], json!(["wiki/concepts/duplicate.md"]));
        assert!(!root.join("wiki/concepts/duplicate.md").exists());
        assert_eq!(fs::read_to_string(root.join("wiki/index.md")).unwrap(), "# 目录\n- [[kept]]\n");
        let kept = fs::read_to_string(root.join("wiki/concepts/kept.md")).unwrap();
        assert!(kept.contains("旧说明 [[other]]"));
        assert!(!kept.contains("concepts/duplicate"));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn conversation_write_queues_source_without_bypassing_shared_ingest() {
        // 从 Agent 实际工具入口提交不同文件名的同主题内容，旧知识页必须保持不变。
        let root = std::env::temp_dir().join(format!("llm-wiki-conversation-ingest-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::write(root.join("wiki/concepts/redis-cache.md"), "# Redis 缓存\n原有事实。").unwrap();
        let content = "# Redis 缓存策略\n对话确认的新事实。";
        // 普通会话即使模型传入覆盖或审阅标记，也不能改变由请求上下文决定的入库方式。
        let output = BuiltinToolRegistry.execute("wiki.write_page", json!({
            "path": "wiki/concepts/cache-strategy.md", "content": content,
            "allowOverwrite": true, "reviewConversation": true
        }), ToolContext {
            project_path: root.to_str().unwrap(), review_conversation: false, embedding_config: None,
            web_search_config: None, anytxt_config: None,
        }).await.unwrap();

        assert_eq!(output["ingestQueued"], true, "必须进入公共入库流程");
        assert!(!root.join("wiki/concepts/cache-strategy.md").exists(), "不能绕过查重直接新建页");
        assert_eq!(fs::read_to_string(root.join("wiki/concepts/redis-cache.md")).unwrap(), "# Redis 缓存\n原有事实。");
        let source = output["path"].as_str().unwrap();
        assert!(source.starts_with("raw/sources/conversations/"));
        assert_eq!(fs::read_to_string(root.join(source)).unwrap(), content, "完整保留对话材料作为来源");
        fs::remove_dir_all(root).unwrap();
    }

    /// 审阅中的修正和补页直接落盘，覆盖保护及项目路径边界与正常页面写入一致。
    #[tokio::test]
    async fn review_write_persists_pages_with_overwrite_and_path_guards() {
        let root = std::env::temp_dir().join(format!("llm-wiki-review-write-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        let page_path = "wiki/concepts/reviewed.md";
        fs::write(root.join(page_path), "# 原页面").unwrap();
        let context = ToolContext {
            project_path: root.to_str().unwrap(), review_conversation: true,
            embedding_config: None, web_search_config: None, anytxt_config: None,
        };
        let registry = BuiltinToolRegistry;
        let error = registry.execute("wiki.write_page", json!({
            "path": page_path, "content": "# 已确认的修正"
        }), context.clone()).await.unwrap_err();
        assert!(error.contains("allowOverwrite=true"));
        assert_eq!(fs::read_to_string(root.join(page_path)).unwrap(), "# 原页面");

        let output = registry.execute("wiki.write_page", json!({
            "path": page_path, "content": "# 已确认的修正", "allowOverwrite": true
        }), context.clone()).await.unwrap();
        assert_eq!(output["ingestQueued"], false);
        assert_eq!(output["path"], page_path);
        assert_eq!(output["previousContent"], "# 原页面");
        assert_eq!(fs::read_to_string(root.join(page_path)).unwrap(), "# 已确认的修正");

        // 缺页类审阅可直接创建确认后的页面，也无需先将新页作为来源重新提取。
        let new_path = "wiki/concepts/missing.md";
        let created = registry.execute("wiki.write_page", json!({
            "path": new_path, "content": "# 确认补充的页面"
        }), context.clone()).await.unwrap();
        assert_eq!(created["ingestQueued"], false);
        assert_eq!(created["existedBefore"], false);
        assert_eq!(fs::read_to_string(root.join(new_path)).unwrap(), "# 确认补充的页面");
        assert!(registry.execute("wiki.write_page", json!({
            "path": "../escape.md", "content": "# 越界"
        }), context).await.is_err());
        assert!(!root.join("raw/sources/conversations").exists());
        assert!(super::super::ingest::list_conversation_ingests(root.to_string_lossy().into_owned()).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn registry_executes_declared_read_page_tool() {
        let root = std::env::temp_dir().join(format!("llm-wiki-tool-registry-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki").join("concepts")).unwrap();
        fs::write(root.join("wiki/concepts/a.md"), "# A\n\nBody").unwrap();

        let registry = BuiltinToolRegistry;
        let context = ToolContext {
            project_path: root.to_str().unwrap(),
            review_conversation: false,
            embedding_config: None,
            web_search_config: None,
            anytxt_config: None,
        };
        let read = registry
            .execute(
                "wiki.read_page",
                json!({ "path": "wiki/concepts/a.md" }),
                context.clone(),
            )
            .await
            .unwrap();
        assert_eq!(read["path"], "wiki/concepts/a.md");
        assert!(read["content"].as_str().unwrap().contains("Body"));

        // 已下线的研究工具既不能被发现，也不能通过旧名称继续执行。
        assert!(!registry.specs().iter().any(|tool| tool.name == "deep_research.run"));
        let removed = registry
            .execute("deep_research.run", json!({ "query": "topic" }), context)
            .await;
        assert!(removed.unwrap_err().contains("Unknown Agent tool"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn registry_executes_project_scoped_shell_command() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-tool-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let registry = BuiltinToolRegistry;
        let context = ToolContext {
            project_path: root.to_str().unwrap(),
            review_conversation: false,
            embedding_config: None,
            web_search_config: None,
            anytxt_config: None,
        };
        let output = registry
            .execute(
                "shell.exec",
                json!({ "command": "echo skill-ok", "timeoutSeconds": 5 }),
                context,
            )
            .await
            .unwrap();
        assert!(output["stdout"].as_str().unwrap().contains("skill-ok"));
        assert_eq!(output["timedOut"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_exec_timeout_returns_without_unbounded_wait() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-timeout-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        #[cfg(windows)]
        let command = "ping -n 6 127.0.0.1 > nul";
        #[cfg(not(windows))]
        let command = "sleep 5";
        let output = run_shell_exec(root.to_str().unwrap(), command, 1)
            .await
            .unwrap();
        assert!(output.timed_out);
        assert!(output.stderr.contains("timed out"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn shell_exec_does_not_wait_forever_for_background_pipe_holders() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-bg-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let output = timeout(
            Duration::from_secs(3),
            run_shell_exec(root.to_str().unwrap(), "sleep 5 &", 5),
        )
        .await
        .expect("shell.exec should not hang on background grandchildren")
        .unwrap();
        assert!(output.stdout.contains("output was still open"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn shell_exec_sanitizes_environment() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-env-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        std::env::set_var("LLM_WIKI_SECRET_TEST_SENTINEL", "must-not-leak");
        let output = run_shell_exec(root.to_str().unwrap(), "env", 5)
            .await
            .unwrap();
        std::env::remove_var("LLM_WIKI_SECRET_TEST_SENTINEL");
        assert!(output
            .stdout
            .contains(&format!("LLM_WIKI_PROJECT={}", root.to_string_lossy())));
        assert!(output.stdout.contains(&format!(
            "LLM_WIKI_AGENT_WORKSPACE={}",
            root.join(AGENT_WORKSPACE_DIR).to_string_lossy()
        )));
        assert!(!output.stdout.contains("LLM_WIKI_SECRET_TEST_SENTINEL="));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_exec_runs_from_visible_agent_workspace() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-shell-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        #[cfg(windows)]
        let command = "cd && echo hello>generated.txt";
        #[cfg(not(windows))]
        let command = "pwd && printf hello > generated.txt";

        let output = run_shell_exec(root.to_str().unwrap(), command, 5)
            .await
            .unwrap();
        let workspace = root.join(AGENT_WORKSPACE_DIR);

        assert!(workspace.is_dir());
        assert_eq!(
            fs::read_to_string(workspace.join("generated.txt"))
                .unwrap()
                .trim(),
            "hello"
        );
        assert!(!root.join("generated.txt").exists());
        assert!(output
            .stdout
            .replace('\\', "/")
            .contains(&workspace.to_string_lossy().replace('\\', "/")));
        assert!(output
            .generated_files
            .iter()
            .any(|file| file.path == "agent-workspace/generated.txt"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_exec_reports_changed_workspace_files() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-shell-generated-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        #[cfg(windows)]
        let command = "mkdir images && echo image>images\\cover.png";
        #[cfg(not(windows))]
        let command = "mkdir -p images && printf image > images/cover.png";

        let output = run_shell_exec(root.to_str().unwrap(), command, 5)
            .await
            .unwrap();

        assert!(output
            .generated_files
            .iter()
            .any(|file| { file.path == "agent-workspace/images/cover.png" && file.bytes > 0 }));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_exec_rejects_symlinked_agent_workspace_escape() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("llm-wiki-shell-workspace-link-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!(
            "llm-wiki-shell-workspace-outside-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(AGENT_WORKSPACE_DIR)).unwrap();

        let err = run_shell_exec(root.to_str().unwrap(), "pwd", 5)
            .await
            .unwrap_err();

        assert!(err.contains("escapes project directory"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn changed_workspace_files_detects_same_size_rewrites() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-shell-same-size-{}", Uuid::new_v4()));
        let workspace = root.join(AGENT_WORKSPACE_DIR);
        fs::create_dir_all(&workspace).unwrap();
        let file = workspace.join("artifact.html");
        fs::write(&file, "before").unwrap();

        let before = snapshot_workspace_files(&workspace);
        fs::write(&file, "after!").unwrap();
        let changed = changed_workspace_files(&workspace, before);

        assert!(changed
            .iter()
            .any(|file| file.path == "agent-workspace/artifact.html"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_write_file_writes_only_visible_agent_workspace_files() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-workspace-write-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let written =
            write_workspace_file(root.to_str().unwrap(), "cover-image/cover.svg", "<svg/>")
                .unwrap();
        assert_eq!(written.path, "agent-workspace/cover-image/cover.svg");
        assert!(!written.existed_before);
        assert_eq!(written.previous_content, None);
        assert_eq!(
            fs::read_to_string(root.join("agent-workspace/cover-image/cover.svg")).unwrap(),
            "<svg/>"
        );
        assert!(write_workspace_file(root.to_str().unwrap(), "../escape.txt", "x").is_err());
        assert!(write_workspace_file(root.to_str().unwrap(), "wiki/page.md", "x").is_err());
        assert!(write_workspace_file(root.to_str().unwrap(), ".hidden/file.txt", "x").is_err());
        assert!(write_workspace_file(root.to_str().unwrap(), "cover./file.txt", "x").is_err());
        assert!(write_workspace_file(root.to_str().unwrap(), "cover /file.txt", "x").is_err());
        assert!(write_workspace_file(
            root.to_str().unwrap(),
            "large.txt",
            &"x".repeat(MAX_WORKSPACE_WRITE_BYTES + 1)
        )
        .unwrap_err()
        .contains("too large"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_append_file_extends_visible_workspace_files() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-workspace-append-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        write_workspace_file(root.to_str().unwrap(), "ppt/index.html", "<html>").unwrap();
        let appended =
            append_workspace_file(root.to_str().unwrap(), "ppt/index.html", "</html>").unwrap();

        assert_eq!(appended.path, "agent-workspace/ppt/index.html");
        assert_eq!(appended.bytes, "<html></html>".len());
        assert!(appended.existed_before);
        assert_eq!(appended.previous_content.as_deref(), Some("<html>"));
        assert_eq!(
            fs::read_to_string(root.join("agent-workspace/ppt/index.html")).unwrap(),
            "<html></html>"
        );
        assert!(append_workspace_file(root.to_str().unwrap(), "../escape.txt", "x").is_err());
        assert!(append_workspace_file(root.to_str().unwrap(), ".hidden/file.txt", "x").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_write_file_rejects_target_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("llm-wiki-workspace-symlink-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-workspace-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(AGENT_WORKSPACE_DIR)).unwrap();
        fs::write(&outside, "original").unwrap();
        symlink(&outside, root.join(AGENT_WORKSPACE_DIR).join("escape.txt")).unwrap();

        assert!(
            write_workspace_file(root.to_str().unwrap(), "escape.txt", "overwrite")
                .unwrap_err()
                .contains("symlink")
        );
        assert_eq!(fs::read_to_string(&outside).unwrap(), "original");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn shell_exec_caps_large_output() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-cap-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let output = run_shell_exec(root.to_str().unwrap(), "printf '%050000d' 0", 5)
            .await
            .unwrap();
        assert!(output.stdout.chars().count() <= MAX_SHELL_OUTPUT_CHARS + 3);
        assert!(output.stdout.ends_with("..."));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_exec_rejects_invalid_inputs() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-invalid-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert!(run_shell_exec(root.to_str().unwrap(), "", 1)
            .await
            .unwrap_err()
            .contains("empty"));
        assert!(run_shell_exec(
            root.to_str().unwrap(),
            &"x".repeat(MAX_SHELL_COMMAND_CHARS + 1),
            1
        )
        .await
        .unwrap_err()
        .contains("too long"));
        let missing = root.join("missing");
        assert!(run_shell_exec(missing.to_str().unwrap(), "echo no", 1)
            .await
            .unwrap_err()
            .contains("not available"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn write_wiki_page_rejects_unindexable_names_before_creating_files() {
        let root = std::env::temp_dir().join(format!("llm-wiki-indexable-write-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();
        // 使用真实写页入口，确认非法名称不会留下文件，正文引号仍然允许。
        for name in ["Can't", "zero\u{200b}width", &"x".repeat(257)] {
            let rel = format!("wiki/{name}.md");
            let error = write_wiki_page_with_options(root.to_str().unwrap(), &rel, "正文", false)
                .unwrap_err();
            assert!(error.contains("无法建立索引"));
            assert!(!root.join(&rel).exists());
        }
        write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/cant.md",
            "# Can't find attribute",
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("wiki/cant.md")).unwrap(),
            "# Can't find attribute"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_wiki_page_rejects_unsafe_paths_and_writes_markdown() {
        let root = std::env::temp_dir().join(format!("llm-wiki-agent-write-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();

        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "../secret.md",
            "# Secret",
            false
        )
        .is_err());
        let absolute_error = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "/wiki/absolute.md",
            "# Absolute",
            false,
        )
        .unwrap_err();
        assert!(absolute_error.contains("must stay inside the project"));
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "raw/sources/a.md",
            "# A",
            false
        )
        .is_err());
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/.hidden/a.md",
            "# A",
            false
        )
        .is_err());
        assert!(
            write_wiki_page_with_options(root.to_str().unwrap(), "wiki/aux.md", "# A", false)
                .is_err()
        );
        assert!(
            write_wiki_page_with_options(root.to_str().unwrap(), "wiki/con.md", "# A", false)
                .is_err()
        );
        assert!(
            write_wiki_page_with_options(root.to_str().unwrap(), "wiki/a:b.md", "# A", false)
                .is_err()
        );
        assert!(
            write_wiki_page_with_options(root.to_str().unwrap(), "wiki/a?b.md", "# A", false)
                .is_err()
        );
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/topic./a.md",
            "# A",
            false
        )
        .is_err());
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/topic /a.md",
            "# A",
            false
        )
        .is_err());
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/queries/huge.md",
            &"x".repeat(MAX_WRITE_PAGE_BYTES + 1),
            false,
        )
        .is_err());

        let reference = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/queries/new-page.md",
            "---\ntitle: New Page\n---\n# New Page\n\nBody",
            false,
        )
        .unwrap();
        assert_eq!(reference.title, "New Page");
        assert_eq!(reference.path, "wiki/queries/new-page.md");
        assert!(root.join("wiki/queries/new-page.md").exists());
        let overwrite_err = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/queries/new-page.md",
            "# Replaced",
            false,
        )
        .unwrap_err();
        assert!(overwrite_err.contains("refuses to overwrite"));
        let overwritten = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/queries/new-page.md",
            "# Replaced",
            true,
        )
        .unwrap();
        assert_eq!(overwritten.title, "Replaced");

        let verified = write_wiki_page_verified(
            root.to_str().unwrap(),
            "wiki/queries/verified.md",
            "# Verified\n",
            false,
        )
        .unwrap();
        assert_eq!(verified.path, "wiki/queries/verified.md");
        assert_eq!(verified.bytes, "# Verified\n".len());
        assert!(verified.verified);
        assert!(!verified.existed_before);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn write_wiki_page_refuses_symlink_targets() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-agent-link-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("purpose.md"), "protected").unwrap();
        symlink(root.join("purpose.md"), root.join("wiki/linked.md")).unwrap();

        let error = write_wiki_page_verified(
            root.to_str().unwrap(),
            "wiki/linked.md",
            "overwritten",
            true,
        )
        .unwrap_err();
        assert!(error.contains("symlink"));
        assert_eq!(
            fs::read_to_string(root.join("purpose.md")).unwrap(),
            "protected"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn wiki_write_activity_captures_create_and_overwrite_state() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-agent-write-activity-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();

        let created = write_wiki_page_with_activity(
            root.to_str().unwrap(),
            "wiki/page.md",
            "# Original",
            false,
        )
        .unwrap();
        assert!(!created.existed_before);
        assert_eq!(created.previous_content, None);

        let modified = write_wiki_page_with_activity(
            root.to_str().unwrap(),
            "wiki/page.md",
            "# Updated",
            true,
        )
        .unwrap();
        assert!(modified.existed_before);
        assert_eq!(modified.previous_content.as_deref(), Some("# Original"));
        assert_eq!(modified.reference.path, "wiki/page.md");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn write_wiki_page_rejects_symlink_parent_escape_for_new_files() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-agent-symlink-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-agent-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("wiki").join("linked")).unwrap();

        let err = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/linked/newsub/escape.md",
            "# Escape",
            false,
        )
        .unwrap_err();
        assert!(err.contains("escapes project directory"));
        assert!(!outside.join("newsub").exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn search_sources_returns_source_references() {
        let root = std::env::temp_dir().join(format!("llm-wiki-source-search-{}", Uuid::new_v4()));
        let source_dir = root.join("raw").join("sources");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("paper.txt"), "Coal mine safety case study.").unwrap();

        let refs = search_sources(root.to_str().unwrap(), "safety", 5).await.unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].kind, "source");
        assert!(refs[0].snippet.as_deref().unwrap().contains("safety"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn search_sources_reads_org_and_fresh_binary_extraction_cache() {
        let root = std::env::temp_dir().join(format!("llm-wiki-source-cache-{}", Uuid::new_v4()));
        let source_dir = root.join("raw").join("sources");
        fs::create_dir_all(source_dir.join(".cache")).unwrap();
        fs::write(source_dir.join("notes.org"), "* Policy\nExact org wording").unwrap();
        let pdf = source_dir.join("regulation.pdf");
        fs::write(&pdf, b"%PDF placeholder").unwrap();
        fs::write(
            source_dir.join(".cache").join("regulation.pdf.txt"),
            "Exact cached regulation wording",
        )
        .unwrap();

        let org_refs = search_sources(root.to_str().unwrap(), "org wording", 5).await.unwrap();
        let pdf_refs = search_sources(root.to_str().unwrap(), "cached regulation", 5).await.unwrap();

        assert!(org_refs
            .iter()
            .any(|reference| reference.path == "raw/sources/notes.org"));
        let pdf_ref = pdf_refs
            .iter()
            .find(|reference| reference.path == "raw/sources/regulation.pdf")
            .unwrap();
        assert!(pdf_ref
            .snippet
            .as_deref()
            .unwrap()
            .contains("cached regulation"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn source_and_graph_search_skip_hidden_paths() {
        let root = std::env::temp_dir().join(format!("llm-wiki-hidden-search-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("raw/sources/.cache")).unwrap();
        fs::create_dir_all(root.join("wiki/.hidden")).unwrap();
        fs::write(root.join("raw/sources/.cache/secret.txt"), "needle secret").unwrap();
        fs::write(
            root.join("wiki/.hidden/secret.md"),
            "# Secret\n\nneedle [[A]]",
        )
        .unwrap();

        assert!(search_sources(root.to_str().unwrap(), "needle", 5).await
            .unwrap()
            .is_empty());
        assert!(search_graph(root.to_str().unwrap(), "needle", 5).await
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn search_sources_uses_keyword_terms_from_natural_language() {
        let root = std::env::temp_dir().join(format!("llm-wiki-source-search-{}", Uuid::new_v4()));
        let source_dir = root.join("raw").join("sources");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("煤矿.txt"), "煤矿安全治理 source details.").unwrap();

        let refs = search_sources(root.to_str().unwrap(), "原始资料 煤矿安全", 5).await.unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].kind, "source");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn search_graph_returns_relationship_references() {
        let root = std::env::temp_dir().join(format!("llm-wiki-graph-search-{}", Uuid::new_v4()));
        let wiki_dir = root.join("wiki").join("concepts");
        fs::create_dir_all(&wiki_dir).unwrap();
        fs::write(
            wiki_dir.join("agent.md"),
            "---\ntitle: Agent Graph\n---\n# Agent Graph\n\nLinks to [[Tool Registry]] and [[Context Builder]].",
        )
        .unwrap();
        fs::write(
            wiki_dir.join("tool-registry.md"),
            "---\ntitle: Tool Registry\n---\n# Tool Registry\n\nTool definitions.",
        )
        .unwrap();
        fs::write(
            wiki_dir.join("context-builder.md"),
            "---\ntitle: Context Builder\n---\n# Context Builder\n\nContext assembly.",
        )
        .unwrap();
        fs::write(
            wiki_dir.join("unrelated.md"),
            "---\ntitle: Unrelated Hub\n---\n# Unrelated Hub\n\n[[Missing A]] [[Missing B]] [[Missing C]].",
        )
        .unwrap();

        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::write(root.join(".llm-wiki/retrieval.json"), r#"{"graph":true}"#).unwrap();
        let refs = search_graph(root.to_str().unwrap(), "Agent Graph", 5).await.unwrap();
        // 无关邻居不为凑数强行返回；真实方向的引用边仍随正文进入模型。
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].title, "Agent Graph");
        let context = refs[0].knowledge_context.as_ref().unwrap();
        assert!(!context.evidence.is_empty());
        assert_eq!(context.relations.len(), 2);
        assert!(context.relations.iter().all(|edge| edge["fromPath"] == "wiki/concepts/agent.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn searxng_url_normalizes_to_search_endpoint() {
        assert_eq!(
            normalize_searxng_url("search.example.com").unwrap(),
            "https://search.example.com/search"
        );
        assert_eq!(
            normalize_searxng_url("https://search.example.com/search").unwrap(),
            "https://search.example.com/search"
        );
    }

    #[test]
    fn friendly_firecrawl_error_explains_key_free_ip_rejection() {
        let msg = friendly_firecrawl_error("Unfortunately, your IP address looks suspicious");
        assert!(msg.contains("rejected this IP"));
    }

    #[test]
    fn run_web_search_drops_empty_url_results_before_mapping_references() {
        let refs = web_items_to_references(
            vec![
                WebSearchItem {
                    title: "Missing".to_string(),
                    url: String::new(),
                    snippet: "no url".to_string(),
                },
                WebSearchItem {
                    title: "Valid".to_string(),
                    url: "https://example.com".to_string(),
                    snippet: "ok".to_string(),
                },
            ],
            10,
        );
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].title, "Valid");
        assert_eq!(refs[0].path, "https://example.com");
    }

    #[test]
    fn web_references_apply_limit_before_empty_url_filter_like_legacy_ui() {
        let refs = web_items_to_references(
            vec![
                WebSearchItem {
                    title: "Missing".to_string(),
                    url: String::new(),
                    snippet: "no url".to_string(),
                },
                WebSearchItem {
                    title: "Valid".to_string(),
                    url: "https://example.com".to_string(),
                    snippet: "ok".to_string(),
                },
            ],
            1,
        );
        assert!(refs.is_empty());
    }

    #[test]
    fn brave_message_without_web_is_treated_as_error() {
        let value = json!({ "message": "invalid subscription token" });
        assert_eq!(
            provider_payload_error("Brave Search", &value),
            Some("Brave Search search failed: invalid subscription token".to_string())
        );
    }

    #[test]
    fn bocha_payload_error_requires_success_code() {
        let failure = json!({ "code": 401, "msg": "invalid api key" });
        assert_eq!(
            provider_payload_error("Bocha Search", &failure),
            Some("Bocha Search failed (code 401): invalid api key".to_string())
        );
        assert_eq!(
            provider_payload_error("Bocha Search", &json!({ "code": 200, "data": {} })),
            None
        );
    }

    #[test]
    fn bocha_results_prefer_summary_and_fall_back_to_snippet() {
        let items = parse_bocha_results(json!({
            "code": 200,
            "data": {
                "webPages": {
                    "value": [
                        {
                            "name": "Summary result",
                            "url": "https://example.com/summary",
                            "snippet": "short",
                            "summary": "long summary"
                        },
                        {
                            "name": "Snippet result",
                            "url": "https://example.com/snippet",
                            "summary": null,
                            "snippet": "fallback snippet"
                        }
                    ]
                }
            }
        }));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Summary result");
        assert_eq!(items[0].snippet, "long summary");
        assert_eq!(items[1].snippet, "fallback snippet");
    }

    #[test]
    fn bocha_accepts_fifty_results_without_changing_other_provider_limits() {
        assert_eq!(web_search_result_limit("bocha", 100), 50);
        assert_eq!(web_search_result_limit("tavily", 100), 20);
        assert_eq!(web_search_result_limit("bocha", 0), 1);
    }

    #[test]
    fn non_brave_message_does_not_mask_valid_provider_payloads() {
        let value = json!({ "message": "FYI" });
        assert_eq!(provider_payload_error("Tavily", &value), None);
    }

    #[test]
    fn web_result_normalization_accepts_firecrawl_nested_metadata() {
        let items = extract_web_items(
            &json!({
                "data": {
                    "web": [
                        {
                            "metadata": {
                                "title": "Nested",
                                "sourceURL": "https://example.com/nested",
                                "description": "from metadata"
                            }
                        }
                    ]
                }
            }),
            &["data", "results"],
        );
        let item = normalize_web_result(items.into_iter().next().unwrap());
        assert_eq!(item.title, "Nested");
        assert_eq!(item.url, "https://example.com/nested");
        assert_eq!(item.snippet, "from metadata");
    }

    #[test]
    fn url_encode_handles_unicode_terms() {
        assert_eq!(url_encode("煤矿 safety"), "%E7%85%A4%E7%9F%BF+safety");
    }

    #[test]
    fn web_search_config_resolves_active_provider_override() {
        let mut configs = BTreeMap::new();
        configs.insert(
            "searxng".to_string(),
            WebSearchProviderOverride {
                sear_xng_url: Some("https://search.example.com".to_string()),
                ..Default::default()
            },
        );
        let cfg = WebSearchConfig {
            provider: "searxng".to_string(),
            provider_configs: Some(configs),
            ..Default::default()
        }
        .resolved();

        assert_eq!(
            cfg.sear_xng_url.as_deref(),
            Some("https://search.example.com")
        );
    }

    #[test]
    fn extract_anytxt_items_accepts_common_result_shapes() {
        let value = json!({
            "result": {
                "items": [
                    { "path": "/docs/a.pdf", "title": "A", "snippet": "coal mine" }
                ]
            }
        });
        let items = extract_anytxt_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "A");
        assert_eq!(items[0].path, "/docs/a.pdf");
        assert_eq!(items[0].snippet, "coal mine");
    }

    #[test]
    fn extract_anytxt_items_accepts_nested_output_and_field_rows() {
        let value = json!({
            "result": {
                "output": {
                    "field": ["fid", "full_path", "title", "hitText"],
                    "items": [
                        ["42", "/docs/煤矿.pdf", "煤矿资料", "煤矿安全治理片段"]
                    ]
                }
            }
        });
        let items = extract_anytxt_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].fid, "42");
        assert_eq!(items[0].path, "/docs/煤矿.pdf");
        assert_eq!(items[0].title, "煤矿资料");
        assert_eq!(items[0].snippet, "煤矿安全治理片段");
    }

    #[test]
    fn extract_anytxt_items_keeps_fid_only_results_addressable() {
        let value = json!({
            "result": {
                "data": {
                    "results": [
                        { "fid": 99, "snippet": "fragment only" }
                    ]
                }
            }
        });
        let items = extract_anytxt_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path, "anytxt://99");
        assert_eq!(items[0].snippet, "fragment only");
    }

    #[test]
    fn extract_anytxt_items_accepts_value_shapes() {
        let value = json!({
            "result": {
                "output": {
                    "value": [
                        { "path": "/docs/value.txt", "snippet": "from value" }
                    ]
                }
            }
        });
        let items = extract_anytxt_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path, "/docs/value.txt");
        assert_eq!(items[0].snippet, "from value");
    }
}
