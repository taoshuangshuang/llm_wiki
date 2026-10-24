/** 项目级入库策略：默认 Markdown 首次落盘，已有文件直接读取，不覆盖用户配置。 */
import { createDirectory, fileExists, readFile, writeFile } from "@/commands/fs"
import knowledgeExtraction from "./ingest-prompts/01-04-知识单元与检索词提取规则.md?raw"
import analysis from "./ingest-prompts/01-03-独立成页与名称复用规则.md?raw"
import generation from "./ingest-prompts/02-02-独立页面写作规则.md?raw"
import merge from "./ingest-prompts/04-02-页面内容合并规则.md?raw"
import classification from "./ingest-prompts/05-02-业务模块选择规则.md?raw"
import review from "./ingest-prompts/03-02-待审查事项筛选规则.md?raw"
import analysisTemplate from "./ingest-prompts/01-01-来源文档分析.md?raw"
import generationTemplate from "./ingest-prompts/02-01-Wiki页面生成.md?raw"
import chunkAnalysisTemplate from "./ingest-prompts/01-02-长文分块分析.md?raw"
import reviewTemplate from "./ingest-prompts/03-01-待审查事项分析.md?raw"
import mergeTemplate from "./ingest-prompts/04-01-页面合并任务.md?raw"
import classificationTemplate from "./ingest-prompts/05-01-业务模块分类.md?raw"
import researchQuery from "./ingest-prompts/02-03-研究搜索词生成规则.md?raw"
import reviewRequest from "./ingest-prompts/03-03-待审查事项分析请求.md?raw"
import acceptance from "./ingest-prompts/06-01-最终验收规则.md?raw"
import acceptanceRepair from "./ingest-prompts/06-02-验收修复补录规则.md?raw"

export const DEFAULT_INGEST_PROMPTS = {
  analysis, knowledgeExtraction, generation, merge, classification, review,
  analysisTemplate, generationTemplate, chunkAnalysisTemplate, reviewTemplate,
  mergeTemplate, classificationTemplate, researchQuery, reviewRequest, acceptance, acceptanceRepair,
}
export type IngestPrompts = typeof DEFAULT_INGEST_PROMPTS
/** 当前文件名与历史名称；始终优先使用当前名称，不混合配置。 */
const PROMPT_FILES: Record<keyof IngestPrompts, { name: string; aliases: readonly string[] }> = {
  knowledgeExtraction: { name: "01-04-知识单元与检索词提取规则.md", aliases: [] },
  analysisTemplate: { name: "01-01-来源文档分析.md", aliases: ["02-01-来源文档分析.md", "来源文档分析.md", "analysis-template.md"] },
  chunkAnalysisTemplate: { name: "01-02-长文分块分析.md", aliases: ["02-02-长文分块分析.md", "长文分块分析.md", "chunk-analysis-template.md"] },
  analysis: { name: "01-03-独立成页与名称复用规则.md", aliases: ["02-03-独立成页与名称复用规则.md", "独立成页与名称复用规则.md", "analysis.md"] },
  generationTemplate: { name: "02-01-Wiki页面生成.md", aliases: ["03-01-Wiki页面生成.md", "Wiki页面生成.md", "generation-template.md"] },
  generation: { name: "02-02-独立页面写作规则.md", aliases: ["03-02-独立页面写作规则.md", "独立页面写作规则.md", "generation.md"] },
  researchQuery: { name: "02-03-研究搜索词生成规则.md", aliases: ["03-03-研究搜索词生成规则.md", "研究搜索词生成规则.md", "research-query.md"] },
  reviewTemplate: { name: "03-01-待审查事项分析.md", aliases: ["04-01-待审查事项分析.md", "待审查事项分析.md", "review-template.md"] },
  review: { name: "03-02-待审查事项筛选规则.md", aliases: ["04-02-待审查事项筛选规则.md", "待审查事项筛选规则.md", "review.md"] },
  reviewRequest: { name: "03-03-待审查事项分析请求.md", aliases: ["04-03-待审查事项分析请求.md", "待审查事项分析请求.md", "review-request.md"] },
  mergeTemplate: { name: "04-01-页面合并任务.md", aliases: ["05-01-页面合并任务.md", "页面合并任务.md", "page-merge-template.md"] },
  merge: { name: "04-02-页面内容合并规则.md", aliases: ["05-02-页面内容合并规则.md", "页面内容合并规则.md", "page-merge.md"] },
  classificationTemplate: { name: "05-01-业务模块分类.md", aliases: ["06-01-业务模块分类.md", "业务模块分类.md", "module-classification-template.md"] },
  classification: { name: "05-02-业务模块选择规则.md", aliases: ["06-02-业务模块选择规则.md", "业务模块选择规则.md", "module-classification.md"] },
  acceptance: { name: "06-01-最终验收规则.md", aliases: [] },
  acceptanceRepair: { name: "06-02-验收修复补录规则.md", aliases: [] },
}

/** 依次查找当前名称、之前的序号名称、无序号中文名称和原英文名称。 */
async function findProjectPromptFile(directory: string, key: keyof IngestPrompts): Promise<string | null> {
  const file = PROMPT_FILES[key]
  for (const candidate of [file.name, ...file.aliases]) {
    const path = `${directory}/${candidate}`
    if (await fileExists(path)) return path
  }
  return null
}

/** 单次替换中英文模板变量，支持按上下文是否存在保留整段；来源中的同名占位符不再展开。 */
export function renderIngestPromptTemplate(
  template: string, values: Record<string, string>, required: readonly string[] = [],
): string {
  for (const key of required) {
    if (!template.includes(`{{${key}}}`)) throw new Error(`入库提示词模板缺少必要变量：{{${key}}}`)
  }
  const valueOf = (key: string): string => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`入库提示词模板包含未知变量：{{${key}}}`)
    return values[key]
  }
  const conditions: Array<{ key: string; enabled: boolean }> = []
  const lines: string[] = []
  for (const line of template.split(/\r?\n/)) {
    const boundary = line.match(/^\{\{([#/])([\p{L}_]+)\}\}$/u)
    if (boundary) {
      const [, kind, key] = boundary
      if (kind === "#") conditions.push({ key, enabled: Boolean(valueOf(key)) })
      else if (conditions.pop()?.key !== key) throw new Error(`入库提示词模板条件未匹配：${line}`)
      continue
    }
    if (conditions.some((condition) => !condition.enabled)) continue
    const slot = line.match(/^\{\{([\p{L}_]+)\}\}$/u)
    if (slot && !valueOf(slot[1])) continue
    lines.push(line.replace(/\{\{([\p{L}_]+)\}\}/gu, (_match, key: string) => valueOf(key)))
  }
  if (conditions.length) throw new Error("入库提示词模板条件缺少结束标记。")
  return lines.join("\n")
}

/** 只读当前项目策略；缺失或空文件使用默认值，修改后在下一次入库读取。 */
export async function loadProjectIngestPrompts(projectPath: string): Promise<IngestPrompts> {
  const directory = `${projectPath.replace(/\/+$/, "")}/prompts`
  const policies = { ...DEFAULT_INGEST_PROMPTS }
  for (const key of Object.keys(PROMPT_FILES) as (keyof IngestPrompts)[]) {
    const path = await findProjectPromptFile(directory, key)
    if (!path) continue
    const content = await readFile(path)
    policies[key] = content.trim() ? content : DEFAULT_INGEST_PROMPTS[key]
  }
  return policies
}

/** 补齐配置：优先继承旧名文件的原文，已有新名文件不覆盖，旧文件不自动删除。 */
export async function initializeProjectIngestPrompts(projectPath: string): Promise<void> {
  const directory = `${projectPath.replace(/\/+$/, "")}/prompts`
  await createDirectory(directory)
  for (const key of Object.keys(PROMPT_FILES) as (keyof IngestPrompts)[]) {
    const path = `${directory}/${PROMPT_FILES[key].name}`
    const existingPath = await findProjectPromptFile(directory, key)
    if (existingPath === path) continue
    const content = existingPath
      ? await readFile(existingPath)
      : DEFAULT_INGEST_PROMPTS[key]
    await writeFile(path, content)
  }
}
