/** 已有知识检查：同一批正文一次初筛冲突与重复，再独立复核冲突适用范围。 */
import type { ReviewEvidence } from "@/stores/review-store"
import { requestReviewIssues } from "./model"
import { verifyConflictScope } from "./conflict-scope"
import { insideMarkedSections, pendingMarkerFindings } from "./pending-marker"
import { failureResult, materialScope, type KnowledgeCheckOptions, type ReviewCheckResult, type ReviewFinding } from "./types"
import type { CodeConflictAnalysis } from "../code-conflict-types"

export interface ExistingKnowledgeCheckOptions extends KnowledgeCheckOptions {
  onScopeCheck?: (verdict: Record<string, boolean>, evidence: ReviewEvidence[]) => Promise<void>
  analyzeCode?: (finding: ReviewFinding, materials: KnowledgeCheckOptions["materials"]) => Promise<CodeConflictAnalysis | undefined>
}

const TASK = "一次检查提供正文的事实冲突和整页或局部实质重复，覆盖单页内部、同批页面之间及当前页面与相关知识之间。保留双方证据、独立用途与独有事实；有事实分歧时只报冲突，不通过合并裁定事实"

/** 复用一次初筛结果；涉及确认冲突的页面不作为自动整理候选。 */
export async function checkKnowledge(options: ExistingKnowledgeCheckOptions): Promise<ReviewCheckResult<ReviewFinding>> {
  const issues: ReviewFinding[] = []
  const checkedScope: ReviewCheckResult<ReviewFinding>["checkedScope"] = []
  // 标识段落由程序直接转人工，模型检查失败也不会遗漏。
  const marked = pendingMarkerFindings(options.materials, options.targetPaths)
  const pending: ReviewFinding[] = [...marked]
  try {
    options.signal?.throwIfAborted()
    if (!options.materials.length) throw new Error("没有可检查的正文材料")
    const candidates = await requestReviewIssues(options, ["contradiction", "duplicate"], TASK)
    checkedScope.push(...options.materials.map(materialScope))
    // 先复核冲突，再处理重复；模型返回顺序不影响事实分歧的优先级。
    for (const issue of candidates.filter((entry) => entry.type === "contradiction" && !insideMarkedSections(entry, marked))) {
      let verdict: Record<string, boolean>
      try { verdict = await verifyConflictScope(options.llmConfig, issue, options.materials, options.signal, options.processLog) }
      catch (error) {
        // 材料不足是人工确认结果，不是执行故障；继续检查其他候选。
        options.signal?.throwIfAborted()
        if (error instanceof Error && error.message.startsWith("冲突的对象、版本或适用条件无法核实")) {
          pending.push({ ...issue, description: `${issue.description}\n${error.message}` })
          continue
        }
        throw error
      }
      const confirmed = verdict.sameSubject && verdict.sameVersion && verdict.sameConditions && verdict.incompatible
      const accepted = confirmed && !verdict.explainedDifference
      options.processLog?.record("review-conflict-decision", { issue, verdict, accepted }, "review")
      await options.onScopeCheck?.(verdict, issue.evidence)
      // 原文声明了差异但未消解：冲突仍然成立，转待确认而不是静默丢弃。
      if (accepted && verdict.declaredDifference) {
        pending.push({ ...issue, description: `${issue.description}\n原文已声明该差异但未消解（如“暂分别保留”“待确认”），需人工裁决后统一。` })
      } else if (accepted) issues.push(issue)
    }
    // 待确认的事实分歧同样禁止自动合并，避免借去重裁定尚未核实的事实。
    const conflicted = new Set([...issues, ...pending].flatMap((issue) => issue.affectedPages))
    issues.push(...candidates.filter((issue) => issue.type === "duplicate" && !issue.affectedPages.some((path) => conflicted.has(path))))
    if (options.analyzeCode) for (const finding of [...issues.filter((issue) => issue.type === "contradiction"), ...pending]) {
      options.signal?.throwIfAborted()
      finding.codeAnalysis = await options.analyzeCode(finding, options.materials)
    }
    options.processLog?.record("review-parsed-result", { task: options.task ?? TASK, issues: candidates, verified: issues }, "review")
    return { status: "complete", issues, checkedScope, ...(pending.length ? { pending } : {}) }
  } catch (error) { return { ...failureResult(error, issues, checkedScope, options.signal), ...(pending.length ? { pending } : {}) } }
}
