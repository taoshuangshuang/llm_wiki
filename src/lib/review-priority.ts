import type { ReviewItem } from "@/stores/review-store"
import type { IngestRun } from "./ingest-run"

export type ReviewImportance = "important" | "optional"

/** 研究和知识完善按需处理；质量问题必须提示审阅，未知类型也不静默降级。 */
export function reviewImportance(item: Pick<ReviewItem, "type">): ReviewImportance {
  return item.type === "suggestion" || item.type === "missing-page" ? "optional" : "important"
}

/** 所有角标、导入统计共用同一口径，排除已处理、隐藏和历史证据。 */
export function needsReviewAttention(item: ReviewItem): boolean {
  return reviewImportance(item) === "important" && !item.resolved && !item.historical && !item.hidden
}

/** 重要检查已完成时，非重要检查失败只保留提示，不把导入归为需审阅。 */
export function hasOnlyOptionalReviewFailures(run: IngestRun): boolean {
  const review = run.review
  if (!review || review.historical || review.revision !== run.revision) return false
  const batches = review.batches?.length ? review.batches : [{ retrieval: review.retrieval, checks: review.knowledgeChecks ?? {} }]
  if (batches.some((batch) => batch.retrieval?.status !== "completed")) return false
  const importantCompleted = batches.every((batch) => {
    const completed = (id: string) => {
      const checks = Object.entries(batch.checks).filter(([key]) => key === id || key.startsWith(`${id}:segment-`))
      return checks.length > 0 && checks.every(([, check]) => check.status === "complete")
    }
    // 有合并检查记录时以新结果为准；旧报告仍兼容原有两项结果。
    const combined = Object.keys(batch.checks).some((id) => id === "existing-knowledge" || id.startsWith("existing-knowledge:segment-"))
    return combined ? completed("existing-knowledge") : completed("existing-conflict") && completed("duplicate")
  })
  const optionalFailed = batches.some((batch) => Object.entries(batch.checks).some(([id, check]) => /^(missing-page|suggestion)(:|$)/.test(id) && check.status === "incomplete"))
  const incomplete = Object.entries(review.steps).filter(([, step]) => step.status === "incomplete")
  return incomplete.length === 1 && ["knowledge", "supplement"].includes(incomplete[0][0]) &&
    ["format", "content"].every((id) => ["complete", "not-applicable"].includes(review.steps[id]?.status)) &&
    (!run.reviewError || run.reviewError === incomplete[0][1].reason) &&
    importantCompleted && optionalFailed
}
