/** 问题筛选复用页面业务标签；跨模块问题按问题身份展示，不展开成多条。 */
import type { LintItem } from "@/stores/lint-store"
import { descendantIds, UNCLASSIFIED_ID, type ModuleCatalog } from "@/features/business-modules/catalog"
import type { ModulePage } from "@/features/business-modules/pages"
import { normalizePath } from "./path-utils"

export interface LintFilters { type: string; moduleId: string; query: string }

/** 页面路径统一为 wiki 内相对路径，兼容审阅结果携带的 wiki/ 前缀。 */
export function lintPageKey(path: string): string {
  return normalizePath(path).replace(/^wiki\//, "").replace(/\.md$/i, "")
}

export function lintModuleIndex(projectPath: string, pages: readonly ModulePage[]): Map<string, string[]> {
  const root = `${normalizePath(projectPath)}/wiki/`
  return new Map(pages.map((page) => [lintPageKey(page.path.slice(root.length)), page.moduleIds]))
}

export function filterLintItems(
  items: readonly LintItem[], filters: LintFilters, catalog: ModuleCatalog | null, modules: ReadonlyMap<string, string[]>,
): LintItem[] {
  const node = catalog?.byId.get(filters.moduleId)
  const ids = node ? descendantIds(node) : new Set([filters.moduleId])
  const query = filters.query.trim().toLocaleLowerCase()
  return items.filter((item) => {
    if (filters.type && item.type !== filters.type) return false
    const pages = [...new Set([item.page, ...(item.affectedPages ?? []), ...(item.reviewItem?.affectedPages ?? [])])]
    if (filters.moduleId && !pages.some((page) =>
      (modules.get(lintPageKey(page)) ?? [UNCLASSIFIED_ID]).some((id) => ids.has(id)))) return false
    return !query || [item.detail, ...pages].some((value) => value.toLocaleLowerCase().includes(query))
  })
}
