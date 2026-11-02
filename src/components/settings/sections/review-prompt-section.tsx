/** 提示词迁移面板：展示原文和新协议，用户审核后才保存业务规则。 */
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import type { IngestPrompts } from "@/lib/ingest-prompts"
import { previewReviewPromptMigration, type ReviewPromptMigration } from "@/lib/review-prompt-migration"

export function ReviewPromptSection({ onSelectDraft }: { onSelectDraft: (content: string, key?: keyof IngestPrompts) => void }) {
  const project = useWikiStore((state) => state.project)
  const [preview, setPreview] = useState<ReviewPromptMigration>()
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => { setPreview(undefined); setMessage(""); setBusy(false) }, [project?.path])
  if (!project) return null
  return <section className="mt-4 space-y-3 rounded-lg border p-4 text-xs">
    <h3 className="text-sm font-medium">后台审阅提示词迁移</h3>
    <p className="text-muted-foreground">预览旧规则后，将迁移建议填入本节点上方的「统一后台审阅」草稿；核对后通过同一编辑器保存。旧模板保留，保存记录人工修改历史。</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => { setBusy(true); previewReviewPromptMigration(project.path).then((value) => { if (useWikiStore.getState().project?.path !== project.path) return; setPreview(value); setMessage("") }).catch((error) => { if (useWikiStore.getState().project?.path === project.path) setMessage(String(error)) }).finally(() => { if (useWikiStore.getState().project?.path === project.path) setBusy(false) }) }}>预览迁移</Button>
    {preview && <div className="space-y-3">
      {preview.needsManualReview && <p className="text-amber-600">检测到旧自定义模板。请将需要保留的业务约束迁入下面的新规则，移除旧占位符和输出格式要求。</p>}
      <details><summary className="cursor-pointer">查看旧模板原文</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{preview.original}</pre></details>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{preview.proposed}</pre>
      {preview.changes.map((change) => <details key={change.key} className="rounded border p-2">
        <summary className="cursor-pointer">{change.name} · 当前规则与新默认规则的差异</summary>
        <p className="mt-2 text-amber-600">请保留所需自定义约束，核对后在对应节点保存。</p>
        <div className="grid gap-3 lg:grid-cols-2">
          <div>当前规则<pre className="max-h-72 overflow-auto whitespace-pre-wrap">{change.current}</pre></div>
          <div>新默认规则<pre className="max-h-72 overflow-auto whitespace-pre-wrap">{change.proposed}</pre></div>
        </div>
        <Button size="sm" variant="outline" onClick={() => { onSelectDraft(change.proposed, change.key); setMessage(`${change.name} 已填入对应节点草稿，尚未保存；请合入需要保留的自定义规则。`) }}>填入对应节点草稿</Button>
      </details>)}
      <Button size="sm" disabled={busy} onClick={() => { onSelectDraft(preview.proposed); setMessage("迁移建议已填入上方统一后台审阅草稿，尚未保存。"); setPreview(undefined) }}>填入统一审阅规则草稿</Button>
    </div>}
    {message && <p role="status" className="break-all">{message}</p>}
  </section>
}
