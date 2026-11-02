import { readFile } from "@/commands/fs"
/** 导入过程只读取持久化历史并发出操作，任务执行独立于视图生命周期。 */
import { useEffect, useState } from "react"
import { Archive, FileText, Search, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { listIngestRuns, updateIngestRun, type IngestRun } from "@/lib/ingest-run"
import { cancelIngestReview, retryIngestReview } from "@/lib/ingest-review-queue"
import { canIgnoreAndArchiveIngestReview, ignoreAndArchiveIngestReview } from "@/lib/ingest-review-archive"
import { cancelTask, enqueueIngest, getQueue, removeStoppedTasks, type IngestTask } from "@/lib/ingest-queue"
import { ActivityPanel } from "@/components/layout/activity-panel"
import { normalizePath } from "@/lib/path-utils"
import { useActivityStore } from "@/stores/activity-store"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { ImportProcessDocumentRow } from "./import-process-document-row"
import { withIngestPipeline } from "@/lib/ingest-pipeline"
import { listIngestDocuments, loadIngestDocument, updateIngestDocument } from "@/lib/ingest-document"
import { loadIngestRun } from "@/lib/ingest-run"
import { ImportProcessRunRow, IMPORT_ROW_GRID } from "./import-process-run-row"
import { exportIngestLog } from "@/lib/ingest-log-export"
import { hasOnlyOptionalReviewFailures, needsReviewAttention, reviewImportance } from "@/lib/review-priority"

const FILTERS = {
  all: "全部",
  active: "进行中",
  writeFailed: "写入失败",
  attention: "需审阅",
  completed: "已完成",
  skipped: "已跳过",
}
type RunFilter = keyof typeof FILTERS
type RunStatus = Exclude<RunFilter, "all">
// 取消同样属于未完成写入，单条删除和批量清理使用相同范围。
const REMOVABLE_WRITE_STATUSES = ["failed", "partial", "recovery-required", "cancelled"]
const REMOVABLE_TASK_STATUSES = ["failed", "cancelled"]
/** 来源和目标页面均优先展示文件名，目录保留为次要上下文。 */
function pathParts(path: string) {
  const normalized = normalizePath(path)
  const separator = normalized.lastIndexOf("/")
  return {
    name: normalized.slice(separator + 1),
    directory: normalized.slice(0, Math.max(0, separator)),
  }
}

/** 以完整写入为阶段边界分类；部分写入仍算失败，后台审阅不能掩盖写入故障。 */
function runStatus(run: IngestRun, needsAttention: boolean): RunStatus {
  if (run.writeStatus === "skipped") return "skipped"
  if (["pending", "running"].includes(run.writeStatus)) return "active"
  if (run.writeStatus !== "complete") return "writeFailed"
  if (run.writeError ?? run.error) return "attention"
  // 失败记录可能仍保留默认 pending；只有已请求且具备页面的审阅才实际排队。
  const reviewQueued = run.reviewStatus === "pending" && run.reviewRequested && Object.keys(run.pages).length > 0
  if (run.reviewStatus === "running" || reviewQueued) return "active"
  if (!needsAttention && (run.reviewStatus === "complete" || hasOnlyOptionalReviewFailures(run))) return "completed"
  return "attention"
}

/** 未形成运行记录的队列任务使用相同分类，失败或取消不算完成。 */
function taskStatus(task: IngestTask): RunStatus {
  if (["pending", "processing"].includes(task.status)) return "active"
  return task.status === "done" ? "completed" : "writeFailed"
}

/** 来源归档以父记录为准，避免批量修改一半子块后留下不完整父行。 */
async function visibleIngestRuns(path: string): Promise<IngestRun[]> {
  const [records, documents] = await Promise.all([listIngestRuns(path), listIngestDocuments(path)])
  const archived = new Set(documents.filter((document) => document.archived).map((document) => document.documentRunId))
  return records.filter((run) => !run.archived && (!run.documentRunId || !archived.has(run.documentRunId)))
}

export function ImportProcessView() {
  const project = useWikiStore((state) => state.project)
  const items = useReviewStore((state) => state.items)
  const activities = useActivityStore((state) => state.items)
  const syncTasks = useFileSyncStore((state) => state.tasks)
  const syncError = useFileSyncStore((state) => state.lastError)
  const [runs, setRuns] = useState<IngestRun[]>([])
  const [tasks, setTasks] = useState<readonly IngestTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<string>()
  const [filter, setFilter] = useState<RunFilter>("all")
  const [search, setSearch] = useState("")
  const [exporting, setExporting] = useState<string>()
  const [exportMessage, setExportMessage] = useState("")
  const [exportError, setExportError] = useState("")
  useEffect(() => {
    let stopped = false
    let reading = false
    setRuns([])
    setTasks([])
    setLoading(Boolean(project))
    setError("")
    setBusy(undefined)
    setFilter("all")
    setSearch("")
    setExporting(undefined)
    setExportMessage("")
    setExportError("")
    const refresh = async () => {
      if (!project || stopped || reading) return
      reading = true
      // 内存队列可立即展示，不等待磁盘中的全部历史清单。
      setTasks([...getQueue()])
      try {
        const records = await visibleIngestRuns(project.path)
        if (!stopped) {
          setRuns(records)
          setTasks([...getQueue()])
          setError("")
        }
      } catch (failure) {
        if (!stopped) setError(String(failure))
      } finally {
        reading = false
        if (!stopped) setLoading(false)
      }
    }
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [project?.id, project?.path])

  async function act(id: string, operation: () => Promise<unknown>) {
    setBusy(id)
    try {
      await operation()
      if (project) {
        const records = await visibleIngestRuns(project.path)
        if (useWikiStore.getState().project?.path === project.path) {
          setRuns(records)
          setTasks([...getQueue()])
        }
      }
    } catch (failure) {
      if (useWikiStore.getState().project?.path === project?.path) setError(String(failure))
    } finally {
      if (useWikiStore.getState().project?.path === project?.path) setBusy(undefined)
    }
  }
  async function exportLog(id: string, sourcePath: string, run?: IngestRun, task?: IngestTask) {
    if (!project || exporting) return
    setExporting(id)
    setExportMessage("")
    setExportError("")
    try {
      const destination = await exportIngestLog(project.path, sourcePath, run, task)
      if (useWikiStore.getState().project?.path === project.path && destination) setExportMessage(`日志已导出：${destination}`)
    } catch (failure) {
      if (useWikiStore.getState().project?.path === project.path) setExportError(`导出日志失败：${String(failure)}`)
    } finally {
      if (useWikiStore.getState().project?.path === project.path) setExporting(undefined)
    }
  }
  if (!project) return null
  const path = project.path
  const sourceMatches = (task: IngestTask, run: IngestRun) => {
    if (task.documentRunId) return task.documentRunId === run.documentRunId
    if (run.documentRunId && ["pending", "processing"].includes(task.status)) return false
    return normalizePath(task.sourcePath) === normalizePath(run.sourcePath) || normalizePath(task.sourcePath) === `${normalizePath(path)}/${run.sourcePath}`
  }
  const pendingTasks = tasks.filter(
    (task) =>
      !runs.some(
        (run) =>
          sourceMatches(task, run) &&
          (Boolean(run.documentRunId) || run.writeStatus === "running" || !["pending", "processing"].includes(task.status)),
      ),
  )
  const rows = runs.map((run) => {
    const related = items.filter((item) => item.runIds?.includes(run.runId) && !item.historical)
    const pendingCount = related.filter(needsReviewAttention).length
    const optionalFailure = hasOnlyOptionalReviewFailures(run)
    const incompleteSteps = Object.entries(run.review?.steps ?? {}).filter(
      ([, result]) => result.status === "incomplete",
    )
    const needsAttention =
      pendingCount > 0 ||
      Boolean(run.writeError ?? run.error) ||
      !optionalFailure && (Boolean(run.reviewError) || incompleteSteps.length > 0 || ["partial", "incomplete"].includes(run.reviewStatus))
    return { run, related, pendingCount, status: runStatus(run, needsAttention) }
  })
  const matchesFilter = (status: RunStatus) => filter === "all" || filter === status
  const query = search.trim().toLocaleLowerCase()
  const grouped = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = row.run.documentRunId && (row.run.chunk?.total ?? 1) > 1 ? row.run.documentRunId : row.run.runId
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  const groups = [...grouped.entries()].map(([id, children]) => {
    children.sort((a, b) => (a.run.chunk?.index ?? 0) - (b.run.chunk?.index ?? 0))
    const active = children.some(({ run }) => run.writeStatus === "running" || run.reviewStatus === "running") || tasks.some((task) => task.status === "processing" && sourceMatches(task, children[0].run))
    const failed = children.some(({ run }) => !["complete", "skipped", "pending"].includes(run.writeStatus))
    const status: RunStatus = children.length === 1 && !children[0].run.documentRunId ? children[0].status : active ? "active" : failed ? "writeFailed" : children.some((row) => row.status === "attention" || row.run.writeStatus === "pending") ? "attention" : children.every((row) => row.status === "skipped") ? "skipped" : children.some((row) => row.status === "active") ? "active" : "completed"
    const related = [...new Map(children.flatMap((row) => row.related).map((item) => [item.id, item])).values()]
    return { id, children, status, pendingCount: related.filter(needsReviewAttention).length }
  })
  const visibleGroups = groups.filter((group) => matchesFilter(group.status) && group.children.some(({ run }) => `${run.sourceIdentity} ${run.sourcePath} ${run.chunk?.headingPath ?? ""} ${Object.keys(run.pages).join(" ")}`.toLocaleLowerCase().includes(query)))
  const visibleRows = visibleGroups.flatMap((group) => group.children)
  const visibleTasks = pendingTasks.filter(
    (task) =>
      matchesFilter(taskStatus(task)) &&
      task.sourcePath.toLocaleLowerCase().includes(query),
  )
  const counts = {
    all: groups.length + pendingTasks.length,
    active:
      groups.filter(({ status }) => status === "active").length +
      pendingTasks.filter((task) => taskStatus(task) === "active").length,
    writeFailed:
      groups.filter(({ status }) => status === "writeFailed").length +
      pendingTasks.filter((task) => taskStatus(task) === "writeFailed").length,
    attention:
      groups.filter(({ status }) => status === "attention").length +
      pendingTasks.filter((task) => taskStatus(task) === "attention").length,
    completed:
      groups.filter(({ status }) => status === "completed").length +
      pendingTasks.filter((task) => taskStatus(task) === "completed").length,
    skipped: groups.filter(({ status }) => status === "skipped").length,
  }
  const completedRuns = groups.filter(({ status }) => status === "completed").flatMap((group) => group.children.map((row) => row.run))
  const canArchive = completedRuns.length > 0
  const canRemoveRun = (run: IngestRun) =>
    (run.chunk?.total ?? 1) <= 1 &&
    REMOVABLE_WRITE_STATUSES.includes(run.writeStatus) &&
    run.reviewStatus !== "running" &&
    !(run.reviewStatus === "pending" && run.reviewRequested && Object.keys(run.pages).length > 0) &&
    !tasks.some((task) => sourceMatches(task, run) && ["pending", "processing"].includes(task.status))
  const removableRuns = visibleRows.filter(({ status, run }) => status === "writeFailed" && canRemoveRun(run)).map(({ run }) => run)
  const removableTaskIds = visibleTasks.filter((task) => REMOVABLE_TASK_STATUSES.includes(task.status)).map((task) => task.id)
  const removableCount = removableRuns.length + removableTaskIds.length

  /** 仅清理队列/显示记录，保留来源、已生成页面、前后快照及导出日志。 */
  async function removeFailureRecords(taskIds: string[], records: IngestRun[]) {
    const ids = new Set(taskIds)
    for (const run of records) {
      for (const task of tasks) {
        if (sourceMatches(task, run) && REMOVABLE_TASK_STATUSES.includes(task.status)) ids.add(task.id)
      }
    }
    if (ids.size) await removeStoppedTasks([...ids])
    for (const run of records) await updateIngestRun(path, run.runId, (record) => {
      if (!canRemoveRun(record)) throw new Error("任务状态已变化或仍在执行，请刷新后再清理失败记录")
      record.archived = true
    })
  }

  async function archiveDocument(id: string, first: IngestRun) {
    return withIngestPipeline(async () => {
      const document = await loadIngestDocument(path, id)
      const records = await Promise.all(document.chunks.map((chunk) => loadIngestRun(path, chunk.runId)))
      if (getQueue().some((task) => sourceMatches(task, first) && ["pending", "processing"].includes(task.status)) || records.some((record) => record.writeStatus === "running" || record.reviewStatus === "running" || record.reviewRequested)) throw new Error("来源仍在执行或排队，请先取消后续执行")
      await updateIngestDocument(path, id, (record) => { record.archived = true })
      const stopped = getQueue().filter((task) => sourceMatches(task, first) && REMOVABLE_TASK_STATUSES.includes(task.status))
      if (stopped.length) await removeStoppedTasks(stopped.map((task) => task.id))
    })
  }

  const renderRun = ({ run, related, pendingCount, status }: (typeof rows)[number]) => {
    const count = Object.keys(run.pages).length
    const task = tasks.find((task) => sourceMatches(task, run) && task.status === "processing")
    const phase =
      run.writeStatus === "running"
        ? activities.find(
            (activity) =>
              activity.type === "ingest" &&
              activity.status === "running" &&
              activity.title === run.sourceIdentity.split("/").pop(),
          )?.detail
        : undefined
    return (
      <ImportProcessRunRow
        key={run.runId}
        run={run}
        relatedCount={related.length}
        pendingCount={pendingCount}
        optionalPendingCount={related.filter((item) => reviewImportance(item) === "optional" && !item.resolved && !item.hidden).length}
        phase={phase}
        onExportLog={() => void exportLog(run.runId, run.sourcePath, run)}
        exporting={exporting === run.runId}
        exportDisabled={Boolean(exporting)}
        onOpenPage={(pagePath) =>
          void act(run.runId, async () =>
            useWikiStore
              .getState()
              .openFileInPreview(`${path}/${pagePath}`, await readFile(`${path}/${pagePath}`)),
          )
        }
      >
        <div className="flex flex-wrap gap-2">
          {related.length > 0 && (
            <Button
              size="sm"
              variant={pendingCount > 0 ? "default" : "outline"}
              onClick={() => {
                useWikiStore.setState({
                  reviewRunFilter: run.runId,
                })
                useWikiStore.getState().setActiveView("review")
              }}
            >
              查看事项
            </Button>
          )}
          {["partial", "failed", "cancelled", "skipped"].includes(run.writeStatus) && (
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => void act(run.runId, () => enqueueIngest(project.id, run.sourcePath))}
            >
              {run.writeStatus === "skipped" ? "重新导入" : "继续补写"}
            </Button>
          )}
          {run.writeStatus === "skipped" && (
            <Button size="sm" variant="ghost" disabled={Boolean(busy)}
              onClick={() => void act(run.runId, () => updateIngestRun(path, run.runId, (record) => { record.archived = true }))}>
              归档记录
            </Button>
          )}
          {REMOVABLE_WRITE_STATUSES.includes(run.writeStatus) && (run.chunk?.total ?? 1) <= 1 && (
            <Button size="sm" variant="ghost" disabled={Boolean(busy) || !canRemoveRun(run)}
              title="只移除失败或已取消的显示记录；正在写入或审阅的任务需先结束，文件和日志保留"
              onClick={() => void act(run.runId, () => removeFailureRecords([], [run]))}>
              删除记录
            </Button>
          )}
          {["complete", "partial", "incomplete", "cancelled"].includes(run.reviewStatus) && count > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => void act(run.runId, () => retryIngestReview(path, run.runId))}
            >
              {run.reviewStatus === "complete" ? "重新审阅" : "重试审阅"}
            </Button>
          )}
          {status === "attention" && (run.chunk?.total ?? 1) <= 1 && canIgnoreAndArchiveIngestReview(run) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(busy)}
              title="忽略本次独有的未处理事项并归档；保留页面、日志和未完成检查记录，多次导入共享的事项仍可处理"
              onClick={() => void act(run.runId, () => ignoreAndArchiveIngestReview(path, run.runId))}
            >
              忽略剩余审阅并归档
            </Button>
          )}
          {task && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy === run.runId}
              onClick={() => void act(run.runId, () => cancelTask(task.id))}
            >
              取消导入
            </Button>
          )}
          {["pending", "running"].includes(run.reviewStatus) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => void act(run.runId, () => cancelIngestReview(path, run.runId))}
            >
              取消审阅
            </Button>
          )}
        </div>
      </ImportProcessRunRow>
    )

  }

  return (
    <div className="h-full overflow-y-auto px-5 py-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">导入过程</h1>
            <p className="mt-2 text-xs text-muted-foreground">
              查看写入进度、自动审阅与待处理事项。切换页面不会中断任务。
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              空内容、仅标题、仅符号或空的排版结构会在调用模型前自动跳过，可在“已跳过”中查看原因。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busy) || removableCount === 0}
              title="仅清理当前筛选和搜索范围内的失败记录，保留原始文件、Wiki 页面和日志"
              onClick={() => void act("remove-failures", () => removeFailureRecords(removableTaskIds, removableRuns))}
            >
              <Trash2 />
              清理失败记录
              <span>{removableCount}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={Boolean(busy) || !canArchive}
              onClick={() =>
                void act("archive", async () => {
                  for (const group of groups.filter((group) => group.status === "completed")) {
                    if (group.children[0].run.documentRunId && (group.children[0].run.chunk?.total ?? 1) > 1) await archiveDocument(group.id, group.children[0].run)
                    else for (const { run } of group.children) await updateIngestRun(path, run.runId, (record) => {
                      if (record.writeStatus === "running" || record.reviewStatus === "running" || record.reviewRequested) throw new Error("任务仍在执行，不能归档")
                      record.archived = true
                    })
                  }
                })
              }
            >
              <Archive />
              归档已完成记录
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {exportMessage && <p role="status" className="mb-3 break-all text-xs text-muted-foreground">{exportMessage}</p>}
        {exportError && <p role="alert" className="mb-3 break-all text-sm text-destructive">{exportError}</p>}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-1" role="group" aria-label="任务筛选">
            {(Object.keys(FILTERS) as RunFilter[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline focus-visible:outline-ring ${filter === key ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {FILTERS[key]}
                <span
                  className={`tabular-nums ${["writeFailed", "attention"].includes(key) && counts[key] > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
                >
                  {counts[key]}
                </span>
              </button>
            ))}
          </div>
          <label className="flex h-8 w-full items-center gap-2 rounded-lg border px-3 text-muted-foreground focus-within:ring-2 focus-within:ring-ring/50 sm:w-64">
            <Search className="size-3.5 shrink-0" />
            <input
              aria-label="搜索来源或页面"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索来源或页面…"
              className="w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div
            className={`${IMPORT_ROW_GRID} hidden border-b bg-muted/30 px-5 py-3 text-xs text-muted-foreground lg:grid`}
          >
            <span>来源 / 导入时间</span>
            <span>写入</span>
            <span>自动审阅</span>
            <span>人工待办</span>
            <span />
          </div>
          {visibleTasks.map((task) => (
            <div
              key={task.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={task.sourcePath}>
                  {pathParts(task.sourcePath).name}
                </p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {task.status === "processing"
                    ? "读取来源或生成页面"
                    : task.status === "pending"
                      ? "等待导入"
                      : task.status === "cancelled"
                        ? "已取消导入"
                        : (task.error ?? (task.status === "done" ? "已完成" : "写入失败"))}
                </p>
              </div>
              <Button size="sm" variant="outline" disabled={Boolean(exporting)} onClick={() => void exportLog(task.id, task.sourcePath, undefined, task)}>
                {exporting === task.id ? "导出中…" : "导出日志"}
              </Button>
              {["failed", "cancelled"].includes(task.status) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => void act(task.id, () => enqueueIngest(project.id, task.sourcePath, task.folderContext))}
                >
                  重新导入
                </Button>
              )}
              {REMOVABLE_TASK_STATUSES.includes(task.status) && (
                <Button size="sm" variant="ghost" disabled={Boolean(busy)}
                  title="只删除此失败或已取消记录，保留原始文件和已生成页面"
                  onClick={() => void act(task.id, () => removeFailureRecords([task.id], []))}>
                  删除记录
                </Button>
              )}
              {["pending", "processing"].includes(task.status) && (
                <Button
                  disabled={Boolean(busy)}
                  size="sm"
                  variant="ghost"
                  onClick={() => void act(task.id, () => cancelTask(task.id))}
                >
                  取消导入
                </Button>
              )}
            </div>
          ))}
          {visibleGroups.map((group) => group.children.length === 1 && (group.children[0].run.chunk?.total ?? 1) <= 1
            ? renderRun(group.children[0])
            : <ImportProcessDocumentRow key={group.id} runs={group.children.map((row) => row.run)} status={group.status} pendingCount={group.pendingCount} busy={Boolean(busy)}
                onExport={() => void exportLog(group.id, group.children[0].run.sourcePath, group.children[0].run)}
                onContinue={() => void act(group.id, async () => {
                  const document = await loadIngestDocument(path, group.id)
                  await updateIngestDocument(path, group.id, (record) => { record.cancelled = false })
                  const records = await Promise.all(document.chunks.map((chunk) => loadIngestRun(path, chunk.runId)))
                  if (records.some((record) => record.writeStatus !== "complete")) await enqueueIngest(project.id, document.sourcePath)
                  else for (const record of records) if (record.reviewStatus !== "complete") await retryIngestReview(path, record.runId)
                })}
                onCancel={() => void act(group.id, async () => {
                  await updateIngestDocument(path, group.id, (record) => { record.cancelled = true })
                  for (const task of tasks) if (sourceMatches(task, group.children[0].run) && ["pending", "processing"].includes(task.status)) await cancelTask(task.id)
                  for (const row of group.children) if (["pending", "running"].includes(row.run.reviewStatus) && row.run.reviewRequested) await cancelIngestReview(path, row.run.runId)
                })}
                onArchive={() => void act(group.id, () => archiveDocument(group.id, group.children[0].run))}>
                {group.children.map(renderRun)}
              </ImportProcessDocumentRow>)}
          {loading && <p role="status" className="px-5 py-4 text-sm text-muted-foreground">正在加载导入记录…</p>}
          {!loading && !error && !visibleRows.length && !visibleTasks.length && (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <FileText className="mb-1 size-7 opacity-50" />
              <p className="text-sm">{counts.all ? "没有符合条件的任务" : "暂无导入记录"}</p>
              <p className="text-xs">
                {counts.all ? "尝试其他筛选条件或搜索词" : "导入资料后，可在这里查看进度与结果"}
              </p>
            </div>
          )}
        </div>
        {(activities.length > 0 || tasks.length > 0 || syncTasks.length > 0 || syncError) && (
          <details className="mt-5 overflow-hidden rounded-lg border">
            <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-muted-foreground">
              队列、文件同步与其他活动
            </summary>
            <ActivityPanel />
          </details>
        )}
        <p className="mt-4 text-[11px] text-muted-foreground">清理失败记录不删除原始文件、已生成页面或导出日志。归档已完成记录仅隐藏已完成任务；忽略剩余审阅并归档会保留原检查结果，且不再自动重试。</p>
      </div>
    </div>
  )
}
