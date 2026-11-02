/** 项目规则编辑的有效值、兼容来源、变量契约与乐观版本保存。 */
import { fileExists, readFile, saveWorkflowFile } from "@/commands/fs"
import { DEFAULT_INGEST_PROMPTS, PROMPT_FILES, findProjectPromptFile, renderIngestPromptTemplate, type IngestPrompts } from "@/lib/ingest-prompts"
import { splitProjectSchema } from "@/lib/project-schema"
import { parseModuleCatalog } from "@/features/business-modules/catalog"
import type { WorkflowFile } from "./workflow-catalog"

export interface WorkflowDocumentDraft {
  path: string
  source: string
  expected: string | null
  original: string
  content: string
  defaultContent?: string
}
interface VariableContract { available: string[]; required: string[] }
const analysisVariables = ["language_rule", "schema_context", "purpose_context"]
export const PROMPT_VARIABLES: Partial<Record<keyof IngestPrompts, VariableContract>> = {
  analysisTemplate: { available: [...analysisVariables, "独立成页与名称复用规则", "index_context"], required: analysisVariables },
  chunkAnalysisTemplate: { available: [...analysisVariables, "独立成页与名称复用规则", "独立成页与名称复用规则_列表", "index_context"], required: analysisVariables },
  generationTemplate: { available: ["language_rule", "schema", "today", "source_identity", "独立页面写作规则", "completed_paths", "purpose_context", "index_context", "overview_context"], required: ["language_rule", "schema", "purpose_context", "source_identity", "today"] },
  mergeTemplate: { available: ["页面内容合并规则"], required: [] },
  classificationTemplate: { available: ["module_dictionary", "业务模块选择规则"], required: ["module_dictionary"] },
  pageMatchTemplate: { available: [], required: [] },
  truncatedRepairTemplate: { available: ["language_rule"], required: ["language_rule"] },
  interactiveAnalysisTemplate: { available: [...analysisVariables, "index_context"], required: [] },
  interactiveGenerationTemplate: { available: ["language_rule", "schema", "index_context", "source_identity"], required: [] },
}

export const VARIABLE_DESCRIPTIONS: Record<string, string> = {
  language_rule: "当前任务的 AI 输出语言名称；仅在输出语言节点编辑。",
  schema_context: "项目核心 Schema：页面类型、目录及领域约束。",
  schema: "生成使用的核心 Schema 与页面写作规范。",
  purpose_context: "项目根目录 purpose.md 的知识库目标。",
  index_context: "审阅可用的目录背景；分析和页面生成已停用此变量，旧模板引用时为空。",
  overview_context: "分析和页面生成已停用的旧概览变量，保留引用兼容但值为空。",
  source_identity: "本次来源身份，由程序传入。",
  today: "本次任务日期，由程序传入。",
  completed_paths: "本次已成功写入的页面路径 JSON，用于继续补写。",
  module_dictionary: "有效业务模块字典的 JSON。",
  独立成页与名称复用规则: "引用仅基于来源的成页规划与命名规则；不决定已有页复用。",
  独立成页与名称复用规则_列表: "同一成页规则逐行转换为列表。",
  独立页面写作规则: "引用独立页面写作规则文件。",
  页面内容合并规则: "引用新旧页面内容整合规则。",
  业务模块选择规则: "引用业务模块分类规则。",
}

export function workflowFilePath(file: WorkflowFile): string {
  return file.prompt ? `prompts/${PROMPT_FILES[file.prompt].name}` : file.document!
}

async function readOptional(path: string): Promise<string | null> {
  return await fileExists(path) ? readFile(path) : null
}

/** 根目录配置优先；旧拆分文件与旧单文件仅在根目录目标缺失时作为编辑初值。 */
export async function loadWorkflowDocument(projectPath: string, file: WorkflowFile): Promise<WorkflowDocumentDraft> {
  const root = projectPath.replace(/\/+$/, "")
  const path = workflowFilePath(file)
  const expected = await readOptional(`${root}/${path}`)
  let content = expected
  let source = expected === null ? "尚未创建" : path
  let defaultContent: string | undefined
  if (file.prompt) {
    defaultContent = DEFAULT_INGEST_PROMPTS[file.prompt]
    if (content === null) {
      const legacy = await findProjectPromptFile(`${root}/prompts`, file.prompt)
      if (legacy) { content = await readFile(legacy); source = legacy.slice(root.length + 1) }
    }
    if (!content?.trim()) { content = defaultContent; source += " · 当前使用内置默认值" }
  } else if (content === null && ["page-rules.md", "business-modules.md"].includes(path)) {
    content = await readOptional(`${root}/schema/${path}`)
    if (content !== null) source = `schema/${path}（保存时写入根目录）`
    else {
      const schema = await readOptional(`${root}/schema.md`) ?? await readOptional(`${root}/wiki/schema.md`) ?? ""
      const parts = splitProjectSchema(schema)
      content = path === "page-rules.md" ? parts.rules : parts.modules
      source = "继承旧 Schema 对应章节；保存时写入根目录"
    }
  } else if (content === null && path === "schema.md") {
    content = await readOptional(`${root}/wiki/schema.md`)
    if (content !== null) source = "wiki/schema.md（保存时写入根目录）"
  }
  return { path, source, expected, original: content ?? "", content: content ?? "", defaultContent }
}

/** 只校验实际支持的模板变量及必要协议，不把自然语言规则当模板二次展开。 */
export function validateWorkflowDocument(file: WorkflowFile, content: string): void {
  if (file.document === "business-modules.md" && content.trim() && !parseModuleCatalog(content)) {
    throw new Error("业务模块字典需包含 Business Modules 或业务模块章节，以及有效 JSON。清空文件可停用业务分类。")
  }
  if (!file.prompt) return
  if (!content.trim()) throw new Error("提示词不能为空；可使用恢复默认值。")
  const contract = PROMPT_VARIABLES[file.prompt]
  if (contract) renderIngestPromptTemplate(content, Object.fromEntries(contract.available.map((key) => [key, "示例值"])), contract.required)
  if (file.prompt === "backgroundReview" && !content.includes("contract: review-v2")) throw new Error("统一后台审阅必须保留 contract: review-v2。")
}

export async function saveWorkflowDocument(projectPath: string, file: WorkflowFile, draft: WorkflowDocumentDraft): Promise<WorkflowDocumentDraft> {
  validateWorkflowDocument(file, draft.content)
  await saveWorkflowFile(projectPath, draft.path, draft.expected, draft.content)
  return { ...draft, expected: draft.content, original: draft.content, source: draft.path }
}
