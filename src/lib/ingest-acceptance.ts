/** 入库后审阅：对照原文与实际落盘页面，保存结构和覆盖待审阅项。 */
import yaml from "js-yaml"
import { createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { computeContextBudget } from "@/lib/context-budget"
import { parseWikiSchemaRouting, validateWikiPageRouting } from "@/lib/wiki-schema"
import { sourceSummarySlugFromIdentity } from "@/lib/source-identity"
import type { IngestPrompts } from "@/lib/ingest-prompts"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ReviewItem } from "@/stores/review-store"
import type { FileNode } from "@/types/wiki"
import { acceptanceFailureReviews } from "@/lib/ingest-acceptance-reviews"
import { withLlmStage } from "@/lib/llm-observer"

export interface AcceptanceIssue {
  kind: "structure" | "coverage"
  description: string
  sourceEvidence: string
  pageEvidence: string
  pages: string[]
}

interface AcceptanceRound {
  summaries: string[]
  issues: AcceptanceIssue[]
}

export interface AcceptanceReport {
  sourceIdentity: string
  status: "clear" | "pending-review" | "passed" | "failed"
  rounds: AcceptanceRound[]
  error?: string
  updatedAt: number
}

type AcceptanceReview = Omit<ReviewItem, "id" | "resolved" | "createdAt">

interface AcceptanceOptions {
  projectPath: string
  sourceIdentity: string
  sourcePath: string
  sourceContent: string
  schema: string
  purpose: string
  writtenPaths: string[]
  llmConfig: LlmConfig
  prompts: IngestPrompts
  signal?: AbortSignal
  onProgress?: (detail: string) => void
}

export interface AcceptanceResult {
  report: AcceptanceReport
  reviews: AcceptanceReview[]
}

/** 只处理内容页面；聚合导航由应用维护，不作为原文覆盖证据。 */
function isContentPath(path: string): boolean {
  return path.startsWith("wiki/") && path.endsWith(".md") &&
    !/[\\\x00-\x1f]/.test(path) &&
    path.split("/").every((part) => part !== ".." && part !== "." && part !== "") &&
    !["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(path)
}

/** 每段保留完整原文，避免长文只检查分析摘要；不截断超长单行。 */
function sourceChunks(source: string): string[] {
  const chunks: string[] = []
  let current = ""
  let lines = 0
  for (const line of source.split(/\r?\n/)) {
    if (current && (current.length + line.length > 12_000 || lines >= 100)) {
      chunks.push(current)
      current = ""
      lines = 0
    }
    current += `${line}\n`
    lines++
  }
  if (current.trim()) chunks.push(current)
  return chunks
}

/** 用严格 YAML 检查兜底，不能把读取时的容错解析误当成结构合格。 */
function inspectStructure(path: string, content: string, schema: string): AcceptanceIssue[] {
  const problems: string[] = []
  const block = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  let fields: Record<string, unknown> | null = null
  try {
    const parsed: unknown = block ? yaml.load(block[1], { schema: yaml.JSON_SCHEMA }) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>
  } catch { /* 统一归入结构问题，由同一轮修复处理。 */ }
  if (!fields) problems.push("缺少规范的 YAML frontmatter，或 YAML 无法解析")
  else {
    for (const key of ["type", "title"]) {
      if (typeof fields[key] !== "string" || !fields[key].trim()) problems.push(`缺少有效的 ${key}`)
    }
    if (!Array.isArray(fields.sources) || !fields.sources.length || fields.sources.some((s) => typeof s !== "string" || !s.trim())) {
      problems.push("sources 必须是非空字符串列表")
    }
    if (fields.related !== undefined && (!Array.isArray(fields.related) || fields.related.some((s) => typeof s !== "string" || /\[\[|\]\]/.test(s)))) {
      problems.push("related 必须是页面标识字符串列表，不包含双括号包装或嵌套数组")
    }
    const routing = parseWikiSchemaRouting(schema)
    const issue = validateWikiPageRouting(path, content, routing)
    if (issue) problems.push(issue.message)
    // 来源摘要是可选的应用维护页，不属于项目业务类型表。
    const managedSource = fields.type === "source" && /^wiki\/sources\/[^/]+\.md$/.test(path)
    if (fields.type === "source" && !managedSource) problems.push("来源摘要必须位于 wiki/sources/ 下")
    if (!managedSource && typeof fields.type === "string" && Object.keys(routing.typeDirs).length && !routing.typeDirs[fields.type]) {
      problems.push(`schema 未定义类型 ${fields.type}`)
    }
  }
  if (block && !content.slice(block[0].length).trim()) problems.push("页面正文为空")
  return problems.map((description) => ({ kind: "structure", description, sourceEvidence: "", pageEvidence: path, pages: [path] }))
}

/** 协议错误、空响应和截断均转为待确认，不能解释为没有问题。 */
function parseAcceptance(text: string): { summary: string; issues: AcceptanceIssue[] } {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"))
  if (!value || typeof value.summary !== "string" || !value.summary.trim() || !Array.isArray(value.issues)) {
    throw new Error("审阅响应必须包含非空 summary 和 issues 数组")
  }
  for (const issue of value.issues) {
    if (!issue || !["structure", "coverage"].includes(issue.kind) ||
      typeof issue.description !== "string" || !issue.description.trim() ||
      typeof issue.sourceEvidence !== "string" || typeof issue.pageEvidence !== "string" ||
      !Array.isArray(issue.pages) || issue.pages.some((path: unknown) => typeof path !== "string" || !isContentPath(path)) ||
      (issue.kind === "coverage" && !issue.sourceEvidence.trim())) {
      throw new Error("审阅问题缺少有效分类、描述、依据或页面路径")
    }
  }
  return value
}

/** 为入库审阅单独保留输出空间；容量不足时明确失败，不裁掉来源或页面。 */
async function requestAcceptance(options: AcceptanceOptions, system: string, input: object): Promise<string> {
  const user = JSON.stringify(input)
  const budget = computeContextBudget(options.llmConfig.maxContextSize)
  const maxTokens = Math.min(8_192, Math.max(1_024, Math.floor(budget.responseReserve / 4)))
  const reserve = maxTokens * 4
  if (system.length + user.length + reserve > budget.maxCtx) {
    throw new Error("入库审阅上下文容量不足，请增大模型上下文配置或拆分来源；本次未截断材料")
  }
  let output = ""
  let failure: Error | undefined
  await streamChat(withLlmStage(options.llmConfig, "acceptance"), [
    { role: "system", content: system },
    { role: "user", content: user },
  ], {
    onToken: (token) => { output += token },
    onDone: (completion) => { if (completion?.truncated) failure = new Error("入库审阅响应被截断") },
    onError: (error) => { failure = error },
  }, options.signal, { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: maxTokens })
  if (options.signal?.aborted) throw new Error("入库审阅已取消")
  if (failure) throw failure
  if (!output.trim()) throw new Error("入库审阅返回空响应")
  return output
}

/** 优先提供完整原文；确实放不下时才分段，并明确片段的证据边界。 */
function acceptanceInput(options: AcceptanceOptions, pages: Record<string, string>, knownPagePaths: string[], source: string, startLine: number, complete: boolean): object {
  return {
    task: "结构规范和内容覆盖审阅。仅检查关键信息是否正确保留，不判断来源间观点冲突。仅返回 kind 为 structure 或 coverage 的 summary、issues JSON。",
    sourceIdentity: options.sourceIdentity, sourceStartLine: startLine, source,
    sourceScope: complete ? "complete" : "fragment",
    scopeNote: complete
      ? "已提供完整原文。核对全文后再判断无来源依据；其他来源贡献和入库前已有内容不能仅因当前来源未提及而删除。"
      : "当前只有原文片段，仅核对本段重要内容是否保留；不得将本段未出现的页面内容判为整份来源没有依据，也不得要求删除后文或其他来源的内容。",
    managedPageTypes: { source: "wiki/sources/（可选应用维护页，不属于业务类型表）" },
    schema: options.schema, purpose: options.purpose, pages,
    knownPagePaths,
  }
}

/** 每次审阅读取真实落盘页，不以模型自报的写入结果作为证据。 */
async function inspect(options: AcceptanceOptions, round: AcceptanceRound): Promise<void> {
  const pages: Record<string, string> = {}
  const { issues, summaries } = round
  for (const path of new Set(options.writtenPaths.filter(isContentPath))) {
    pages[path] = await readFile(`${options.projectPath}/${path}`)
    issues.push(...inspectStructure(path, pages[path], options.schema))
  }
  if (!Object.keys(pages).length) {
    throw new Error("没有可审阅的知识页面")
  }
  // 提供项目的真实文件清单，避免把未参与本次写入的已有链接目标误判成断链。
  const knownPagePaths: string[] = []
  const collectPaths = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.is_dir) collectPaths(node.children ?? [])
      else if (node.path.endsWith(".md")) knownPagePaths.push(node.path.slice(options.projectPath.length + 1))
    }
  }
  collectPaths(await listDirectory(`${options.projectPath}/wiki`))
  const fullSource = options.sourceContent.replace(/\r\n/g, "\n") + "\n"
  const budget = computeContextBudget(options.llmConfig.maxContextSize)
  const reserve = Math.min(8_192, Math.max(1_024, Math.floor(budget.responseReserve / 4))) * 4
  const fullInput = acceptanceInput(options, pages, knownPagePaths, fullSource, 1, true)
  const complete = JSON.stringify(fullInput).length + options.prompts.acceptance.length + reserve <= budget.maxCtx
  const chunks = complete && fullSource.trim() ? [fullSource] : sourceChunks(options.sourceContent)
  if (!chunks.length) throw new Error("来源正文为空，无法执行内容覆盖审阅")
  let line = 1
  for (const [index, source] of chunks.entries()) {
    options.onProgress?.(`入库审阅：核对原文 ${index + 1}/${chunks.length}`)
    const result = parseAcceptance(await requestAcceptance(options, options.prompts.acceptance,
      acceptanceInput(options, pages, knownPagePaths, source, line, complete)))
    summaries.push(result.summary)
    issues.push(...result.issues)
    line += source.split("\n").length - 1
  }
}

/** 只收集待审阅项；问题或模型错误不改变已经完成的文件写入。 */
export async function runIngestAcceptance(options: AcceptanceOptions): Promise<AcceptanceResult> {
  const report: AcceptanceReport = {
    sourceIdentity: options.sourceIdentity, status: "pending-review", rounds: [], updatedAt: Date.now(),
  }
  try {
    const round: AcceptanceRound = { summaries: [], issues: [] }
    report.rounds.push(round)
    await inspect(options, round)
    report.status = round.issues.length ? "pending-review" : "clear"
  } catch (error) {
    if (options.signal?.aborted) throw error
    report.error = error instanceof Error ? error.message : String(error)
  }
  const directory = `${options.projectPath}/.llm-wiki/acceptance`
  try {
    await createDirectory(directory)
    await writeFile(`${directory}/${sourceSummarySlugFromIdentity(options.sourceIdentity)}.json`, JSON.stringify(report, null, 2))
  } catch (error) {
    // 报告写入失败也保留已发现的问题，交由 review.json 统一持久化。
    report.status = "pending-review"
    report.error = [report.error, `审阅报告保存失败：${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("；")
  }
  return { report, reviews: acceptanceFailureReviews(options.sourcePath, report) }
}
