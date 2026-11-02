/** 文件设置卡片：用途与路径各展示一次，折叠仅隐藏编辑区，不丢失草稿。 */
import { useRef, useState } from "react"
import { ChevronRight, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { WorkflowFile } from "./workflow-catalog"
import { PROMPT_VARIABLES, VARIABLE_DESCRIPTIONS, workflowFilePath, type WorkflowDocumentDraft } from "./workflow-documents"

export function WorkflowFileEditor({ file, value, error, busy, onChange, onSave, onReload }: {
  file: WorkflowFile; value?: WorkflowDocumentDraft; error?: string; busy: boolean
  onChange: (content: string) => void; onSave: () => void; onReload: () => void
}) {
  const [expanded, setExpanded] = useState(!file.prompt)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const contract = file.prompt ? PROMPT_VARIABLES[file.prompt] : undefined
  const dirty = Boolean(value && value.content !== value.original)
  const editorName = file.prompt ? "提示词" : "配置"
  const inherited = value && value.source !== value.path && !value.source.includes("内置默认值") && value.source !== "尚未创建"

  function insertVariable(key: string) {
    if (!value) return
    const field = textarea.current
    const start = field?.selectionStart ?? value.content.length
    const end = field?.selectionEnd ?? start
    const token = `{{${key}}}`
    onChange(value.content.slice(0, start) + token + value.content.slice(end))
    requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(start + token.length, start + token.length) })
  }

  return <section className="rounded-lg border bg-background p-4" aria-label={`${file.title}设置`}>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h4 className="flex items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4 text-muted-foreground" />{file.title}</h4>
      <code className="break-all text-xs text-muted-foreground">{workflowFilePath(file)}</code>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{file.description ?? "调整此节点使用的规则，保存后按上方说明生效。"}</p>
    <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
      {dirty && <span className="rounded bg-amber-500/10 px-2 py-1 text-amber-600">未保存修改</span>}
      {value?.source.includes("内置默认值") && <span className="rounded bg-muted px-2 py-1 text-muted-foreground">当前使用内置默认值</span>}
      {inherited && <details className="text-muted-foreground"><summary className="cursor-pointer">查看配置继承来源</summary><p className="mt-1 break-all">{value.source}</p></details>}
    </div>
    {error ? <div className="mt-3 space-y-2"><p role="alert" className="text-xs text-destructive">读取失败：{error}</p><Button size="sm" variant="outline" disabled={busy} onClick={onReload}>重新读取</Button></div> : null}
    {value ? <details className="group mt-3 border-t pt-3" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium [&::-webkit-details-marker]:hidden" aria-label={`${expanded ? "收起" : "展开"}${file.title}`}>
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />{expanded ? "收起" : "展开"}{editorName}
      </summary>
      <div className="mt-3">
        {contract?.available.length ? <details className="mb-3 rounded border bg-muted/20 p-3 text-xs"><summary className="cursor-pointer">本模板可用变量（点击插入；必填变量需保留）</summary>
          <div className="mt-2 space-y-2">{contract.available.map((key) => <div key={key}><button type="button" disabled={busy} className="mr-2 rounded border bg-background px-2 py-1 font-mono hover:bg-accent" onClick={() => insertVariable(key)}>{`{{${key}}}`}{contract.required.includes(key) && " *"}</button><span className="text-muted-foreground">{VARIABLE_DESCRIPTIONS[key]}</span></div>)}</div>
        </details> : null}
        <textarea ref={textarea} aria-label={file.title} spellCheck={false} disabled={busy}
          className="min-h-80 w-full resize-y rounded-md border bg-background p-3 font-mono text-xs leading-6 outline-none focus:ring-2 focus:ring-primary/30"
          value={value.content} onChange={(event) => onChange(event.target.value)} />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={onReload}>重新读取（替换草稿）</Button>
            {value.defaultContent !== undefined && <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange(value.defaultContent!)}>恢复默认值到草稿</Button>}</div>
          <Button size="sm" disabled={busy || (value.expected !== null && !dirty)} onClick={onSave}>保存当前文件</Button>
        </div>
      </div>
    </details> : !error && <p className="mt-3 text-sm text-muted-foreground">正在读取配置…</p>}
  </section>
}
