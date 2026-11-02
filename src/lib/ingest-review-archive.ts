/** 人工结束剩余审阅：保留真实检查结果，只归档记录并忽略本次独有的待办。 */
import { updateIngestRun, type IngestRun } from "./ingest-run"
import { loadReviewItems, saveReviewItems } from "./persist"
import { withProjectLock } from "./project-mutex"
import { normalizeReviewItems, useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

/** 完整写入且审阅已停止后才允许人工归档，不能掩盖写入故障或中断正在执行的任务。 */
export function canIgnoreAndArchiveIngestReview(run: IngestRun): boolean {
  return !run.archived && run.writeStatus === "complete" && !run.pending &&
    !run.writeError && !run.error &&
    ["complete", "partial", "incomplete", "cancelled", "superseded"].includes(run.reviewStatus)
}

/** 与审阅发布串行；先持久化忽略决定，再归档，保存失败时保留可见记录供重试。 */
export async function ignoreAndArchiveIngestReview(projectPath: string, runId: string): Promise<void> {
  await withProjectLock(projectPath, async () => {
    let dismissed: ReviewItem[] = []
    await updateIngestRun(projectPath, runId, async (run) => {
      if (!canIgnoreAndArchiveIngestReview(run)) throw new Error("任务状态已变化，请等待写入和审阅结束后再忽略并归档")
      const local = useWikiStore.getState().project?.path === projectPath ? useReviewStore.getState().items : []
      const items = normalizeReviewItems([...(await loadReviewItems(projectPath)), ...local])
      const at = Date.now()
      // 同一事项可能关联多次导入；归档本次记录不代替其他来源作出忽略决定。
      dismissed = items.filter((item) => !item.resolved && !item.historical && !item.hidden &&
        item.runIds?.includes(runId) && item.runIds.every((id) => id === runId))
        .map((item) => ({ ...item, resolved: true, dismissed: true, resolvedAction: "dismiss",
          resolvedEvidenceVersion: item.evidenceVersion, resolutionUpdatedAt: at }))
      if (dismissed.length) await saveReviewItems(projectPath, dismissed)
      run.reviewRequested = false
      delete run.reviewExecutionId
      run.reviewDismissal = { at, revision: run.revision }
      run.archived = true
      run.events.push({ id: crypto.randomUUID(), at, kind: "execution", reason: "用户忽略剩余审阅并归档",
        outcome: `已忽略 ${dismissed.length} 项本次独有待办；保留已写入页面、日志和原审阅结果，共享事项仍可处理` })
    })
    if (useWikiStore.getState().project?.path === projectPath && dismissed.length) {
      useReviewStore.getState().setItems([...useReviewStore.getState().items, ...dismissed])
    }
  })
}
