/** 在知识流程中维护业务模块树，结构化表单与原始配置共享文件草稿。 */
import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, GitBranch, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  UNCLASSIFIED_ID, parseModuleCatalog, readModuleCatalogDraft, writeModuleCatalogDraft, type BusinessModuleConfig,
} from "@/features/business-modules/catalog"
import { loadModulePages, type ModulePage } from "@/features/business-modules/pages"
import { readCodeSourcesConfig, resolveCodeBinding } from "@/features/business-modules/code-sources"
import type { WorkflowFile } from "./workflow-catalog"
import { CODE_SOURCES_FILE, type WorkflowDocumentDraft } from "./workflow-documents"
import { WorkflowFileEditor } from "./workflow-file-editor"
import { ModuleCodeBindingEditor } from "./module-code-binding"

interface EditorProps {
  projectPath: string
  file: WorkflowFile
  value?: WorkflowDocumentDraft
  error?: string
  busy: boolean
  onChange: (content: string) => void
  onReload: () => void
  onSave: () => void
  source: {
    value?: WorkflowDocumentDraft; error?: string; onChange: (content: string) => void
    onReload: () => void; onSave: () => void
  }
}

interface ModuleEntry { node: BusinessModuleConfig; ancestors: BusinessModuleConfig[]; parent?: BusinessModuleConfig }
type Operation = "add-root" | "add-child" | "delete"

function flattenModules(nodes: BusinessModuleConfig[], ancestors: BusinessModuleConfig[] = []): ModuleEntry[] {
  return nodes.flatMap((node) => [
    { node, ancestors, parent: ancestors[ancestors.length - 1] },
    ...flattenModules(node.children ?? [], [...ancestors, node]),
  ])
}

function modulePath(entry: ModuleEntry | undefined): string {
  return entry ? [...entry.ancestors, entry.node].map((node) => node.name.trim() || node.id).join(" / ") : "顶级模块"
}

export function BusinessModuleEditor(props: EditorProps) {
  const { projectPath, value, error, busy, onChange, onReload, onSave, source } = props
  const [advanced, setAdvanced] = useState(false)
  const [selectedId, setSelectedId] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  const [operation, setOperation] = useState<Operation | null>(null)
  const [actionError, setActionError] = useState("")
  const content = value?.content ?? ""
  const parsed = useMemo(() => {
    try { return { entries: flattenModules(readModuleCatalogDraft(content)), error: "" } }
    catch (failure) { return { entries: [], error: String(failure) } }
  }, [content])
  const { entries } = parsed
  const sourceState = useMemo(() => {
    try { return { config: readCodeSourcesConfig(source.value?.content ?? ""), error: "" } }
    catch (failure) { return { config: undefined, error: String(failure) } }
  }, [source.value?.content])
  const moduleNames = new Map(entries.map(({ node }) => [node.id, node.name]))
  const selected = entries.find((entry) => entry.node.id === selectedId) ?? entries[0]
  const node = selected?.node
  const canEditChildren = node && node.id !== UNCLASSIFIED_ID
  const invalid = entries.find((entry) => !entry.node.name.trim() || !entry.node.description.trim())
  const search = query.trim().toLowerCase()
  const matches = new Set(entries.filter(({ node }) => node.id.includes(search) || node.name.toLowerCase().includes(search))
    .flatMap(({ node, ancestors }) => [node.id, ...ancestors.map((ancestor) => ancestor.id)]))
  const visible = entries.filter(({ node, ancestors }) => search ? matches.has(node.id)
    : ancestors.every((ancestor) => expanded.has(ancestor.id)))

  function select(entry: ModuleEntry | undefined) {
    setSelectedId(entry?.node.id ?? "")
    setOperation(null)
    setActionError("")
    if (entry) setExpanded((current) => new Set([...current, ...entry.ancestors.map(({ id }) => id)]))
  }

  function start(next: Operation) {
    setOperation(next)
    setActionError("")
  }

  function update(edit: (roots: BusinessModuleConfig[], items: ModuleEntry[]) => void): boolean {
    try {
      const roots = readModuleCatalogDraft(content)
      edit(roots, flattenModules(roots))
      const next = writeModuleCatalogDraft(content, roots)
      readModuleCatalogDraft(next)
      onChange(next)
      setActionError("")
      return true
    } catch (failure) {
      setActionError(String(failure))
      return false
    }
  }

  function editField(field: "name" | "description", text: string) {
    update((_, items) => { items.find((entry) => entry.node.id === node?.id)!.node[field] = text })
  }

  function add(draft: BusinessModuleConfig) {
    const parent = operation === "add-child" ? selected : undefined
    if (!update((roots, items) => {
      const parentNode = items.find((entry) => entry.node.id === parent?.node.id)?.node
      const siblings = parentNode ? (parentNode.children ??= []) : roots
      siblings.push(draft)
    })) return
    setQuery("")
    select({ node: draft, ancestors: parent ? [...parent.ancestors, parent.node] : [] })
  }

  function remove() {
    if (!node) return
    if (!update((roots, items) => {
      const entry = items.find((item) => item.node.id === node.id)!
      const siblings = entry.parent?.children ?? roots
      siblings.splice(siblings.indexOf(entry.node), 1)
    })) return
    select(entries.find((entry) => entry.node.id === selected.parent?.id))
  }

  if (!value || error) return <WorkflowFileEditor {...props} />
  if (advanced) return <div className="space-y-2">
    <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdvanced(false)}>返回模块编辑</Button>
    <WorkflowFileEditor {...props} />
  </div>
  return <section className="@container flex min-h-0 flex-1 flex-col gap-3" aria-label="业务模块字典设置">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">{value.source}</p>
      <div className="flex flex-wrap items-center gap-2">
        {content !== value.original && <span className="text-xs text-muted-foreground">未保存修改</span>}
        <Button size="sm" variant="ghost" className="text-xs" disabled={busy} onClick={() => { setAdvanced(true); setOperation(null); setActionError("") }}>
          高级 · 编辑原始配置
        </Button>
        <Button size="sm" className="text-xs" disabled={busy || !!parsed.error || !!invalid || !!operation || content === value.original}
          onClick={onSave}>保存字典</Button>
        <Button size="sm" variant="outline" className="text-xs"
          disabled={busy || !source.value || !!source.error || !!sourceState.error || source.value.content === source.value.original}
          onClick={source.onSave}>保存源码绑定{source.value && source.value.content !== source.value.original ? " · 未保存" : ""}</Button>
      </div>
    </header>
    {parsed.error ? <div className="space-y-2">
      <p role="alert" className="text-sm text-destructive">无法显示模块树。{parsed.error} 请在原始配置中修正。</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={onReload}>重新读取</Button>
    </div> : <>
      {invalid && <p role="status" className="text-xs text-destructive">模块 {invalid.node.id} 的名称和分类说明需要填写完整。</p>}
      <div className="grid min-h-0 flex-1 gap-4 @min-[560px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] @min-[560px]:grid-rows-[minmax(0,1fr)] @min-[560px]:gap-8">
        <div className="flex min-h-0 min-w-0 flex-col gap-1.5">
          <Input type="search" aria-label="搜索模块" placeholder="搜索名称或模块 ID" className="h-7 shrink-0 text-xs md:text-xs" value={query} onChange={(event) => setQuery(event.target.value)} />
          <nav aria-label="模块树" className="max-h-64 min-h-0 flex-1 overflow-y-auto @min-[560px]:max-h-none">
            {visible.map((entry) => {
              const { node: item, ancestors } = entry
              const open = !!search || expanded.has(item.id)
              const active = node?.id === item.id && operation !== "add-root"
              const binding = sourceState.config && resolveCodeBinding(sourceState.config, item.id, ancestors.map(({ id }) => id))
              return <div key={item.id} className={`flex items-center rounded hover:bg-accent ${active ? "bg-accent" : ""}`} style={{ paddingLeft: Math.min(ancestors.length, 6) * 10 }}>
                {item.children?.length ? <button type="button" aria-label={open ? "收起 " + item.name : "展开 " + item.name}
                  aria-expanded={open} disabled={!!search}
                  onClick={() => setExpanded((current) => {
                    const next = new Set(current)
                    if (!next.delete(item.id)) next.add(item.id)
                    return next
                  })}
                  className="grid size-6 shrink-0 place-items-center rounded">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                  : <span aria-hidden="true" className="w-6 shrink-0" />}
                <button type="button" aria-pressed={active} title={item.name.trim() || item.id}
                  disabled={busy} className="flex min-w-0 flex-1 items-center gap-1 rounded py-1 pr-2 text-left text-xs"
                  onClick={() => select(entry)}><span className="truncate">{item.name.trim() || item.id}</span>
                  {binding?.repository && <span className="shrink-0 text-muted-foreground" aria-label="已关联源码仓库"
                    title={binding.repository + (binding.repositorySource === item.id ? " · 直接绑定" : " · 继承自 " + moduleNames.get(binding.repositorySource ?? ""))}>
                    <GitBranch size={12} aria-hidden="true" />
                  </span>}</button>
              </div>
            })}
            {!visible.length && <p className="p-2 text-xs text-muted-foreground">{search ? "没有匹配的模块。" : "尚未配置模块。"}</p>}
          </nav>
          <div role="group" aria-label="模块操作" className="flex shrink-0 flex-wrap gap-1">
            <Button size="sm" variant="ghost" className="text-xs" disabled={busy} onClick={() => start("add-root")}><Plus className="size-4" />新增顶级模块</Button>
            <Button size="sm" variant="ghost" className="text-xs" disabled={busy || !canEditChildren} onClick={() => start("add-child")}>新增子模块</Button>
            <Button size="sm" variant="ghost" className="text-xs text-destructive" disabled={busy || !canEditChildren || !!invalid}
              onClick={() => start("delete")}>删除模块</Button>
          </div>
        </div>
        <div className="min-w-0 space-y-3 text-xs [&_button]:text-xs @min-[560px]:overflow-y-auto @min-[560px]:pr-1">
          {actionError && <p role="alert" className="text-destructive">{actionError}</p>}
          {operation === "add-root" || operation === "add-child" ? <NewModuleForm key={operation + (selected?.node.id ?? "")}
            parentPath={modulePath(operation === "add-child" ? selected : undefined)} onAdd={add} onCancel={() => select(selected)} />
            : operation === "delete" && selected ? <DeleteModulePreview key={selected.node.id} entry={selected}
              content={content} projectPath={projectPath} onDelete={remove} onCancel={() => select(selected)} />
            : selected ? <>
              <p className="break-words text-xs text-muted-foreground">{modulePath(selected)}</p>
              <p className="break-all text-xs text-muted-foreground">模块 ID　<code>{selected.node.id}</code></p>
              <ModuleFields node={selected.node} disabled={busy} onChange={editField} />
              {!source.value || source.error ? <div className="space-y-1">
                <p className="text-muted-foreground">{source.error ? "源码绑定读取失败：" + source.error : "正在读取源码绑定…"}</p>
                {source.error && <Button size="sm" variant="outline" onClick={source.onReload}>重新读取源码绑定</Button>}
              </div> : sourceState.config ? <ModuleCodeBindingEditor key={selected.node.id} config={sourceState.config}
                moduleId={selected.node.id} ancestors={selected.ancestors.map(({ id }) => id)} moduleNames={moduleNames} busy={busy}
                onChange={(config) => source.onChange(JSON.stringify(config, null, 2) + "\n")} />
                : <div className="space-y-2"><p role="alert" className="text-destructive">{sourceState.error}</p>
                  <WorkflowFileEditor file={CODE_SOURCES_FILE} value={source.value} busy={busy} onChange={source.onChange}
                    onReload={source.onReload} onSave={source.onSave} />
                </div>}
            </> : <p className="text-muted-foreground">新增顶级模块后，即可设置分类名称和说明。</p>}
        </div>
      </div>
    </>}
  </section>
}

function ModuleFields({ node, disabled, onChange }: {
  node: Pick<BusinessModuleConfig, "name" | "description">; disabled?: boolean
  onChange: (field: "name" | "description", value: string) => void
}) {
  return <div className="grid gap-3">
    <label className="grid gap-1">模块名称
      <Input aria-label="模块名称" className="text-xs md:text-xs" value={node.name} disabled={disabled} onChange={(event) => onChange("name", event.target.value)} />
    </label>
    <label className="grid gap-1">分类说明
      <textarea aria-label="分类说明" rows={4} value={node.description} disabled={disabled}
        className="w-full resize-y rounded-md border bg-background p-2"
        onChange={(event) => onChange("description", event.target.value)} />
    </label>
  </div>
}

function NewModuleForm({ parentPath, onAdd, onCancel }: {
  parentPath: string; onAdd: (node: BusinessModuleConfig) => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState({ id: "", name: "", description: "" })
  return <section className="space-y-3" aria-label="新增模块表单">
    <p className="break-words">新增模块 · {parentPath}</p>
    <label className="grid gap-1">模块 ID
      <Input aria-label="模块 ID" className="text-xs md:text-xs" value={draft.id} placeholder="例如 query-sql"
        onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
      <span className="text-xs text-muted-foreground">以小写字母开头，可包含小写字母、数字、连字符或下划线。</span>
    </label>
    <ModuleFields node={draft} onChange={(field, text) => setDraft({ ...draft, [field]: text })} />
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={!draft.id.trim() || !draft.name.trim() || !draft.description.trim()}
        onClick={() => onAdd({ id: draft.id.trim(), name: draft.name.trim(), description: draft.description.trim() })}>添加到草稿</Button>
      <Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
    </div>
  </section>
}

/** 按页面实际标签预览整棵待删除子树的影响；扫描不完整时保留删除前状态。 */
function DeleteModulePreview({ entry, content, projectPath, onDelete, onCancel }: {
  entry: ModuleEntry; content: string; projectPath: string; onDelete: () => void; onCancel: () => void
}) {
  const ids = useMemo(() => new Set(flattenModules([entry.node]).map(({ node }) => node.id)), [entry.node])
  const [result, setResult] = useState<{ content: string; pages: ModulePage[]; error?: string }>()
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const catalog = parseModuleCatalog(content)
        if (!catalog) throw new Error("字典未配置。")
        const { pages, unreadable } = await loadModulePages(projectPath, catalog, undefined, controller.signal)
        if (controller.signal.aborted) return
        const matches = pages.filter((page) => page.taggedModuleIds.some((id) => ids.has(id)))
        setResult({ content, pages: matches, error: unreadable.length ? "有 " + unreadable.length + " 个位置无法读取，页面影响未核实完整。" : undefined })
      } catch (failure) {
        if (!controller.signal.aborted) setResult({ content, pages: [], error: String(failure) })
      }
    })()
    return () => controller.abort()
  }, [content, ids, projectPath])
  const preview = result?.content === content ? result : undefined
  return <section className="space-y-3" aria-label="删除模块影响">
    <p className="break-words font-medium">删除 {modulePath(entry)}{ids.size > 1 ? "（含 " + (ids.size - 1) + " 个子模块）" : ""}</p>
    {!preview ? <p role="status" className="text-muted-foreground">正在检查页面引用…</p> : <>
      <p>受影响页面 {preview.pages.length} 篇</p>
      {!!preview.pages.length && <ul className="max-h-44 list-disc space-y-1 overflow-y-auto pl-4 text-xs">
        {preview.pages.map((page) => <li key={page.path} className="break-all">{page.title}
          <span className="block text-muted-foreground">{page.path.startsWith(projectPath + "/") ? page.path.slice(projectPath.length + 1) : page.path}</span></li>)}
      </ul>}
      {preview.error && <p role="alert" className="text-xs text-destructive">{preview.error} 可取消后重新检查。</p>}
      <p className="text-xs text-muted-foreground">删除后，这些标签会失效。页面仍按其他有效标签归类，或显示为未分类。</p>
    </>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="destructive" disabled={!preview || !!preview.error} onClick={onDelete}>确认删除</Button>
      <Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
    </div>
  </section>
}
