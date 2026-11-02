import { useState, type ReactNode } from "react"
import type { IngestRun } from "@/lib/ingest-run"
import { Button } from "@/components/ui/button"
import { IMPORT_ROW_GRID } from "./import-process-run-row"

/** 父行只聚合真实子块状态；折叠状态属于组件，轮询不会覆盖人工选择。 */
export function ImportProcessDocumentRow({ runs, status, pendingCount, children, onContinue, onCancel, onArchive, onExport, busy }: {
  runs: IngestRun[]
  status: string
  pendingCount: number
  children: ReactNode
  onContinue: () => void
  onCancel: () => void
  onArchive: () => void
  onExport: () => void
  busy: boolean
}) {
  const [open, setOpen] = useState(() => status !== "completed")
  const first = runs[0]
  const pages = new Set(runs.flatMap((run) => Object.keys(run.pages)))
  const complete = runs.filter((run) => run.reviewStatus === "complete").length
  const failures = runs.filter((run) => ["partial", "failed", "cancelled", "recovery-required"].includes(run.writeStatus) || ["partial", "incomplete", "cancelled"].includes(run.reviewStatus)).length
  const current = runs.find((run) => run.writeStatus === "running" || run.reviewStatus === "running")
  const total = first.chunk?.total ?? runs.length
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="border-b last:border-b-0">
    <summary className="cursor-pointer px-5 py-4">
      <div className={IMPORT_ROW_GRID}>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={first.sourceIdentity}>{first.sourceIdentity.split("/").pop()}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{first.sourceIdentity}</p>
          <p className="mt-1 text-xs text-muted-foreground">{new Date(first.createdAt).toLocaleString()} · {total} 个子块 · 完成 {complete}/{total}{failures ? ` · ${failures} 个未完成` : ""}</p>
        </div>
        <span className="text-xs">{pages.size} 页（去重）</span>
        <span className="text-xs">{current ? `子块 ${current.chunk?.index} ${current.writeStatus === "running" ? "写入中" : "审阅中"}` : status === "writeFailed" ? "写入失败" : status === "completed" ? "已完成" : "需审阅"}</span>
        <span className="text-xs">{pendingCount} 项待处理</span>
      </div>
    </summary>
    <div className="flex flex-wrap gap-2 border-t px-5 py-3">
      <Button size="sm" variant="outline" disabled={busy} onClick={onExport}>导出来源日志</Button>
      {status !== "completed" && status !== "active" && <Button size="sm" variant="outline" disabled={busy} onClick={onContinue}>继续未完成工作</Button>}
      {status === "active" && <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消后续执行</Button>}
      <Button size="sm" variant="ghost" disabled={busy || status === "active"} onClick={onArchive}>归档来源</Button>
    </div>
    {/* 已完成来源默认折叠，展开前不挂载全部子块与其快照。 */}
    {open && <div className="ml-5 border-l">{children}</div>}
  </details>
}
