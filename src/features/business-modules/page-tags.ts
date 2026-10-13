import { parseFrontmatter } from "@/lib/frontmatter"
import { writeFrontmatterArray } from "@/lib/sources-merge"
import { MODULE_PREFIX, normalizeModuleIds, type ModuleCatalog } from "./catalog"

/** 读取主题及业务标签，兼容既有页面中的字符串或数组形式。 */
export function pageTags(content: string): string[] {
  const tags = parseFrontmatter(content).frontmatter?.tags
  return (Array.isArray(tags) ? tags : typeof tags === "string" ? [tags] : [])
    .map((tag) => tag.trim()).filter(Boolean)
}

/** 保留主题标签，只替换业务标签；使用现有写入器保留其他字段和正文。 */
export function replaceModuleTags(content: string, ids: readonly string[], catalog: ModuleCatalog): string {
  const tags = [...new Set([
    ...pageTags(content).filter((tag) => !tag.startsWith(MODULE_PREFIX)),
    ...normalizeModuleIds(ids, catalog).map((id) => `${MODULE_PREFIX}${id}`),
  ])]
  // 规范化历史字符串/缩进形式，避免既有数组写入器产生重复 tags 键。
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/)
  if (!match) return `---\ntags: ${JSON.stringify(tags)}\n---\n${content}`
  const newline = match[1].endsWith("\r\n") ? "\r\n" : "\n"
  const lines = match[2].split(/\r?\n/)
  const metadata: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^(?:tags|"tags"|'tags')\s*:/.test(line)) { skipping = true; continue }
    if (skipping && !/^(?!-\s)[^\s#][^:]*:/.test(line)) continue
    skipping = false
    metadata.push(line)
  }
  const withoutTags = `${match[1]}${metadata.join(newline)}${match[3]}${content.slice(match[0].length)}`
  return writeFrontmatterArray(withoutTags, "tags", tags)
}

/** 视图读取时也归一化分类；未标注或标签失效的旧页面进入未分类。 */
export function readPageModuleIds(content: string, catalog: ModuleCatalog): string[] {
  return normalizeModuleIds(
    pageTags(content).filter((tag) => tag.startsWith(MODULE_PREFIX)).map((tag) => tag.slice(MODULE_PREFIX.length)),
    catalog,
  )
}
