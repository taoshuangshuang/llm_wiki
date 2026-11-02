/** 应用级后台审阅调度：以 run 内持久请求为准，视图卸载不影响执行。 */
import { getTaskLlmConfig } from "./llm-task-routing"
import { hasUsableLlm } from "./has-usable-llm"
import { listIngestRuns, recoverIngestRun, updateIngestRun } from "./ingest-run"
import { abortIngestReviewExecution, hasCurrentReviewEvidence, publishInterruptedIngestReview, runIngestReview } from "./ingest-review"
import { readFile } from "@/commands/fs"
import { loadIngestRun } from "./ingest-run"
import { useWikiStore } from "@/stores/wiki-store"
import { withIngestPipeline } from "./ingest-pipeline"
import { recoverReviewRepair } from "./ingest-review-repair"

let projectPath = ""
let epoch = 0
let controller: AbortController | undefined
let running: Promise<void> | undefined
let runningId = ""
let wakeRequested = false

// 配置补齐后唤醒持久请求；挂载、卸载导入页面不参与任务生命周期。
useWikiStore.subscribe((state, previous) => {
  if (state.llmConfig !== previous.llmConfig || state.providerConfigs !== previous.providerConfigs || state.taskModelRouting !== previous.taskModelRouting || state.projectLlmOverride !== previous.projectLlmOverride) {
    if (projectPath) wakeIngestReviewQueue(projectPath)
  }
})

async function drain(path: string, executionEpoch: number): Promise<void> {
  while (projectPath === path && epoch === executionEpoch) {
    const progressed = await withIngestPipeline(async (lease) => {
      if (projectPath !== path || epoch !== executionEpoch) return false
      const { listIngestDocuments } = await import("./ingest-document")
      const archivedDocuments = new Set((await listIngestDocuments(path)).filter((document) => document.archived).map((document) => document.documentRunId))
      const records = (await listIngestRuns(path)).filter((run) => !archivedDocuments.has(run.documentRunId ?? ""))
      for (const old of records.filter((run) => !run.archived && run.reviewRequested && run.reviewStatus === "pending" && records.some((newer) => newer.sourceIdentity === run.sourceIdentity && (newer.documentSourceRevision ?? newer.sourceRevision) !== (run.documentSourceRevision ?? run.sourceRevision) && newer.createdAt > run.createdAt))) {
        await updateIngestRun(path, old.runId, (run) => { run.reviewStatus = "superseded"; run.reviewRequested = false })
      }
      const next = (await listIngestRuns(path)).filter((run) => !run.archived && !archivedDocuments.has(run.documentRunId ?? "") && run.reviewRequested && run.reviewStatus === "pending" && run.writeStatus !== "running" && Object.keys(run.pages).length).sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!next) return false
      const config = getTaskLlmConfig("ingest")
      if (!hasUsableLlm(config)) return false
      if (projectPath !== path || epoch !== executionEpoch) return false
      const runController = new AbortController()
      const executionId = crypto.randomUUID()
      // 与人工归档使用同一记录锁认领，避免按过期列表启动已归档或已取消的审阅。
      let claimed = false
      await updateIngestRun(path, next.runId, (run) => {
        if (projectPath !== path || epoch !== executionEpoch || run.archived || !run.reviewRequested || run.reviewStatus !== "pending" || run.writeStatus === "running") return
        run.reviewStatus = "running"
        run.reviewExecutionId = executionId
        claimed = true
      })
      if (!claimed) return true
      controller = runController
      runningId = next.runId
      try {
        await runIngestReview(path, next.runId, config, runController.signal, executionId, lease)
      } catch (error) {
        const interrupted = epoch !== executionEpoch
        await updateIngestRun(path, next.runId, (run) => {
          if (run.reviewExecutionId !== executionId) return
          run.reviewStatus = interrupted ? "pending" : runController.signal.aborted ? "cancelled" : "incomplete"
          run.reviewRequested = interrupted
          run.reviewError = error instanceof Error ? error.message : String(error)
        })
      } finally { if (controller === runController) { controller = undefined; runningId = "" } }
      return true
    })
    if (!progressed) return
  }
}

/** 唤醒持久审阅请求；认领和执行必须等待同一串行流水线的执行名额。 */
export function wakeIngestReviewQueue(path: string): void {
  if (path !== projectPath) return
  wakeRequested = true
  if (running) return
  wakeRequested = false
  const executionEpoch = epoch
  const execution = drain(path, executionEpoch).catch((error) => console.error("后台审阅调度失败，持久请求已保留", error)).finally(() => {
    if (running !== execution) return
    running = undefined
    if (wakeRequested && projectPath === path) wakeIngestReviewQueue(path)
  })
  running = execution
}

export async function restoreIngestReviewQueue(path: string): Promise<void> {
  await pauseIngestReviewQueue()
  projectPath = path
  const { listIngestDocuments, ensureDocumentRuns } = await import("./ingest-document")
  const documents = await listIngestDocuments(path)
  const archivedDocuments = new Set(documents.filter((document) => document.archived).map((document) => document.documentRunId))
  for (const document of documents) if (!document.archived) await ensureDocumentRuns(path, document)
  for (const record of await listIngestRuns(path)) {
    if (record.archived || archivedDocuments.has(record.documentRunId ?? "")) continue
    const run = await recoverIngestRun(path, record.runId)
    if (run.writeStatus === "running") await updateIngestRun(path, run.runId, (state) => { state.writeStatus = Object.keys(state.pages).length ? "partial" : "failed"; state.writeError = "应用中断，可继续补写" })
    if (run.reviewStatus === "running") await updateIngestRun(path, run.runId, (state) => { state.reviewStatus = "pending"; state.reviewRequested = true })
  }
  wakeIngestReviewQueue(path)
}

/** 项目切换等待已发出的短持久化结束，避免旧结果写入新项目 Store。 */
export async function pauseIngestReviewQueue(): Promise<void> {
  const pathBeforePause = projectPath
  epoch++
  projectPath = ""
  controller?.abort()
  controller = undefined
  runningId = ""
  running = undefined
  if (!pathBeforePause) return
  abortIngestReviewExecution(pathBeforePause)
  // 模型可能忽略取消；只等待已发出的记录写入，不等待网络回调。
  const { withProjectLock } = await import("./project-mutex")
  for (const run of await listIngestRuns(pathBeforePause)) {
    if (run.reviewStatus === "running") await updateIngestRun(pathBeforePause, run.runId, (state) => { state.reviewStatus = "pending"; state.reviewRequested = true; delete state.reviewExecutionId })
  }
  await withProjectLock(pathBeforePause, async () => {})
}

export async function retryIngestReview(path: string, runId: string, affectedPages: string[] = []): Promise<void> {
  // 关联页来自持久化审阅材料，只接受 Wiki 正文路径，不能借重查读取项目外文件。
  for (const page of affectedPages) {
    if (!page.startsWith("wiki/") || !page.endsWith(".md") || /[\\\x00-\x1f:]/.test(page) || page.split("/").some((part) => !part || part.startsWith("."))) throw new Error(`核查页面路径无效：${page}`)
  }
  const previous = await loadIngestRun(path, runId)
  if (previous.reviewStatus === "running") return
  if (previous.writeStatus === "running") throw new Error("来源正在写入，请在写入结束后重试审阅")
  const currentPages: Record<string, string> = {}
  for (const page of new Set([...Object.keys(previous.pages), ...Object.keys(previous.review?.currentPages ?? {}), ...affectedPages])) currentPages[page] = await readFile(`${path}/${page}`)
  // 审批通过的候选稿仍需对照原来源复核，不能当作普通人工编辑跳过覆盖检查。
  const repairedPages = previous.autoRepair ? await recoverReviewRepair(path, runId) : undefined
  const automaticRepair = Boolean(repairedPages && Object.entries(currentPages).every(([page, text]) => repairedPages[page] === text))
  const changed = Object.entries(currentPages).some(([page, text]) => text !== (previous.review?.currentPages?.[page] ?? previous.pages[page]?.after))
  // 重试必须同时验证引用页版本，否则会反复沿用已失效的完成记录。
  const staleEvidence = Boolean(previous.review) && !await hasCurrentReviewEvidence(path, previous)
  await updateIngestRun(path, runId, (run) => {
    if (run.archived !== previous.archived || run.revision !== previous.revision || run.reviewStatus === "running") throw new Error("任务状态已变化，请刷新后重新核查")
    if (run.review) (run.reviewHistory ??= []).push(structuredClone(run.review))
    if (changed || staleEvidence || previous.reviewStatus === "complete") run.review = { revision: run.revision, steps: {}, stepItems: {}, issueIds: [], updatedAt: Date.now(), currentPages: changed ? currentPages : previous.review?.currentPages, automaticRepair: automaticRepair || !changed && previous.review?.automaticRepair }
    // 显式重试仍应执行未完成检查，不能被修复后的快速发布标记跳过。
    if (run.review) delete run.review.localRepairVerified
    // 人工明确重查可以重新打开归档记录；自动恢复和普通缓存命中不能撤销忽略决定。
    run.archived = false
    delete run.reviewDismissal
    run.reviewStatus = "pending"; run.reviewRequested = true; delete run.reviewError
  })
  if (previous.documentRunId) {
    const { updateIngestDocument } = await import("./ingest-document")
    await updateIngestDocument(path, previous.documentRunId, (document) => { document.archived = false })
  }
  wakeIngestReviewQueue(path)
}

export async function cancelIngestReview(path: string, runId: string): Promise<void> {
  await updateIngestRun(path, runId, (run) => { run.reviewStatus = "cancelled"; run.reviewRequested = false; delete run.reviewExecutionId })
  abortIngestReviewExecution(path, runId)
  if (path === projectPath && runningId === runId) {
    epoch++
    controller?.abort()
    controller = undefined
    runningId = ""
    running = undefined
    wakeIngestReviewQueue(path)
  }
  await publishInterruptedIngestReview(path, runId)
}
