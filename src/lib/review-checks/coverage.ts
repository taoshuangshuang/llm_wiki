/** 内容覆盖检查：对照来源、旧页及写入后正文；仅适用于入库。 */
import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat } from "../llm-client"
import { computeRemainingOutputBudget } from "../context-budget"
import { withLlmStage } from "../llm-observer"
import { contentRevision } from "../content-revision"
import { failureResult, isReviewContentPath, type PageCheckIssue, type ReviewCheckResult, type ReviewCheckScope } from "./types"

export interface CoverageCheckOptions {
  sourceIdentity: string
  sourcePath: string
  sourceContent: string
  pages: Record<string, string>
  beforePages?: Record<string, string>
  knownPagePaths: string[]
  schema: string
  purpose: string
  prompt: string
  llmConfig: LlmConfig
  /** 只对候选遗漏补读明确关联页；由调用方限定读取范围。 */
  readPage: (path: string) => Promise<string>
  signal?: AbortSignal
  onProgress?: (detail: string) => void
  coverageChecks?: Record<string, CoverageSegment>
  onCoverageSegment?: (id: string, result: CoverageSegment) => Promise<void>
  onCoverageStart?: () => void
}

interface CoverageSegment { summary: string; issues: PageCheckIssue[] }
export interface CoverageCheckResult extends ReviewCheckResult<PageCheckIssue> { summaries: string[] }

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

/** 协议错误、空响应和截断均转为待确认，不能解释为没有问题。 */
function parseAcceptance(text: string): { summary: string; issues: PageCheckIssue[] } {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"))
  if (!value || typeof value.summary !== "string" || !value.summary.trim() || !Array.isArray(value.issues)) {
    throw new Error("审阅响应必须包含非空 summary 和 issues 数组")
  }
  for (const issue of value.issues) {
    if (!issue || !["structure", "coverage"].includes(issue.kind) ||
      typeof issue.description !== "string" || !issue.description.trim() ||
      typeof issue.sourceEvidence !== "string" || typeof issue.pageEvidence !== "string" ||
      !Array.isArray(issue.pages) || issue.pages.some((path: unknown) => typeof path !== "string" || !isReviewContentPath(path)) ||
      (issue.kind === "coverage" && !issue.sourceEvidence.trim())) {
      throw new Error("审阅问题缺少有效分类、描述、依据或页面路径")
    }
  }
  return value
}

const ACCEPTANCE_PROTOCOL = "\n输入输出协议约束：coverage 的 sourceEvidence 必须是 source 或 beforePages 中连续、逐字、可直接搜索的原文片段，不能附加行号、来源位置、说明、引号或转述。pageEvidence 若非空也应直接引用页面原文；完全遗漏时可为空。位置由程序计算。"

/** 为入库审阅按完整输入后的剩余空间分配输出；容量不足时明确失败，不裁掉来源或页面。 */
async function requestAcceptance(options: CoverageCheckOptions, system: string, input: object): Promise<string> {
  system += ACCEPTANCE_PROTOCOL
  const user = JSON.stringify(input)
  const { outputTokens } = computeRemainingOutputBudget(options.llmConfig.maxContextSize, system.length + user.length)
  if (outputTokens < 1_024) {
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
  }, options.signal, { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: outputTokens })
  if (options.signal?.aborted) throw new Error("入库审阅已取消")
  if (failure) throw failure
  if (!output.trim()) throw new Error("入库审阅返回空响应")
  return output
}

/** 协议校验失败时携带错误重试一次；完整材料重新核对，不补写缺失字段或吞掉问题。 */
async function requestParsedAcceptance(options: CoverageCheckOptions, system: string, input: object): Promise<CoverageSegment> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const correction = attempt
      ? `\n上次响应未通过协议校验：${JSON.stringify((lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 1_024))}。这只是格式错误反馈，不是事实依据。请重新核对本次完整材料，仅返回一个合法 JSON 对象，必须包含非空字符串 summary 和 issues 数组；无问题时显式返回 issues: []，不要提前闭合对象或输出额外文本。`
      : ""
    // 网络、取消及截断错误不属于 JSON 协议纠正，交由上层明确报告。
    const output = await requestAcceptance(options, system + correction, input)
    try {
      return parseAcceptance(output)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** 优先提供完整原文；确实放不下时才分段，并明确片段的证据边界。 */
function acceptanceInput(options: CoverageCheckOptions, pages: Record<string, string>, knownPagePaths: string[], source: string, startLine: number, complete: boolean): object {
  return {
    sourceIdentity: options.sourceIdentity, sourceStartLine: startLine, source,
    sourceScope: complete ? "complete" : "fragment",
    managedPageTypes: { source: "wiki/sources/" },
    schema: options.schema, purpose: options.purpose, pages,
    knownPagePaths, beforePages: options.beforePages,
  }
}

/** 完整页面共同承载来源事实；来源过长时逐段检查，保留成功范围与失败原因。 */
async function inspectCoverage(options: CoverageCheckOptions, round: { summaries: string[]; issues: PageCheckIssue[] }, checkedScope: ReviewCheckScope[]): Promise<void> {
  options.signal?.throwIfAborted()
  const { pages, knownPagePaths } = options
  const { issues, summaries } = round
  if (!Object.keys(pages).length) throw new Error("没有可审阅的知识页面")
  const relatedScope = new Map<string, ReviewCheckScope>()
  const sourceRevision = await contentRevision(options.sourceContent)
  async function recordScope(source: string, startLine: number): Promise<void> {
    checkedScope.push({ id: "source", role: "source", path: options.sourcePath, revision: sourceRevision, startLine, endLine: startLine + source.split("\n").length - 2 })
    for (const [path, text] of Object.entries(pages)) {
      if (!checkedScope.some((scope) => scope.path === path && scope.role === "page")) checkedScope.push({ id: path, role: "page", path, revision: await contentRevision(text), startLine: 1, endLine: text.split("\n").length })
    }
    for (const [path, text] of Object.entries(options.beforePages ?? {})) {
      if (!checkedScope.some((scope) => scope.path === path && scope.role === "before")) checkedScope.push({ id: `before:${path}`, role: "before", path, revision: await contentRevision(text), startLine: 1, endLine: text.split("\n").length })
    }
    for (const [path, scope] of relatedScope) if (!checkedScope.some((entry) => entry.path === path)) checkedScope.push(scope)
  }
  const fullSource = options.sourceContent.replace(/\r\n/g, "\n") + "\n"
  const fullInput = acceptanceInput(options, pages, knownPagePaths, fullSource, 1, true)
  const fullInputChars = JSON.stringify(fullInput).length + options.prompt.length + ACCEPTANCE_PROTOCOL.length
  const complete = computeRemainingOutputBudget(options.llmConfig.maxContextSize, fullInputChars).outputTokens >= 1_024
  const chunks = complete && fullSource.trim() ? [fullSource] : sourceChunks(options.sourceContent)
  if (!chunks.length) throw new Error("来源正文为空，无法执行内容覆盖审阅")
  let line = 1
  const failures: string[] = []
  for (const [index, source] of chunks.entries()) {
    options.onProgress?.(`入库审阅：核对原文 ${index + 1}/${chunks.length}`)
    const input = acceptanceInput(options, pages, knownPagePaths, source, line, complete)
    const checkId = await contentRevision(JSON.stringify(input))
    const previous = options.coverageChecks?.[checkId]
    if (previous) {
      summaries.push(previous.summary)
      issues.push(...previous.issues.filter((issue) => issue.kind === "coverage"))
      await recordScope(source, line)
      line += source.split("\n").length - 1
      continue
    }
    options.onCoverageStart?.()
    try {
      let result = await requestParsedAcceptance(options, options.prompt, input)
      // 初筛兼容旧提示词的结构事项；定向复核仍须严格校验类型，不掩盖错误响应。
      result.issues = result.issues.filter((issue) => issue.kind === "coverage")
      if (result.issues.some((issue) => issue.kind === "coverage" && ![source, ...Object.values(options.beforePages ?? {})].some((text) => text.includes(issue.sourceEvidence)))) {
        result = await requestParsedAcceptance(options, `${options.prompt}\n上次来源引用无法逐字定位。请仅复制 source 或 beforePages 原文中的连续片段作为 sourceEvidence，重新输出有效 JSON。`, input)
        result.issues = result.issues.filter((issue) => issue.kind === "coverage")
        if (result.issues.some((issue) => issue.kind === "coverage" && ![source, ...Object.values(options.beforePages ?? {})].some((text) => text.includes(issue.sourceEvidence)))) throw new Error("内容校验来源引用在针对性重试后仍无法定位")
      }
      if (result.issues.some((issue) => issue.kind === "coverage")) {
        // 完整本次结果已在 pages 中；仅对候选遗漏定向补读明确关联页，不遍历全库正文。
        const linked = new Set(Object.values(pages).flatMap((text) => [...text.matchAll(/(?<!!)\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map((match) => match[1].replace(/\.md$/, ""))))
        const relatedPaths = knownPagePaths.filter((path) => !pages[path] && (linked.has(path.split("/").pop()!.replace(/\.md$/, "")) || result.issues.some((issue) => issue.pages.includes(path))))
        const checkedVersions = new Map<string, string>()
        const candidates = new Set(result.issues.map((issue) => issue.sourceEvidence))
        // 每次只读最多十页；链接多时继续核对剩余候选，不能在读取正文前按总数拒绝整项检查。
        const groups = relatedPaths.length ? Array.from({ length: Math.ceil(relatedPaths.length / 10) }, (_, index) => relatedPaths.slice(index * 10, index * 10 + 10)) : [[]]
        for (const group of groups) {
          if (!result.issues.length) break
          const relatedPages: Record<string, string> = {}
          for (const path of group) {
            relatedPages[path] = await options.readPage(path)
            const revision = await contentRevision(relatedPages[path])
            checkedVersions.set(path, revision)
            relatedScope.set(path, { id: path, role: "related", path, revision, startLine: 1, endLine: relatedPages[path].split("\n").length })
          }
          result = await requestParsedAcceptance(options, `${options.prompt}\n这是遗漏发布前的定向复查。只复核 candidateIssues，核对全部 pages 与当前组 relatedPages；若已有承载、非关键省略或证据不足则移除，不发现新问题；sourceEvidence 必须原样保留对应 candidateIssues 的引文。只允许 coverage。`, { ...input, relatedPages, candidateIssues: result.issues })
          if (result.issues.some((issue) => issue.kind !== "coverage" || !candidates.has(issue.sourceEvidence) || ![source, ...Object.values(options.beforePages ?? {})].some((text) => text.includes(issue.sourceEvidence)))) throw new Error("遗漏定向复查返回无效来源证据、类型或范围")
        }
        for (const [path, revision] of checkedVersions) if (await contentRevision(await options.readPage(path)) !== revision) throw new Error(`遗漏核实期间相关页已变化：${path}`)
      }
      summaries.push(result.summary)
      issues.push(...result.issues)
      await recordScope(source, line)
      await options.onCoverageSegment?.(checkId, result)
    } catch (error) {
      options.signal?.throwIfAborted()
      failures.push(`原文范围 ${line}～${line + source.split("\n").length - 2} 行：${String(error)}`)
    }
    line += source.split("\n").length - 1
  }
  if (failures.length) throw new Error(failures.join("；"))
}

/** 不写入页面、报告或入库状态；错误与空问题列表分别表达。 */
export async function checkCoverage(options: CoverageCheckOptions): Promise<CoverageCheckResult> {
  const round = { summaries: [] as string[], issues: [] as PageCheckIssue[] }
  const checkedScope: ReviewCheckScope[] = []
  try {
    await inspectCoverage(options, round, checkedScope)
    return { status: "complete", ...round, checkedScope }
  } catch (error) {
    return { ...failureResult(error, round.issues, checkedScope, options.signal), summaries: round.summaries }
  }
}
