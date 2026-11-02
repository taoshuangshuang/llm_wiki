import { useTranslation } from "react-i18next"
import { SearchView } from "@/components/search/search-view"
import { useWikiStore } from "@/stores/wiki-store"
import { PreviewPanel } from "./preview-panel"

/** 统一知识浏览、检索与预览；预览搜索结果时保留检索条件和结果。 */
export function KnowledgeWorkspace() {
  const { t } = useTranslation()
  const activeView = useWikiStore((state) => state.activeView)
  const setActiveView = useWikiStore((state) => state.setActiveView)
  const searching = activeView === "search"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2" role="tablist" aria-label={t("nav.browseSearch")}>
        <button type="button" role="tab" aria-selected={!searching} aria-controls="knowledge-preview" id="knowledge-preview-tab" onClick={() => setActiveView("wiki")} className={`rounded-md px-3 py-1 text-sm ${!searching ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"}`}>
          {t("nav.wiki")}
        </button>
        <button type="button" role="tab" aria-selected={searching} aria-controls="knowledge-search" id="knowledge-search-tab" onClick={() => setActiveView("search")} className={`rounded-md px-3 py-1 text-sm ${searching ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"}`}>
          {t("nav.search")}
        </button>
      </div>
      <div id="knowledge-search" role="tabpanel" aria-labelledby="knowledge-search-tab" className={searching ? "min-h-0 flex-1" : "hidden"}>
        <SearchView />
      </div>
      {!searching && (
        <div id="knowledge-preview" role="tabpanel" aria-labelledby="knowledge-preview-tab" className="min-h-0 flex-1">
          <PreviewPanel />
        </div>
      )}
    </div>
  )
}
