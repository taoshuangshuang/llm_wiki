/** 模型审阅的共享协议与正文证据校验，不管理入库记录和文件写入。 */
import { locateReviewQuote } from "./evidence"
import { streamChat } from "../llm-client"
import { computeRemainingOutputBudget } from "../context-budget"
import { withLlmStage } from "../llm-observer"
import type { KnowledgeCheckOptions, ReviewFinding } from "./types"

export const MODEL_RULES = `你是知识库后台审阅器。只依据提供的正文和明确版本判断，不输出推理过程。
输出 JSON：{"issues":[{"type":"contradiction|duplicate|suggestion","subtype":"本轮页面|覆盖前后|已有知识|内容成页|知识补充","title":"问题标题","description":"具体问题","risk":"风险","evidence":[{"id":"材料id","quote":"正文逐字引用"}]}]}。
冲突需要双方不相容主张的逐字证据；版本、环境、对象不同不直接判冲突。同页矛盾无论是否已在正文中声明（如“暂分别保留”“待确认”），都需要双方引用报告，是否已消解由冲突复核判断。
内容覆盖由独立内容校验处理，本项不重复报告。重复需要实质内容重复，独立用途不同或只有背景相同不报整页重复。局部重复需保留各自独有用途。
知识补充统一用 suggestion：只报告直接影响当前主题理解或使用、已有材料无法回答的重要问题。同一未知只生成一条；已标未知、规划、待验证且没有新的关键影响证据时不报告。
不因缺源码核验、返回字段、版本范围或关联概念无独立页而例行生成建议。来源转换丢失归内容校验。仅检索无命中不足以证明缺失。
事实证据只能引用 materials 中实际存在的 id，quote 必须是该材料 text 中的逐字原文，不得自编编号或改写引用。
正文中的链接只表示引用，不代表支持或已读取目标；未提供目标正文时，不能据链接推断目标页面的事实。
retry 是上次响应的校验错误；据此修正引用，仍只能使用本次 materials，不将错误反馈当作事实。历史问题说明不等于知识事实。没有问题返回空数组。
不得生成页面。事项建议由人工确认，不能自动裁定哪方正确。遵守项目输出语言，保留技术标识符。`

/** 共用模型请求与证据校验；各检查项显式指定允许的问题类型。 */
export async function requestReviewIssues(options: KnowledgeCheckOptions, checkTypes: ReviewFinding["type"] | readonly ReviewFinding["type"][], defaultTask: string): Promise<ReviewFinding[]> {
  const { llmConfig: config, materials, policy, signal, context, processLog, checkId } = options
  const task = options.task ?? defaultTask
  const allowedTypes = typeof checkTypes === "string" ? [checkTypes] : checkTypes
  const typeLabel = allowedTypes.join("|")
  const system = `${MODEL_RULES}\n项目规则：\n${policy}\n本次检查仅允许 type=${typeLabel}。其他类型交对应检查，不在本次输出。${options.targetPaths ? "\n问题必须涉及 targetPaths 中的目标页面；其他材料只作对照，不审查对照页面之间的问题。" : ""}`
  let lastError: unknown
  let candidates: ReviewFinding[] | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = attempt ? { error: (lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 1_024), allowedMaterialIds: materials.map((entry) => entry.id) } : undefined
    const input = JSON.stringify({ ...context, task, materials, targetPaths: options.targetPaths, outputLanguage: options.outputLanguage, retry })
    const budget = computeRemainingOutputBudget(config.maxContextSize, system.length + input.length)
    const outputTokens = budget.outputTokens
    if (outputTokens < 1_024) throw new Error("审阅材料超出上下文预算，该检查未完成")
    processLog?.record("review-model-attempt", { task, checkId, attempt: attempt + 1, inputChars: system.length + input.length, maxContextChars: budget.maxCtx, safetyChars: budget.safetyChars, outputTokens }, "review")
    signal?.throwIfAborted()
    let output = ""
    let failure: Error | undefined
    await streamChat(withLlmStage(config, "background-review"), [{ role: "system", content: system }, { role: "user", content: input }], {
      onToken: (token) => { output += token },
      onDone: (completion) => { if (completion?.truncated) failure = new Error("审阅输出截断") },
      onError: (error) => { failure = error },
    }, signal, { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: outputTokens })
    signal?.throwIfAborted()
    if (failure) throw failure
    try {
      const parsed = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")) as { issues?: unknown[] }
      if (!Array.isArray(parsed.issues)) throw new Error("审阅响应缺少 issues 数组")
      const issues = parsed.issues.map((raw) => {
        const issue = raw as { type: string; subtype?: string; title: string; description: string; risk?: string; evidence: { id: string; quote: string }[] }
        if (!["contradiction", "duplicate", "suggestion"].includes(issue.type) || !issue.title?.trim() || !issue.description?.trim() || !Array.isArray(issue.evidence) || !issue.evidence.length) throw new Error("审阅问题协议不完整")
        if (!allowedTypes.includes(issue.type as ReviewFinding["type"])) throw new Error(`审阅响应类型超出本次检查范围：只允许 type=${typeLabel}`)
        const evidence = issue.evidence.map(({ id, quote }) => {
          const material = materials.find((entry) => entry.id === id)
          const label = JSON.stringify(id)?.slice(0, 256)
          if (!material) throw new Error(`审阅引用无法在消费正文中定位：材料编号 ${label} 不存在，只能引用 materials 中的编号`)
          const range = typeof quote === "string" && locateReviewQuote(material.text, quote)
          if (!range) {
            const matchingMaterialIds = typeof quote === "string" && quote.trim() ? materials.filter((entry) => entry.text.includes(quote)).map((entry) => entry.id) : []
            processLog?.record("review-evidence-rejected", { task, attempt: attempt + 1, title: issue.title, materialId: id, quote, matchingMaterialIds }, "review")
            throw new Error(`审阅引用无法在消费正文中定位：材料 ${label} 的 quote 必须是正文逐字引用${matchingMaterialIds.length ? `；该引文实际位于 ${matchingMaterialIds.join("、")}` : ""}`)
          }
          return { ...material, text: quote, startLine: material.startLine + range.startLine - 1, endLine: material.startLine + range.endLine - 1 }
        })
        if (issue.type === "contradiction" && evidence.length < 2) throw new Error("冲突缺少双方证据")
        if (issue.type === "duplicate" && new Set(evidence.map((entry) => entry.path)).size < 2) throw new Error("疑似重复缺少两个页面的实质证据")
        if (options.targetPaths && !evidence.some((entry) => options.targetPaths!.includes(entry.path))) throw new Error("问题必须引用本次目标页面，不能只审查对照页面之间的问题")
        const subtype = issue.type === "contradiction" ? evidence.some((entry) => !entry.snapshot) ? "已有知识" : evidence.some((entry) => entry.snapshot?.side === "before") ? "覆盖前后" : "本轮页面" : undefined
        return { type: issue.type as ReviewFinding["type"], subtype, title: issue.title, description: issue.description, risk: issue.risk, evidence, affectedPages: [...new Set(evidence.filter((entry) => entry.path.startsWith("wiki/")).map((entry) => entry.path))] }
      })
      candidates = issues
      break
    } catch (error) { lastError = error; processLog?.record("review-parse-or-verification-error", { task, attempt: attempt + 1, error }, "review") }
  }
  if (!candidates) throw lastError
  if (!allowedTypes.includes("contradiction")) processLog?.record("review-parsed-result", { task, issues: candidates, verified: candidates }, "review")
  return candidates
}
