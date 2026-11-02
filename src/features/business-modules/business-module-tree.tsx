import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { loadProjectSchema } from "@/lib/project-schema"
import { getWikiTypeStyle, FALLBACK_TYPE_STYLE } from "@/lib/wiki-type-style"
import { wikiTypeLabel } from "@/lib/wiki-page-types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { parseWikiSchemaRouting } from "@/lib/wiki-schema"
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
  const [typeOrder, setTypeOrder] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [warning, setWarning] = useState("")

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setCatalog(null)
    setPages([])
    setTypeOrder([])
    setWarning("")
    if (!project) { setLoading(false); return }
    setLoading(true)
    void (async () => {
      try {
        const [schema, modules] = await Promise.all([
          loadProjectSchema(project.path, "analysis"),
          loadProjectSchema(project.path, "classification"),
        ])
        const next = parseModuleCatalog(modules)
        if (!active) return
        setCatalog(next)
        setTypeOrder(Object.keys(parseWikiSchemaRouting(schema).typeDirs))
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

  useEffect(() => { setExpanded(new Set()) }, [project?.path])

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
    const nodePages = pagesForModule(node, pages, typeOrder, "direct")
    const isExpanded = expanded.has(node.id)
    return (
      <div key={node.id}>
        <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
          <button type="button" title={node.description} onClick={() => toggle(node.id)}
            aria-label={node.name} aria-expanded={isExpanded}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-accent">
            {isExpanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
            <span className="truncate">{node.name}</span>
            <span className="ml-auto pr-2 text-muted-foreground">{count}</span>
          </button>
        </div>
        {isExpanded && (
          <>
            {node.children.map((child) => renderNode(child, depth + 1))}
            <div style={{ paddingLeft: (depth + 1) * 12 }}>
              {!count && <p className="p-2 text-xs text-muted-foreground">{t("sidebar.moduleEmpty")}</p>}
              {nodePages.map((page) => {
                const style = getWikiTypeStyle(page.type)
                const TypeIcon = style.icon
                const label = t(`sidebar.typeLabels.${page.type}`, {
                  defaultValue: style === FALLBACK_TYPE_STYLE ? wikiTypeLabel(page.type) : style.label,
                })
                return (
                  <button key={page.path} type="button" title={`${label} · ${page.path}`} onClick={() => openPathInPreview(page.path)}
                    className={`flex w-full items-center gap-px rounded p-2 text-left text-xs hover:bg-accent ${selectedFile === page.path ? "bg-accent" : ""}`}>
                    <TypeIcon size={14} aria-hidden="true" className={`shrink-0 ${style.iconClass}`} />
                    <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] leading-none ${style.chipClass}`}>{label}</span>
                    <span className="min-w-0 truncate">{page.title}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        {loading && <p className="p-2 text-xs text-muted-foreground">{t("sidebar.moduleLoading")}</p>}
        {warning && <p role="alert" className="mb-2 break-words p-2 text-xs text-destructive">{warning}</p>}
        {!loading && !catalog && <p className="p-2 text-xs text-muted-foreground">{t("sidebar.moduleSetup")}</p>}
        {catalog?.roots.map((node) => renderNode(node, 0))}
      </div>
    </ScrollArea>
  )
}
