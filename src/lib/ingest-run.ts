/** 可靠入库业务日志：先持久化意图，再提交页面，重启后只核实和补登记。 */
import { compareAndWriteFile, createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { contentRevision } from "./content-revision"
import { normalizePath } from "./path-utils"
import { withProjectLock } from "./project-mutex"
import type { ReviewItem, ReviewEvidence } from "@/stores/review-store"
import type { IngestSourceSkip } from "./ingest-source-content"
import { readIngestHistory } from "./ingest-history"

export type IngestWriteStatus = "pending" | "running" | "complete" | "partial" | "failed" | "cancelled" | "recovery-required" | "skipped"
export type IngestReviewStatus = "pending" | "running" | "complete" | "partial" | "incomplete" | "cancelled" | "superseded" | "not-applicable"
export type IngestWriteMode = "create" | "merge" | "replace" | "independent" | "maintenance"

export interface IngestRunPage {
  path: string
  before: string | null
  after: string
  revision: string
  unitIds: string[]
  mode: IngestWriteMode
}

export interface IngestRunEvent {
  id: string
  at: number
  kind: "merge" | "format" | "execution"
  path?: string
  reason: string
  outcome: string
  candidates?: string[]
  /** 目标核对的校验错误、模型理由和原始响应，供人工追溯。 */
  details?: string
  /** 合并目标不确定时固定候选全文，后台审阅不依赖候选页仍保持原样。 */
  candidateSnapshots?: Record<string, string>
  /** 仅实际执行失败转人工；主动不合并和成功事件只记日志。 */
  reviewRequired?: boolean
}

/** 兼容历史自动修复日志；当前流程不再创建修复任务，仅保留原始记录供人工查看。 */
export interface IngestAutoRepair {
  /** v2 采用局部补丁和定向复核，不重复执行整套审阅。 */
  version?: 2
  status: "running" | "applied" | "failed" | "approval-required"
  startedAt: number
  reason?: string
  issues: ReviewItem[]
  verifiedIds: string[]
  issueReasons?: Record<string, string>
  elapsedMs?: number
  pages: Record<string, {
    before: string
    proposed: string
    status: "proposed" | "applied" | "failed" | "approval-required"
    reason?: string
  }>
}

/** 每次方案在生成前登记额度，提交前固定快照；中断后只核实，绝不重放写入。 */
export interface IngestRepairAttempt {
  id: string
  stage: "format" | "content" | "knowledge" | "merge"
  inputRevision: string
  issueKeys: string[]
  issues: ReviewItem[]
  status: "running" | "applied" | "verified" | "failed" | "approval-required"
  startedAt: number
  reason?: string
  verificationStarted?: boolean
  pages: Record<string, { before: string; proposed: string; actual?: string; status: "proposed" | "applied" | "failed" | "approval-required" }>
}

export interface IngestRun {
  version: 1
  runId: string
  projectId: string
  documentRunId?: string
  documentSourceRevision?: string
  chunk?: Omit<import("./ingest-document").SourceChunkPlan, "main">
  sourcePath: string
  sourceIdentity: string
  sourceRevision: string
  attempt: number
  createdAt: number
  updatedAt: number
  writeStatus: IngestWriteStatus
  reviewStatus: IngestReviewStatus
  revision: number
  reviewRequested: boolean
  reviewExecutionId?: string
  error?: string
  writeError?: string
  reviewError?: string
  /** 前置过滤的原因；跳过既不代表入库成功，也不属于执行失败。 */
  sourceSkip?: IngestSourceSkip
  archived?: boolean
  /** 人工放弃剩余审阅的时间与写入版本，原检查状态及错误仍保留。 */
  reviewDismissal?: { at: number; revision: number }
  pages: Record<string, IngestRunPage>
  events: IngestRunEvent[]
  generation?: { raw: string; analysis: string; sourceContext: string; incomplete: boolean; unfinishedPaths?: string[]; inputFingerprint?: string }
  /** 明确的请求名称到实际落盘路径；恢复时继续维护尚未更新的历史引用。 */
  linkRedirects?: Record<string, string>
  completedUnits: Record<string, string>
  pending?: { path: string; before: string | null; after: string; unitId: string; mode: IngestWriteMode }
  /** 新流程的一轮修复账本；不随重新审阅、规则变更或检查点失效清空。 */
  repairAttempts?: IngestRepairAttempt[]
  autoRepair?: IngestAutoRepair
  review?: {
    revision: number
    steps: Record<string, { status: "complete" | "incomplete" | "not-applicable"; reason?: string }>
    stepItems: Record<string, ReviewItem[]>
    issueIds: string[]
    updatedAt: number
    model?: { provider: string; model: string; rulesRevision: string }
    corpusIdentity?: string
    planId?: string
    batches?: IngestReviewBatch[]
    activeBatchId?: string
    retrieval?: import("./evidence-retrieval").RetrievalResult
    currentPages?: Record<string, string>
    /** 兼容旧版已落盘的修复结果，历史候选稿仍可按原来源核对覆盖。 */
    automaticRepair?: boolean
    /** 仅兼容旧版存储字段，当前审阅不再按此标记跳过检查。 */
    localRepairVerified?: boolean
    rules?: { schema: string; purpose?: string; system?: string; background: string; filter: string; content: string }
    statistics?: { requests: number; inputChars: number; outputChars: number; failedRequests: number; elapsedMs: number }
    coverageChecks?: Record<string, { summary: string; issues: import("./ingest-acceptance").AcceptanceIssue[] }>
    commonChecks?: Record<string, { status: "complete" | "incomplete"; items: ReviewItem[]; reason?: string; materialRefs?: { path: string; revision: string; startLine?: number; endLine?: number }[] }>
    historical?: boolean
    scopeChecks?: { verdict: Record<string, boolean>; evidence: ReviewEvidence[] }[]
    knowledgeChecks?: Record<string, { status: "complete" | "incomplete"; items: ReviewItem[]; reason?: string }>
  }
  reviewHistory?: NonNullable<IngestRun["review"]>[]
}

/** 固定十页批次；目标结果与模型分项独立保存，重试不重排成员。 */
export interface IngestReviewBatch {
  batchId: string
  index: number
  pageRefs: { path: string; revision: string; targetId: string }[]
  status: "pending" | "running" | "complete" | "incomplete"
  dependency?: string
  retrieval?: import("./evidence-retrieval").RetrievalResult
  checks: Record<string, { status: "complete" | "incomplete"; items: ReviewItem[]; reason?: string; materialRefs?: { path: string; revision: string; startLine?: number; endLine?: number }[] }>
  attempts: number
  elapsedMs: number
  statistics?: { requests: number; inputChars: number; outputChars: number; failedRequests: number }
  error?: string
}

export { contentRevision } from "./content-revision"

function runDirectory(projectPath: string, runId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("入库运行 ID 无效")
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-runs/${runId}`
}

export async function loadIngestRun(projectPath: string, runId: string): Promise<IngestRun> {
  const run = JSON.parse(await readFile(`${runDirectory(projectPath, runId)}/manifest.json`)) as IngestRun
  if (run.version !== 1 || run.runId !== runId || !run.pages || !run.completedUnits) throw new Error(`入库记录损坏：${runId}`)
  const validPath = (path: string) => path.startsWith("wiki/") && path.endsWith(".md") && !/[\\\x00-\x1f:]/.test(path) && path.split("/").every((part) => part && part !== "." && part !== "..")
  if (Object.keys(run.pages).some((path) => !validPath(path)) || (run.pending && !validPath(run.pending.path))) throw new Error(`入库记录包含无效页面路径：${runId}`)
  return run
}

export async function listIngestRuns(projectPath: string): Promise<IngestRun[]> {
  const root = `${normalizePath(projectPath)}/.llm-wiki/ingest-runs`
  const runs = await readIngestHistory(root, (id) => loadIngestRun(projectPath, id), (id) => /^[a-zA-Z0-9-]+$/.test(id))
  return runs.sort((a, b) => b.createdAt - a.createdAt)
}

/** 每次修改重新读取磁盘状态，避免审阅任务和写入任务互相覆盖字段。 */
export async function updateIngestRun(projectPath: string, runId: string, update: (run: IngestRun) => void | Promise<void>): Promise<IngestRun> {
  return withProjectLock(`ingest-record\0${projectPath}\0${runId}`, async () => {
    const run = await loadIngestRun(projectPath, runId)
    await update(run)
    run.updatedAt = Date.now()
    await writeFileAtomic(`${runDirectory(projectPath, runId)}/manifest.json`, JSON.stringify(run, null, 2))
    return run
  })
}

/** 仅未完成的相同来源版本继续原 run；来源正文在开始时固定保存。 */
export async function beginIngestRun(projectPath: string, projectId: string, sourcePath: string, sourceIdentity: string, content: string, options?: { resume?: boolean; documentRunId?: string; documentSourceRevision?: string; runId?: string; chunk?: IngestRun["chunk"]; pending?: boolean }): Promise<IngestRun> {
  const sourceRevision = await contentRevision(content)
  if (options?.runId && await fileExists(`${runDirectory(projectPath, options.runId)}/manifest.json`)) {
    const existing = await loadIngestRun(projectPath, options.runId)
    if (existing.documentRunId !== options.documentRunId || existing.chunk?.id !== options.chunk?.id || existing.sourceRevision !== sourceRevision) throw new Error("子块身份与固定计划不一致")
    return existing
  }
  const previous = options?.resume === false ? undefined : (await listIngestRuns(projectPath)).find((run) => !run.archived && run.sourceIdentity === sourceIdentity && run.sourceRevision === sourceRevision && run.documentRunId === options?.documentRunId && run.chunk?.id === options?.chunk?.id && run.writeStatus !== "complete")
  if (previous) {
    await recoverIngestRun(projectPath, previous.runId)
    return updateIngestRun(projectPath, previous.runId, (run) => {
      if (run.writeStatus === "recovery-required") throw new Error(run.writeError ?? run.error ?? "入库记录需要人工恢复")
      run.attempt++
      run.writeStatus = "running"
      delete run.sourceSkip
      delete run.error
      delete run.writeError
    })
  }
  const run: IngestRun = {
    version: 1, runId: options?.runId ?? crypto.randomUUID(), projectId, sourcePath, sourceIdentity, sourceRevision,
    documentRunId: options?.documentRunId, documentSourceRevision: options?.documentSourceRevision, chunk: options?.chunk,
    attempt: 1, createdAt: Date.now(), updatedAt: Date.now(), writeStatus: options?.pending ? "pending" : "running", reviewStatus: "pending",
    revision: 0, reviewRequested: false, pages: {}, completedUnits: {}, events: [],
  }
  const directory = runDirectory(projectPath, run.runId)
  await createDirectory(directory)
  await writeFileAtomic(`${directory}/source.json`, JSON.stringify({ content, sourceRevision }))
  await writeFileAtomic(`${directory}/manifest.json`, JSON.stringify(run, null, 2))
  return run
}

export async function readIngestRunSource(projectPath: string, runId: string): Promise<string> {
  const source = JSON.parse(await readFile(`${runDirectory(projectPath, runId)}/source.json`)) as { content: string; sourceRevision: string }
  if (await contentRevision(source.content) !== source.sourceRevision) throw new Error("入库来源快照损坏")
  return source.content
}

async function registerCommit(run: IngestRun, pending: NonNullable<IngestRun["pending"]>): Promise<void> {
  const previous = run.pages[pending.path]
  run.pages[pending.path] = {
    path: pending.path, before: previous ? previous.before : pending.before, after: pending.after,
    revision: await contentRevision(pending.after), mode: pending.mode,
    unitIds: [...new Set([...(previous?.unitIds ?? []), pending.unitId])],
  }
  run.completedUnits[pending.unitId] = pending.path
  run.revision++
  run.reviewRequested = true
  run.reviewStatus = "pending"
  delete run.pending
}

/** 崩溃后不重放覆盖：只有当前正文等于意图正文才补登记，等于旧版则等待补提交。 */
export async function recoverIngestRun(projectPath: string, runId: string): Promise<IngestRun> {
  return withProjectLock(`ingest-record\0${projectPath}\0${runId}`, async () => {
    const run = await loadIngestRun(projectPath, runId)
    if (!run.pending) return run
    const target = `${projectPath}/${run.pending.path}`
    const current = await fileExists(target) ? await readFile(target) : null
    if (current === run.pending.after) await registerCommit(run, run.pending)
    else if (current === run.pending.before) delete run.pending
    else {
      run.writeStatus = "recovery-required"
      run.error = run.writeError = `页面版本无法核实，保留当前文件，需恢复：${run.pending.path}`
    }
    await writeFileAtomic(`${runDirectory(projectPath, runId)}/manifest.json`, JSON.stringify(run, null, 2))
    return run
  })
}

/** 持久意图与旧快照必须成功后才能提交；结果登记失败仍保留可恢复意图。 */
export async function commitIngestPage(projectPath: string, runId: string, path: string, before: string | null, after: string, unitId: string, mode: IngestWriteMode): Promise<void> {
  await updateIngestRun(projectPath, runId, (run) => {
    if (run.pending) throw new Error("上次页面提交尚未恢复，停止新的覆盖")
    run.pending = { path, before, after, unitId, mode }
  })
  try {
    await compareAndWriteFile(projectPath, path, before, after)
  } catch (error) {
    if (String(error).includes("INGEST_VERSION_CONFLICT")) {
      await updateIngestRun(projectPath, runId, (run) => { delete run.pending })
      throw error
    }
    // 提交可能已成功但响应丢失；先核实，禁止简单清除意图再重写。
    await recoverIngestRun(projectPath, runId)
    throw error
  }
  await withProjectLock(`ingest-record\0${projectPath}\0${runId}`, async () => {
    const run = await loadIngestRun(projectPath, runId)
    if (!run.pending) throw new Error("入库写入意图丢失")
    await registerCommit(run, run.pending)
    await writeFileAtomic(`${runDirectory(projectPath, runId)}/manifest.json`, JSON.stringify(run, null, 2))
  })
  await markPreviousPageReviewsHistorical(projectPath, runId, path, after)
}

/** 后续子块改变共享页时保留旧报告与原快照，仅更新其适用性和待办历史标记。 */
async function markPreviousPageReviewsHistorical(projectPath: string, runId: string, path: string, after: string): Promise<void> {
  const previous = (await listIngestRuns(projectPath)).filter((run) => run.runId !== runId && run.pages[path] && run.pages[path].after !== after && run.review)
  if (!previous.length) return
  for (const run of previous) await updateIngestRun(projectPath, run.runId, (record) => {
    if (record.review) record.review.historical = true
  })
  const { loadReviewItems, saveReviewItems } = await import("./persist")
  const { useReviewStore } = await import("@/stores/review-store")
  const { useWikiStore } = await import("@/stores/wiki-store")
  const ids = new Set(previous.map((run) => run.runId))
  const local = useWikiStore.getState().project?.path === projectPath ? useReviewStore.getState().items : []
  const items = [...await loadReviewItems(projectPath), ...local].filter((item) => item.runIds?.some((id) => ids.has(id)) && item.evidence?.some((entry) => entry.path === path && entry.revision !== undefined))
  await saveReviewItems(projectPath, items.map((item) => ({ ...item, historical: true })))
  if (useWikiStore.getState().project?.path === projectPath) useReviewStore.getState().setItems(await loadReviewItems(projectPath))
}
