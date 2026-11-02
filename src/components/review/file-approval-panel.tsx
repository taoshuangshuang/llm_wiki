import { useCallback, useEffect, useMemo, useState } from "react"
import { ShieldCheck, Star } from "lucide-react"
import { useTranslation } from "react-i18next"
import { getFileApprovals, proposalMoveTarget, reviewFileChange, setImportantFile, type FileApprovalState, type FileChangeProposal } from "@/commands/file-approval"
import { readFile } from "@/commands/fs"
import { buildWordDiff } from "@/lib/selection-edit"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { useWikiStore } from "@/stores/wiki-store"

const CHANGED_EVENT = "file-approvals-changed"

/** 在项目切换和卸载时丢弃旧请求；审核区定期刷新以接收后端 Agent 草稿。 */
function useFileApprovals(poll = false) {
  const projectPath = useWikiStore((state) => state.project?.path)
  const dataVersion = useWikiStore((state) => state.dataVersion)
  const [snapshot, setSnapshot] = useState<{ path: string; state: FileApprovalState } | null>(null)
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    let running = false
    const load = async () => {
      if (running) return
      running = true
      try {
        const state = await getFileApprovals(projectPath)
        if (!cancelled) { setSnapshot({ path: projectPath, state }); setError("") }
      } catch (err) {
        if (!cancelled) { setSnapshot(null); setError(String(err)) }
      } finally { running = false }
    }
    void load()
    const timer = poll ? window.setInterval(() => void load(), 3000) : undefined
    window.addEventListener(CHANGED_EVENT, reload)
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
      window.removeEventListener(CHANGED_EVENT, reload)
    }
  }, [dataVersion, poll, projectPath, reload, revision])

  return { projectPath, state: snapshot && snapshot.path === projectPath ? snapshot.state : null, error, reload }
}

/** 文件工具栏上的重要标记；标记独立于 Markdown，模型不能通过改 frontmatter 解锁。 */
export function ImportantFileButton({ filePath }: { filePath: string }) {
  const { t } = useTranslation()
  const { projectPath, state, error } = useFileApprovals()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState("")
  const root = projectPath ? `${normalizePath(projectPath).replace(/\/+$/, "")}/` : ""
  const path = normalizePath(filePath)
  if (!root || !path.startsWith(root)) return null
  const relative = path.slice(root.length)
  const important = state?.importantPaths.includes(relative) ?? false
  return <span className="relative inline-flex">
    <button type="button" aria-pressed={important} disabled={!state || busy}
      title={t(important ? "fileApproval.importantHint" : "fileApproval.markHint")}
      className={`inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-xs shadow-sm hover:bg-accent disabled:opacity-50 ${important ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
      onClick={async () => {
        setBusy(true); setActionError("")
        try {
          await setImportantFile(projectPath!, filePath, !important)
          window.dispatchEvent(new Event(CHANGED_EVENT))
        } catch (err) { setActionError(String(err)) }
        finally { setBusy(false) }
      }}>
      <Star className={`h-3.5 w-3.5 ${important ? "fill-current" : ""}`} />
      {t(important ? "fileApproval.important" : "fileApproval.mark")}
    </button>
    {(error || actionError) && <span role="alert" className="absolute right-0 top-full mt-1 w-72 rounded border bg-background p-2 text-xs text-destructive">{actionError || error}</span>}
  </span>
}

/** 独立审核队列，普通 Review 的批量解决和模型自动清理不能批准这些请求。 */
export function FileApprovalPanel() {
  const { t } = useTranslation()
  const { projectPath, state, error, reload } = useFileApprovals(true)
  const [working, setWorking] = useState("")
  const [actionError, setActionError] = useState("")
  const [showHistory, setShowHistory] = useState(false)
  const pending = state?.proposals.filter((item) => item.status === "pending") ?? []
  const visible = showHistory ? [...(state?.proposals ?? [])].reverse() : pending

  const review = async (item: FileChangeProposal, approve: boolean) => {
    if (!projectPath || working) return
    setWorking(item.id); setActionError("")
    try {
      await reviewFileChange(projectPath, item.id, approve)
      window.dispatchEvent(new Event(CHANGED_EVENT))
      if (approve && useWikiStore.getState().project?.path === projectPath) {
        const path = `${normalizePath(projectPath).replace(/\/+$/, "")}/${item.path}`
        const current = useWikiStore.getState()
        if (current.selectedFile === path) {
          const moveTo = proposalMoveTarget(item)
          if (moveTo) {
            const destination = `${normalizePath(projectPath).replace(/\/+$/, "")}/${moveTo}`
            const content = await readFile(destination)
            if (useWikiStore.getState().project?.path === projectPath && useWikiStore.getState().selectedFile === path) {
              useWikiStore.getState().openFileInPreview(destination, content)
            }
          } else if (item.proposed === null) current.closePreview()
          else {
            const content = await readFile(path)
            if (useWikiStore.getState().project?.path === projectPath && useWikiStore.getState().selectedFile === path) {
              useWikiStore.getState().setFileContent(content)
            }
          }
        }
        await refreshProjectFileTree(projectPath, { bumpDataVersion: true })
      }
    } catch (err) {
      setActionError(String(err).includes("FILE_APPROVAL_CONFLICT") ? t("fileApproval.conflict") : String(err))
    } finally { setWorking("") }
  }

  if (!projectPath) return null
  return <section className="max-h-[55%] shrink-0 overflow-auto border-b border-border" aria-label={t("fileApproval.title")}>
    <div className="flex items-center gap-2 px-4 py-3">
      <ShieldCheck className="h-4 w-4 text-amber-600" />
      <h2 className="flex-1 text-sm font-semibold">{t("fileApproval.title")} ({pending.length})</h2>
      <button type="button" onClick={() => setShowHistory((value) => !value)} className="rounded border px-2 py-1 text-xs hover:bg-accent">{t(showHistory ? "fileApproval.pending" : "fileApproval.history")}</button>
      <button type="button" onClick={reload} className="rounded border px-2 py-1 text-xs hover:bg-accent">{t("fileApproval.refresh")}</button>
    </div>
    <p className="px-4 pb-3 text-xs text-muted-foreground">{t("fileApproval.hint")}</p>
    {(error || actionError) && <p role="alert" className="px-4 pb-3 text-xs text-destructive">{actionError || error}</p>}
    {!state && !error && <p className="px-4 pb-3 text-xs text-muted-foreground">{t("fileApproval.loading")}</p>}
    {state && visible.length === 0 && <p className="px-4 pb-3 text-xs text-muted-foreground">{t("fileApproval.empty")}</p>}
    {visible.map((item) => <ProposalCard key={item.id} item={item} disabled={Boolean(working)} onReview={review} />)}
  </section>
}

function ProposalCard({ item, disabled, onReview }: {
  item: FileChangeProposal
  disabled: boolean
  onReview: (item: FileChangeProposal, approve: boolean) => Promise<void>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const moveTo = proposalMoveTarget(item)
  const diff = useMemo(() => expanded ? buildWordDiff(item.original, moveTo ? item.original : item.proposed ?? "") : [], [expanded, item.original, item.proposed, moveTo])
  return <article className="mx-4 mb-3 rounded-md border p-3 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="min-w-0 flex-1 break-all text-left font-medium hover:underline">{item.path} · {moveTo ? t("fileApproval.move", { path: moveTo }) : t(item.proposed === null ? "fileApproval.delete" : "fileApproval.modify")}</button>
      <span className="text-muted-foreground">{t(`fileApproval.${item.status}`)}</span>
    </div>
    <div className="mt-1 text-muted-foreground">{item.source} · {new Date(item.createdAt).toLocaleString()}</div>
    {expanded && <>
      <p className="mt-3 text-muted-foreground">{t(moveTo ? "fileApproval.moveHint" : "fileApproval.diffHint")}</p>
      <pre className="my-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-3 font-mono leading-5">{diff.map((part, index) => <span key={index} className={part.type === "delete" ? "bg-red-500/15 text-red-700 line-through dark:text-red-300" : part.type === "insert" ? "bg-green-500/15 text-green-700 dark:text-green-300" : ""}>{part.value}</span>)}</pre>
      {item.status === "pending" && <div className="flex justify-end gap-2">
        <button type="button" disabled={disabled} onClick={() => void onReview(item, false)} className="rounded border px-3 py-1.5 hover:bg-accent disabled:opacity-50">{t("fileApproval.reject")}</button>
        <button type="button" disabled={disabled} onClick={() => void onReview(item, true)} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50">{t("fileApproval.approve")}</button>
      </div>}
    </>}
  </article>
}
