/**
 * 同路径、同名与语义候选共用的主题核对；只选择目标，不写页或决定正文更新方式。
 * 对语义候选逐一判定；相关主题保持独立，多个同主题目标由模型选择最匹配的承载页。
 * 跨目录同名时核对完整正文；同名、同标题或同来源都不能单独证明主题相同。
 */
import { streamChat } from "@/lib/llm-client"
import { computeContextBudget } from "@/lib/context-budget"
import { withLlmStage } from "@/lib/llm-observer"
import type { LlmConfig } from "@/stores/wiki-store"

export interface IngestPageCandidate { path: string; content: string }

/** 主题或协议质量问题可另存；网络、鉴权和取消错误不得伪装为主题不确定。 */
export class PageTargetUncertainError extends Error {
  constructor(message: string, readonly details?: string) { super(message) }
}

/** 校验信息与原始响应一起留存；模型理由只是目标选择依据，不代表已证实内容冲突。 */
function comparisonDetails(candidates: IngestPageCandidate[], output: string, issues: string[]): string {
  return [
    `待核对候选：${candidates.map(({ path }) => path).join("、")}`,
    ...issues,
    `原始响应：\n${output || "（空响应）"}`,
  ].join("\n")
}

/** 完整核对所有候选；优先复用主题和用途最匹配的候选；无法合理确定则交由调用方正常新建。 */
export async function selectIngestPageTarget(
  config: LlmConfig, incoming: string, candidates: IngestPageCandidate[],
  system: string, signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  if (!candidates.length) return undefined
  if (candidates.length === 1 && candidates[0].content === incoming) return candidates[0].path
  const input = JSON.stringify({ incoming, candidates })
  // 候选条数决定输出预算；正文容量不足时拒绝核对，不能裁掉证据后继续合并。
  const maxTokens = Math.max(1_024, Math.ceil(JSON.stringify(candidates.map(({ path }) => ({ path, verdict: "uncertain" }))).length / 2 + candidates.length * 256))
  const requiredContext = system.length + input.length + maxTokens * 4
  const { maxCtx } = computeContextBudget(config.maxContextSize)
  if (requiredContext > maxCtx) {
    throw new PageTargetUncertainError("页面主题核对上下文容量不足，未截断正文或执行合并", comparisonDetails(candidates, "", [`所需容量：${requiredContext} 字符；可用容量：${maxCtx} 字符。未发起模型核对。`]))
  }
  let output = ""
  let failure: Error | undefined
  await streamChat(withLlmStage(config, "page-reuse"), [
    { role: "system", content: system }, { role: "user", content: input },
  ], {
    onToken: (token) => { output += token },
    onDone: (completion) => { if (completion?.truncated) failure = new PageTargetUncertainError("页面主题核对响应被截断") },
    onError: (error) => { failure = error },
  }, signal, { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: maxTokens })
  signal?.throwIfAborted()
  if (failure) {
    if (failure instanceof PageTargetUncertainError) throw new PageTargetUncertainError(failure.message,
      comparisonDetails(candidates, output, ["响应被截断，无法据此确认合并目标。"]))
    throw failure
  }
  let result
  try { result = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")) }
  catch (error) {
    throw new PageTargetUncertainError("页面主题核对未返回有效 JSON", comparisonDetails(candidates, output,
      [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`]))
  }
  const decisions = result?.decisions as { path: string; verdict: string; reason?: string }[] | undefined
  const paths = new Set(candidates.map((page) => page.path))
  const issues: string[] = []
  if (!Array.isArray(decisions)) issues.push("缺少 decisions 数组。")
  else {
    const returned = new Set<string>()
    for (const decision of decisions) {
      if (!decision || typeof decision.path !== "string") { issues.push("候选判断缺少有效 path。"); continue }
      if (!paths.has(decision.path)) issues.push(`未知候选：${decision.path}`)
      if (returned.has(decision.path)) issues.push(`重复候选：${decision.path}`)
      returned.add(decision.path)
      if (!["same", "different", "uncertain"].includes(decision.verdict)) issues.push(`无效判断：${decision.path} = ${String(decision.verdict)}`)
    }
    for (const path of paths) if (!returned.has(path)) issues.push(`遗漏候选：${path}`)
  }
  if (issues.length || !Array.isArray(decisions)) {
    throw new PageTargetUncertainError("页面主题核对未完整返回有效候选判断", comparisonDetails(candidates, output, issues))
  }
  const same = decisions.filter((decision) => decision.verdict === "same")
  const selected = result.selectedPath
  if (selected !== undefined && selected !== null && (!paths.has(selected) || !same.some((entry) => entry.path === selected))) {
    throw new PageTargetUncertainError("选中的合并目标未通过同主题判断", comparisonDetails(candidates, output, ["selectedPath 必须指向 same 候选"]))
  }
  if (typeof selected === "string") return selected
  if (selected === null) throw new PageTargetUncertainError("读取完整候选后主动选择独立建页", comparisonDetails(candidates, output, [typeof result.reason === "string" ? result.reason : "无法合理确定承载页"]))
  if (same.length === 1) return same[0].path
  // 旧模板未提供多候选优选协议时不猜测；按正常不合并处理并由调用方记录原因。
  if (same.length > 1 || decisions.some((entry) => entry.verdict === "uncertain")) throw new PageTargetUncertainError(
    "读取完整候选后仍无法合理确定承载页，选择独立建页", comparisonDetails(candidates, output, decisions.map((entry) => `${entry.path}：${entry.verdict}；${entry.reason ?? "未提供依据"}`)),
  )
  return undefined
}
