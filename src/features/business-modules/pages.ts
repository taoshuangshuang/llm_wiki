import { listDirectory, readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import { descendantIds, type BusinessModule, type ModuleCatalog } from "./catalog"
import { readPageModuleIds } from "./page-tags"

export interface ModulePage { path: string; title: string; type: string; moduleIds: string[] }
interface PageReader {
  list: (path: string) => Promise<FileNode[]>
  read: (path: string) => Promise<string>
}
const DEFAULT_READER: PageReader = {
  list: (path) => listDirectory(path, { maxDepth: 1 }),
  read: readFile,
}

/** 逐级扫描真实目录，避免侧栏懒加载状态或默认目录树深度影响页面覆盖。 */
export async function loadModulePages(
  projectPath: string, catalog: ModuleCatalog, reader: PageReader = DEFAULT_READER, signal?: AbortSignal,
): Promise<{ pages: ModulePage[]; unreadable: string[] }> {
  const root = `${normalizePath(projectPath).replace(/\/+$/, "")}/wiki`
  const directories = [root]
  const visited = new Set<string>()
  const pages: ModulePage[] = []
  const unreadable: string[] = []
  for (let index = 0; index < directories.length; index++) {
    signal?.throwIfAborted()
    const directory = directories[index]
    if (visited.has(directory)) continue
    if (visited.size >= 10000 || directory.slice(root.length).split("/").length > 65) {
      unreadable.push(directory)
      continue
    }
    visited.add(directory)
    let nodes: FileNode[]
    try { nodes = await reader.list(directory) }
    catch { unreadable.push(directory); continue }
    for (const node of nodes) {
      signal?.throwIfAborted()
      const path = normalizePath(node.path)
      if (!path.startsWith(`${root}/`)) continue
      if (node.is_dir) { directories.push(path); continue }
      if (!/\.md$/i.test(node.name) || [`${root}/index.md`, `${root}/log.md`].map((item) => item.toLowerCase()).includes(path.toLowerCase())) continue
      try {
        const content = await reader.read(path)
        const frontmatter = parseFrontmatter(content).frontmatter
        const title = frontmatter?.title
        const type = frontmatter?.type
        pages.push({
          path,
          title: typeof title === "string" && title.trim() ? title : node.name.replace(/\.md$/i, ""),
          type: typeof type === "string" && type.trim() ? type.trim() : "other",
          moduleIds: readPageModuleIds(content, catalog),
        })
      } catch { unreadable.push(path) }
    }
  }
  return { pages, unreadable }
}

/** 按子树或直接归属筛选并去重；按 schema 类型顺序排列，同类型按标题和路径排序。 */
export function pagesForModule(
  node: BusinessModule, pages: readonly ModulePage[], typeOrder: readonly string[] = [],
  scope: "subtree" | "direct" = "subtree",
): ModulePage[] {
  const ids = descendantIds(node)
  const matched = new Map<string, ModulePage>()
  for (const page of pages) {
    const matches = scope === "direct"
      ? page.moduleIds.includes(node.id) && !page.moduleIds.some((id) => id !== node.id && ids.has(id))
      : page.moduleIds.some((id) => ids.has(id))
    if (matches) matched.set(page.path, page)
  }
  const typeRanks = new Map(typeOrder.map((type, index) => [type, index]))
  return [...matched.values()].sort((a, b) =>
    (typeRanks.get(a.type) ?? typeOrder.length) - (typeRanks.get(b.type) ?? typeOrder.length)
    || a.title.localeCompare(b.title) || a.path.localeCompare(b.path),
  )
}
