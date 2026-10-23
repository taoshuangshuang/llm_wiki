/** 长材料按证据和目标页分批生成，在内存中组装完整稿后才交给写入层。 */
import { parseUnchangedPaths } from "./ingest-result"
import { parseFrontmatter } from "./frontmatter"
import type { IngestCandidateContext } from "./ingest-context"

export interface DraftRequest {
  source: string
  analysis: string
  pages: Map<string, string>
  instruction: string
  /** 片段使用 JSON 正文协议，避免代码围栏跨边界时破坏 FILE 解析。 */
  fragment?: { path: string; part: number; total: number }
  scope?: "knowledge" | "source-summary"
}

export interface DraftResponse {
  text: string
  error?: string | null
  truncated?: boolean
}

export interface DraftBlock { path: string; content: string }

/** 分片不删除字符；优先在换行处切分，超长单行仍明确分片。 */
export function splitEvidence(text: string, limit: number): string[] {
  const size = Math.max(256, limit)
  const parts: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size)
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end)
      if (newline > start + size / 2) end = newline + 1
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts.length ? parts : [""]
}

/** 同一目标的多次贡献先在内存中累积，任何分片失败都不提交半份该页。 */
export async function generateBatchedDrafts(options: {
  source: string
  analysis: string
  context: IngestCandidateContext
  materialBudget: number
  outputBudget: number
  request: (input: DraftRequest) => Promise<DraftResponse>
  understand: (source: string, pages: Map<string, string>) => Promise<{ targets: string[]; createNew: boolean }>
  parse: (output: string) => DraftBlock[]
  /** 来源摘要单独累计，避免与每个知识批次争用完整输出协议。 */
  sourceSummaryPath?: string
  allowNoKnowledge?: boolean
}): Promise<string> {
  const { context, materialBudget, request, parse } = options
  const working = new Map(context.pages)
  const summary = options.sourceSummaryPath ? working.get(options.sourceSummaryPath) : undefined
  if (options.sourceSummaryPath) working.delete(options.sourceSummaryPath)
  const changed = new Map<string, string>()
  const covered = new Set<string>()
  const reviews: string[] = []
  // 分析只是辅助，原文分片始终完整传入；给旧页和输出指令分别预留空间。
  const sourceLimit = Math.max(256, Math.min(Math.floor(materialBudget * 0.28), Math.floor(options.outputBudget * 0.5)))
  const evidenceUnits = context.units.filter((unit) => unit.text.trim())
  const sourceParts = (evidenceUnits.length ? [...new Set(evidenceUnits.map((unit) => unit.text))] : [options.source])
    .flatMap((text) => splitEvidence(text, sourceLimit))
  const analysis = options.analysis.length <= sourceLimit ? options.analysis : "完整来源分析已用于检索；本批次以随附原文及候选正文为准，保留关键事实、条件、代码与表格。"
  for (const [sourceIndex, source] of sourceParts.entries()) {
    const plan = await options.understand(source, working)
    const targets: Array<string | null> = [...new Set(plan.targets)]
    if (plan.createNew) targets.push(null)
    if (!targets.length) throw new Error("长材料变更规划没有目标或明确的新建决定")
    for (const target of targets) {
      if (target && !working.has(target)) throw new Error(`长材料规划使用未读取的目标：${target}`)
      const existing = target ? working.get(target)! : ""
      const parsed = parseFrontmatter(existing)
      const prefix = existing && parsed.frontmatter ? existing.slice(0, existing.length - parsed.body.length) : ""
      const pageLimit = Math.max(512, Math.min(options.outputBudget - 512, materialBudget - source.length - analysis.length - 3_000))
      const fragments = target ? splitEvidence(parsed.body, pageLimit) : [""]
      const bodies: string[] = []
      let updated = false
      for (const [partIndex, body] of fragments.entries()) {
        const partial = fragments.length > 1
        const page = target ? `${prefix}${body}` : ""
        const response = await request({ source, analysis, scope: "knowledge", pages: target ? new Map([[target, page]]) : new Map(),
          ...(partial && target ? { fragment: { path: target, part: partIndex + 1, total: fragments.length } } : {}), instruction: [
          `本次处理完整来源的第 ${sourceIndex + 1}/${sourceParts.length} 段，其他原文段落由其他批次覆盖，不得据本段缺失而删除其他知识。`,
          target ? `更新目标固定为 ${target}；已读取其${partial ? `第 ${partIndex + 1}/${fragments.length} 个正文片段` : "完整正文"}。`
            : "理解候选后未确定同主题更新目标；按项目类型规则整理本段独立知识，可以新建页面。",
          partial ? "这是正文片段写作任务。JSON body 只能返回随附片段的完整替换文本，其他片段由程序原样保留。不要重复页面总标题或其他章节；新增章节集中放入最后片段。"
            : "输出完整最终页面，保留既有有效事实。",
          target ? partial ? "遵守正文分片 JSON 协议，不得更换目标。" : "只能返回该精确目标的 FILE、UNCHANGED 和可选 REVIEW，不得擅自更换更新目标。" : "新建路径要使用实际主题名称；无关联知识不能只返回空响应。",
        ].join("\n") })
        if (response.error || response.truncated) throw new Error(response.error || "分批生成响应截断，保留旧页")
        if (partial && target && /^\s*(?:```json\s*)?\{/.test(response.text)) {
          const fragment: unknown = JSON.parse(response.text.trim().replace(/^```json\s*|\s*```$/g, ""))
          if (!fragment || typeof fragment !== "object") throw new Error("正文分片 JSON 协议无效")
          const data = fragment as { body?: unknown; unchanged?: unknown; reviewBlocks?: unknown }
          if (data.unchanged !== true && typeof data.body !== "string") throw new Error("正文分片必须返回完整 body 或明确 unchanged")
          if (data.reviewBlocks !== undefined && typeof data.reviewBlocks !== "string") throw new Error("正文分片审阅协议无效")
          bodies.push(data.unchanged === true ? body : data.body as string)
          updated ||= data.unchanged !== true
          covered.add(target)
          if (data.reviewBlocks) reviews.push(data.reviewBlocks as string)
          continue
        }
        const blocks = parse(response.text)
        reviews.push(...[...response.text.matchAll(/---REVIEW:[\s\S]*?---END REVIEW---/g)].map((match) => match[0]))
        if (target) {
          if (blocks.some((block) => block.path !== target) || blocks.length > 1) throw new Error(`分批更新返回了计划外路径：${target}`)
          const unchanged = parseUnchangedPaths(response.text).includes(target)
          if (blocks.length && unchanged) throw new Error(`分批更新同时返回 FILE 与 UNCHANGED：${target}`)
          if (!blocks.length && !unchanged) throw new Error(`分批更新未返回完整结果：${target}`)
          if (blocks.length) {
            updated = true
            bodies.push(partial ? parseFrontmatter(blocks[0].content).body : blocks[0].content)
          } else bodies.push(partial ? body : existing)
          covered.add(target)
        } else {
          const unchanged = parseUnchangedPaths(response.text)
          if (unchanged.some((path) => !working.has(path) || blocks.some((block) => block.path === path))) throw new Error("分批无变更依据无效或与 FILE 冲突")
          for (const path of unchanged) covered.add(path)
          if (!blocks.length && !unchanged.length && !(options.allowNoKnowledge && response.text.trim() === "---NO KNOWLEDGE---")) {
            throw new Error("新知识分批生成没有完整页面或明确覆盖依据")
          }
          for (const block of blocks) {
            if (working.has(block.path)) throw new Error(`新建页命中尚未读取的目标：${block.path}，需重新检索`)
            changed.set(block.path, block.content)
            working.set(block.path, block.content)
          }
        }
      }
      if (target && updated) {
        // FILE 解析会清理协议边界空白，恢复原始分片的尾部分隔，不能拼坏代码和表格。
        const joined = bodies.map((body, index) => {
          const separator = fragments[index].match(/\s+$/)?.[0] ?? ""
          return index < bodies.length - 1 && separator ? body.replace(/\s*$/, "") + separator : body
        }).join("")
        const content = fragments.length > 1 ? prefix + joined : bodies[0]
        working.set(target, content)
        changed.set(target, content)
      }
    }
  }
  const summaryDraft = options.sourceSummaryPath ? await generateBatchedDrafts({
    ...options, sourceSummaryPath: undefined, allowNoKnowledge: false,
    context: { ...context, pages: summary === undefined ? new Map() : new Map([[options.sourceSummaryPath, summary]]) },
    understand: async (_source, pages) => ({ targets: pages.has(options.sourceSummaryPath!) ? [options.sourceSummaryPath!] : [], createNew: !pages.has(options.sourceSummaryPath!) }),
    request: (input) => request({ ...input, scope: "source-summary", instruction: `${input.instruction}\n只处理来源摘要 ${options.sourceSummaryPath}，累计保留其他分段事实，不返回任何其他页面。` }),
    parse: (output) => {
      const blocks = parse(output)
      if (blocks.some((block) => block.path !== options.sourceSummaryPath)) throw new Error("来源摘要批次返回计划外知识页")
      return blocks
    },
  }) : ""
  return [
    ...[...changed].map(([path, content]) => `---FILE: ${path}---\n${content}\n---END FILE---`),
    ...[...covered].filter((path) => !changed.has(path)).map((path) => `---UNCHANGED: ${path}---`),
    ...reviews, summaryDraft,
  ].filter(Boolean).join("\n\n")
}
