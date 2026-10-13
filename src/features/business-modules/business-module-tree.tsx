import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, FileText } from "lucide-react"
import { useTranslation } from "react-i18next"
import { readFile } from "@/commands/fs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { parseModuleCatalog, type BusinessModule, type ModuleCatalog } from "./catalog"
import { loadModulePages, pagesForModule, type ModulePage } from "./pages"

/** 独立业务模块视角，复用项目变更通知及既有页面预览能力。 */
export function BusinessModuleTree() {
  const { t } = useTranslation()
  const project = useWikiStore((state) => state.project)
  const dataVersion = useWikiStore((state) => state.dataVersion)
  const openPathInPreview = useWikiStore((state) => state.openPathInPreview)
  const selectedFile = useWikiStore((state) => state.selectedFile)
  const [catalog, setCatalog] = useState<ModuleCatalog | null>(null)
  const [pages, setPages] = useState<ModulePage[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [warning, setWarning] = useState("")

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setCatalog(null)
    setPages([])
    setWarning("")
    if (!project) { setLoading(false); return }
    setLoading(true)
    void (async () => {
      try {
        const schema = await readFile(`${project.path.replace(/\/+$/, "")}/schema.md`)
        const next = parseModuleCatalog(schema)
        if (!active) return
        setCatalog(next)
        if (!next) return
        const result = await loadModulePages(project.path, next, undefined, controller.signal)
        if (!active) return
        setPages(result.pages)
        if (result.unreadable.length) setWarning(t("sidebar.moduleUnreadable", { count: result.unreadable.length }))
      } catch (error) {
        if (active) setWarning(error instanceof Error ? error.message : String(error))
      } finally { if (active) setLoading(false) }
    })()
    return () => { active = false; controller.abort() }
  }, [project?.path, dataVersion, t])

  useEffect(() => { setSelected(null); setExpanded(new Set()) }, [project?.path])

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderNode(node: BusinessModule, depth: number) {
    const count = pagesForModule(node, pages).length
    return (
      <div key={node.id}>
        <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
          <button type="button" className="h-7 w-6 shrink-0" onClick={() => toggle(node.id)}
            aria-label={node.name} aria-expanded={expanded.has(node.id)} disabled={!node.children.length}>
            {node.children.length > 0 && (expanded.has(node.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          </button>
          <button type="button" title={node.description} onClick={() => setSelected(node.id)}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-accent ${selected === node.id ? "bg-accent" : ""}`}>
            <span className="truncate">{node.name}</span>
            <span className="ml-auto pr-2 text-muted-foreground">{count}</span>
          </button>
        </div>
        {expanded.has(node.id) && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  const selectedNode = selected ? catalog?.byId.get(selected) : undefined
  const selectedPages = selectedNode ? pagesForModule(selectedNode, pages) : []
  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        {loading && <p className="p-2 text-xs text-muted-foreground">{t("sidebar.moduleLoading")}</p>}
        {warning && <p role="alert" className="mb-2 break-words p-2 text-xs text-destructive">{warning}</p>}
        {!loading && !catalog && <p className="p-2 text-xs text-muted-foreground">{t("sidebar.moduleSetup")}</p>}
        {catalog?.roots.map((node) => renderNode(node, 0))}
        {selectedNode && (
          <div className="mt-3 border-t pt-2">
            <p className="px-2 text-xs text-muted-foreground">{selectedNode.description}</p>
            {!selectedPages.length && <p className="p-2 text-xs text-muted-foreground">{t("sidebar.moduleEmpty")}</p>}
            {selectedPages.map((page) => (
              <button key={page.path} type="button" title={page.path} onClick={() => openPathInPreview(page.path)}
                className={`flex w-full items-center gap-2 rounded p-2 text-left text-xs hover:bg-accent ${selectedFile === page.path ? "bg-accent" : ""}`}>
                <FileText size={14} className="shrink-0" /><span className="truncate">{page.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
