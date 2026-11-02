import { useState, type ReactNode } from "react"
import { AlertCircle, Check, ChevronRight, Clock3, Download, FileText, Loader2 } from "lucide-react"
import type { IngestRun, IngestWriteStatus, IngestReviewStatus } from "@/lib/ingest-run"
import { normalizePath } from "@/lib/path-utils"
import { hasOnlyOptionalReviewFailures } from "@/lib/review-priority"

const WRITE_LABELS: Record<IngestWriteStatus, string> = {
  pending: "等待写入",
  running: "写入中",
  complete: "完整写入",
  partial: "部分写入",
  failed: "写入失败",
  cancelled: "已取消导入",
  "recovery-required": "需要恢复",
  skipped: "已跳过",
}
const REVIEW_LABELS: Record<IngestReviewStatus, string> = {
  pending: "等待审阅",
  running: "审阅中",
  complete: "审阅完成",
  partial: "部分完成",
  incomplete: "审阅未完成",
  cancelled: "已取消审阅",
  superseded: "已被新版本替代",
  "not-applicable": "未执行",
}
const STEP_LABELS: Record<string, string> = {
  merge: "合并处理",
  format: "格式校验",
  content: "内容校验",
  conflict: "历史本轮互查",
  supplement: "知识补充建议",
  knowledge: "全库相关知识",
}
const MODE_LABELS = {
  create: "新建",
  merge: "合并",
  replace: "更新",
  independent: "独立写入",
  maintenance: "维护",
}
type StatusTone = "active" | "success" | "warning" | "muted"
export const IMPORT_ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,1fr)_140px_140px_100px_20px]"

/** 用文字和图标共同表达状态，避免仅依赖颜色。 */
function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  const style = {
    active: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    muted: "bg-muted text-muted-foreground",
  }[tone]
  const Icon = tone === "active" ? Loader2 : tone === "success" ? Check : tone === "warning" ? AlertCircle : Clock3
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${style}`}>
      <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${tone === "active" ? "animate-spin" : ""}`} />
      {label}
    </span>
  )
}

/** 来源和目标页面均优先展示文件名，目录保留为次要上下文。 */
function pathParts(path: string) {
  const normalized = normalizePath(path)
  const separator = normalized.lastIndexOf("/")
  return {
    name: normalized.slice(separator + 1),
    directory: normalized.slice(0, Math.max(0, separator)),
  }
}

interface ImportProcessRunRowProps {
  run: IngestRun
  relatedCount: number
  pendingCount: number
  optionalPendingCount?: number
  phase?: string
  children: ReactNode
  onOpenPage: (path: string) => void
  onExportLog: () => void
  exporting?: boolean
  exportDisabled?: boolean
}

/** 展示一条导入记录；执行动作由页面传入，折叠不影响后台任务。 */
export function ImportProcessRunRow({
  run,
  relatedCount,
  pendingCount,
  optionalPendingCount = 0,
  phase,
  children,
  onOpenPage,
  onExportLog,
  exporting,
  exportDisabled,
}: ImportProcessRunRowProps) {
  const [open, setOpen] = useState(false)
  const count = Object.keys(run.pages).length
  const optionalFailure = hasOnlyOptionalReviewFailures(run)
  const source = pathParts(run.sourceIdentity)
  const incompleteSteps = Object.entries(run.review?.steps ?? {}).filter(([, result]) => result.status === "incomplete")
  const writeTone: StatusTone =
    run.writeStatus === "running"
      ? "active"
      : run.writeStatus === "complete"
        ? "success"
        : ["partial", "failed", "recovery-required"].includes(run.writeStatus)
          ? "warning"
          : "muted"
  const reviewTone: StatusTone =
    run.reviewStatus === "running"
      ? "active"
      : run.reviewStatus === "complete" || optionalFailure
        ? "success"
        : ["partial", "incomplete"].includes(run.reviewStatus)
          ? "warning"
          : "muted"
  const checksAreCurrent = run.review?.revision === run.revision && !run.review?.historical
  const batches = run.review?.batches ?? []
  const currentBatch = batches.find((batch) => batch.batchId === run.review?.activeBatchId)
  const completedBatches = batches.filter((batch) => batch.status === "complete").length
  const notice = [
    (run.writeError ?? run.error) && `${run.writeStatus === "complete" ? "写入后处理" : "写入"}：${run.writeError ?? run.error}`,
    run.reviewError && `审阅：${run.reviewError}`,
    ...incompleteSteps.map(
      ([step, result]) => run.reviewError?.includes(result.reason ?? "\0") ? "" :
        `${!checksAreCurrent ? "上次审阅记录：" : ""}${STEP_LABELS[step] ?? step}未完成${result.reason ? `：${result.reason}` : ""}`,
    ),
  ]
    .filter(Boolean)
    .join("；")
  return (
    <details open={open} onToggle={(event) => {
      // 子级 details 的事件不应改变整条记录的展开状态。
      if (event.target === event.currentTarget) setOpen(event.currentTarget.open)
    }} className="group/run border-b last:border-b-0 open:bg-muted/10">
      <summary className="cursor-pointer list-none px-5 py-4 transition-colors hover:bg-muted/30 focus-visible:outline focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <div className={IMPORT_ROW_GRID}>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={run.sourceIdentity}>
              {(run.chunk?.total ?? 1) > 1 ? `子块 ${run.chunk!.index} · ${run.chunk!.headingPath || source.name}` : source.name}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={source.directory}>
              {source.directory || "根目录"}
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {new Date(run.createdAt).toLocaleString()} · 第 {run.attempt} 次尝试
            </p>
            {run.sourceSkip && <p className="mt-2 text-xs text-muted-foreground">跳过原因：{run.sourceSkip.message}</p>}
            <button
              type="button"
              disabled={exportDisabled}
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); onExportLog() }}
            >
              <Download className="size-3" />
              {exporting ? "导出中…" : "导出日志"}
            </button>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="col-start-2 row-start-1 size-4 justify-self-end text-muted-foreground transition-transform group-open/run:rotate-90 lg:col-start-5"
          />
          <div className="col-span-2 flex flex-wrap items-start gap-x-5 gap-y-3 lg:col-span-3 lg:col-start-2 lg:row-start-1 lg:grid lg:grid-cols-[140px_140px_100px]">
            <div>
              <StatusBadge label={WRITE_LABELS[run.writeStatus]} tone={writeTone} />
              <p className="mt-1.5 pl-2 text-[11px] text-muted-foreground">{count} 页</p>
            </div>
            <div>
              <StatusBadge label={optionalFailure ? "重要审阅完成" : REVIEW_LABELS[run.reviewStatus]} tone={reviewTone} />
              {batches.length > 0 ? <p className="mt-1.5 pl-2 text-[11px] text-muted-foreground">{currentBatch ? `第 ${currentBatch.index}/${batches.length} 批 · ` : ""}{completedBatches}/{batches.length} 批完成</p>
                : ["pending", "running"].includes(run.writeStatus) && <p className="mt-1.5 pl-2 text-[11px] text-muted-foreground">{run.writeStatus === "pending" ? "等待处理" : "等待写入完成后审阅"}</p>}
              {run.reviewStatus === "complete" && count > 0 && (
                <p className="mt-1.5 pl-2 text-[11px] text-muted-foreground">
                  {run.writeStatus !== "complete" ? "仅检查已写页面" : relatedCount === 0 ? "未发现问题" : ""}
                </p>
              )}
            </div>
            <div className="py-1 text-xs text-muted-foreground">
              {relatedCount > 0 ? (
                <span className={pendingCount > 0 ? "font-medium text-amber-600 dark:text-amber-400" : ""}>
                  {pendingCount > 0 ? `${pendingCount} 项待处理` : optionalPendingCount > 0 ? "无重要待审项" : "全部已处理"}
                  {optionalPendingCount > 0 && <span className="mt-1 block font-normal text-muted-foreground">{optionalPendingCount} 项非重要待办</span>}
                </span>
              ) : (
                "—"
              )}
            </div>
          </div>
        </div>
        {notice && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 group-open/run:hidden dark:text-amber-400">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="line-clamp-2 break-words" title={notice}>
              {notice}
            </span>
          </div>
        )}
      </summary>
      {/* 原生 details 只隐藏内容；按展开状态挂载，避免首屏构建所有历史快照。 */}
      {open && <div className="space-y-5 border-t px-5 py-4 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">任务详情</h2>
          {children}
        </div>
        {!!run.repairAttempts?.length && <details className="rounded-lg border p-3">
          <summary className="cursor-pointer font-medium">自动处理记录（每个问题限一轮）</summary>
          {run.repairAttempts.map((attempt) => <details key={attempt.id} className="mt-3 rounded border p-2">
            <summary className="cursor-pointer">{STEP_LABELS[attempt.stage] ?? attempt.stage} · {attempt.status === "verified" ? "修复并复查通过" : attempt.status === "approval-required" ? "等待重要档案审核" : attempt.status === "failed" ? "转人工处理" : "核实实际状态中"}</summary>
            <p className="mt-2 whitespace-pre-wrap">{attempt.reason}</p>
            {Object.entries(attempt.pages).map(([path, page]) => <details key={path} className="mt-2">
              <summary className="cursor-pointer break-all">{path} · {page.status === "applied" ? "已改变" : page.status === "approval-required" ? "等待审核" : page.status === "failed" ? "提交失败" : "候选稿"}</summary>
              <div className="mt-2 grid gap-3 lg:grid-cols-2">
                <div>修改前<pre className="max-h-80 overflow-auto whitespace-pre-wrap">{page.before}</pre></div>
                <div>修复方案<pre className="max-h-80 overflow-auto whitespace-pre-wrap">{page.proposed}</pre></div>
              </div>
              {page.actual !== undefined && page.actual !== page.proposed && <div>已核实的实际页面<pre className="max-h-80 overflow-auto whitespace-pre-wrap">{page.actual}</pre></div>}
            </details>)}
          </details>)}
        </details>}
        {run.autoRepair && (
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer font-medium">历史自动修复记录（已停用）</summary>
            <p className="mt-2 text-muted-foreground">{run.autoRepair.status === "running" ? "自动修复已停用，保留当时的候选修改供人工核查" : run.autoRepair.reason ?? "历史候选修改仅供人工核查"}</p>
            {run.autoRepair.elapsedMs !== undefined && <p className="mt-1 text-muted-foreground">自动修复用时 {Math.round(run.autoRepair.elapsedMs / 1000)} 秒</p>}
            {Object.entries(run.autoRepair.pages).map(([pagePath, repair]) => (
              <details key={pagePath} className="mt-3 rounded border p-2">
                <summary className="cursor-pointer break-all">{pagePath} · {repair.status === "applied" ? "已提交" : repair.status === "approval-required" ? "等待重要档案审核" : repair.status === "failed" ? "提交失败" : "候选修改"}</summary>
                {repair.reason && <p className="mt-2 text-amber-600">{repair.reason}</p>}
                <div className="mt-2 grid gap-3 lg:grid-cols-2">
                  <div><p className="mb-1 font-medium">修复前</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap">{repair.before}</pre></div>
                  <div><p className="mb-1 font-medium">候选修改</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap">{repair.proposed}</pre></div>
                </div>
              </details>
            ))}
          </details>
        )}
        {phase && (
          <p className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
            <Loader2 className="size-3.5 animate-spin" />
            当前阶段：{phase}
          </p>
        )}
        {run.sourceSkip && (
          <div className="space-y-2 rounded-lg bg-muted/50 p-3 leading-relaxed">
            <p className="font-medium">已跳过：{run.sourceSkip.message}</p>
            <p className="text-muted-foreground">未调用模型、未写入知识页、未启动自动审阅。原始文件保留，补充正文后可重新导入。</p>
          </div>
        )}
        {notice && (
          <div className="space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 leading-relaxed">
            <p className="font-medium text-amber-700 dark:text-amber-400">
              {optionalFailure ? "非重要检查提示" : "需要关注"}
              {!checksAreCurrent && incompleteSteps.length > 0 ? " · 含上次审阅记录" : ""}
            </p>
            <p className="whitespace-pre-wrap break-words">{notice}</p>
          </div>
        )}
        {Object.keys(run.review?.steps ?? {}).length > 0 && (
          <section>
            <h3 className="mb-2 text-muted-foreground">审阅检查{!checksAreCurrent ? " · 历史版本" : ""}</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(run.review!.steps).map(([step, result]) => (
                <span
                  key={step}
                  title={result.reason}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 ${result.status === "incomplete" ? "border-amber-500/20 text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                >
                  {result.status === "complete" ? (
                    <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
                  ) : result.status === "incomplete" ? (
                    <AlertCircle className="size-3" />
                  ) : (
                    <span>—</span>
                  )}
                  {STEP_LABELS[step] ?? step}
                  <span className="sr-only">
                    ：
                    {result.status === "complete" ? "已检查" : result.status === "not-applicable" ? "不适用" : "未完成"}
                  </span>
                </span>
              ))}
            </div>
          </section>
        )}
        {batches.length > 0 && <section className="space-y-2">
          <h3 className="text-muted-foreground">审阅批次 · {completedBatches}/{batches.length} 已完成</h3>
          {batches.map((batch) => <details key={batch.batchId} className="rounded border p-3">
            <summary className="cursor-pointer">第 {batch.index}/{batches.length} 批 · {batch.pageRefs.length} 页 · {batch.status === "complete" ? "已完成" : batch.status === "running" ? "执行中" : batch.status === "incomplete" ? "未完成" : "等待处理"}</summary>
            <p className="mt-2 text-muted-foreground">第 {batch.attempts} 次执行 · 累计 {(batch.elapsedMs / 1000).toFixed(1)} 秒</p>
            {batch.error && <p className="mt-2 whitespace-pre-wrap text-amber-700 dark:text-amber-400">{batch.error}</p>}
            <ul className="mt-2 space-y-1">{batch.pageRefs.map((ref) => <li key={ref.path} className="break-all">{ref.path} · {({ matched: "已检索", no_match: "检索无命中", incomplete: "检查不完整", not_run: "未执行" })[batch.retrieval?.targetResults.find((target) => target.targetId === ref.targetId)?.status ?? "not_run"]}</li>)}</ul>
          </details>)}
        </section>}
        {run.writeStatus !== "skipped" && <WrittenPages pages={run.pages} onOpenPage={onOpenPage} />}
        <details className="border-t pt-3 text-muted-foreground">
          <summary className="w-fit cursor-pointer">运行详情</summary>
          <div className="mt-3 space-y-2 break-words">
            {run.events.map((event) => (
              <p key={event.id}>
                {event.reason} · {event.outcome}
              </p>
            ))}
            <p className="break-all">来源：{run.sourcePath}</p>
            <p className="break-all">
              运行 ID：{run.runId} · 写入版本：{run.revision}
            </p>
          </div>
        </details>
      </div>}
    </details>
  )
}

/** 目标页面与前后快照合并展示，按需展开正文证据。 */
function WrittenPages({ pages, onOpenPage }: { pages: IngestRun["pages"]; onOpenPage: (path: string) => void }) {
  const count = Object.keys(pages).length
  return (
    <section>
      <h3 className="mb-2 text-muted-foreground">写入页面 · {count}</h3>
      <div className="divide-y rounded-lg border">
        {Object.values(pages).map((page) => (
          <div key={page.path} className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <FileText className="size-3.5 text-muted-foreground" />
              <button
                className="min-w-0 break-words text-left font-medium hover:underline"
                title={page.path}
                onClick={() => onOpenPage(page.path)}
              >
                {pathParts(page.path).name}
              </button>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {MODE_LABELS[page.mode]}
              </span>
            </div>
            <p className="mt-1 break-all pl-5 text-[11px] text-muted-foreground">{pathParts(page.path).directory}</p>
            <details className="mt-2 pl-5">
              <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
                写入前后快照
              </summary>
              <div className="mt-3 grid gap-3 xl:grid-cols-2">
                <div>
                  <p className="mb-1.5 text-muted-foreground">写入前</p>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 leading-relaxed">
                    {page.before ?? "原页面不存在"}
                  </pre>
                </div>
                <div>
                  <p className="mb-1.5 text-muted-foreground">写入后</p>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 leading-relaxed">
                    {page.after}
                  </pre>
                  <p className="mt-1 break-all text-[10px] text-muted-foreground">{page.revision}</p>
                </div>
              </div>
            </details>
          </div>
        ))}
      </div>
      {count === 0 && <p className="text-muted-foreground">尚未写入页面</p>}
    </section>
  )
}
