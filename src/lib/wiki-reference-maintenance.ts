/** 入库后的确定性引用维护：复用关系索引，只修改有明确目标映射的引用。 */
import { invoke } from "@tauri-apps/api/core"
import { compareAndWriteFile, readFile } from "@/commands/fs"
import { parseFrontmatterArray, writeFrontmatterArray } from "./sources-merge"
import { parseFrontmatter } from "./frontmatter"
import { mapWikiBodyText, normalizeWikiFileLinks } from "./ingest-sanitize"
import { commitIngestPage, contentRevision } from "./ingest-run"
import type { RetrievalRelation } from "./evidence-retrieval"
import type { PageCheckIssue, ReviewMaterial } from "./review-checks/types"
import { normalizeHeadingAnchor, splitWikilinkTarget } from "./wikilink-anchor"

interface ReferencePage { path: string; names: string[] }
export interface ReferenceContext { pages: ReferencePage[]; affectedPaths: string[]; relations: RetrievalRelation[] }

/** 关系索引独立于向量索引；目标不存在时仍可按原始引用查找来源页。 */
export function referenceContext(projectPath: string, paths: string[], targets: string[] = []): Promise<ReferenceContext> {
  return invoke("wiki_reference_context", { projectPath, paths, targets })
}

const canonical = (target: string) => target.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^wiki\//, "").replace(/\.md$/i, "")
const stem = (path: string) => canonical(path).split("/").pop()!
const safePath = (path: string) => /^wiki\/.+\.md$/.test(path) && !/[\\:\x00-\x1f]/.test(path) && path.split("/").every((part) => part && !part.startsWith("."))

/** 唯一名称才可解析；重名不猜测，也不通过语义相似度替换引用。 */
function resolver(pages: ReferencePage[]) {
  return (target: string, from: string): string | undefined => {
    if (!target.trim()) return from
    const key = canonical(target)
    const exact = pages.find((page) => canonical(page.path) === key)
    if (exact) return exact.path
    const matches = pages.filter((page) => stem(page.path) === key || page.names.includes(target.trim()))
    return matches.length === 1 ? matches[0].path : undefined
  }
}

/** 章节支持原始标题和常见 Markdown 锚点，比较忽略大小写、空白与全半角差异；代码示例中的标题不算章节。 */
export function hasWikiSection(content: string, anchor: string): boolean {
  let decoded = anchor
  try { decoded = decodeURIComponent(anchor) } catch { /* 非法编码按原文比较。 */ }
  const headings = new Set<string>()
  let visible = ""
  mapWikiBodyText(content, (segment) => { visible += segment; return segment }, true)
  const titles = [
    ...[...visible.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm)].map((match) => match[1]),
    ...[...visible.matchAll(/^([^\n]+)\r?\n {0,3}(?:=+|-+)[ \t]*$/gm)].map((match) => match[1]),
  ]
  const counts = new Map<string, number>()
  for (const heading of titles) {
    const title = heading.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_~`]/g, "").trim()
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")
    const count = counts.get(slug) ?? 0
    counts.set(slug, count + 1)
    headings.add(normalizeHeadingAnchor(title))
    headings.add(normalizeHeadingAnchor(count ? `${slug}-${count}` : slug))
  }
  if (decoded.startsWith("^")) return visible.split("\n").some((line) => line.trimEnd().endsWith(` ${decoded}`) || line.trim() === decoded)
  const key = normalizeHeadingAnchor(decoded)
  return !!key && headings.has(key)
}

/** 未知目标保留原文；正文和 related 使用同一套引用提取约定。 */
export function wikiReferences(content: string): string[] {
  const related = parseFrontmatter(content).frontmatter?.related
  // 历史 related 可能包含完整 wikilink；格式仍由格式检查报告，查找目标时只消费页面标识。
  const references = (Array.isArray(related) ? related : parseFrontmatterArray(content, "related")).map((value) => {
    const wrapped = value.trim().match(/^\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]$/)
    return (wrapped?.[1] ?? value).trim()
  }).filter(Boolean)
  mapWikiBodyText(content, (segment) => {
    for (const match of segment.matchAll(/(?<!!)\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)) references.push(match[1].trim())
    return segment
  })
  return [...new Set(references)]
}

/** 调用方持有项目提交锁；目标先落盘，引用方提交使用版本比较和入库恢复记录。 */
export async function maintainWikiReferences(
  projectPath: string, writtenPaths: string[], redirects: ReadonlyMap<string, string>, runId?: string,
  onChanged?: (path: string) => void,
): Promise<string[]> {
  const context = await referenceContext(projectPath, writtenPaths, [...redirects.keys()])
  const paths = context.pages.map((page) => page.path)
  const resolve = resolver(context.pages)
  const mapping = new Map<string, string>()
  for (const [from, initial] of redirects) {
    if (context.pages.some((page) => canonical(page.path) === canonical(from) || !canonical(from).includes("/") && stem(page.path) === canonical(from))) continue // A 仍存在（包括重名路径），其原有引用保持不变。
    let target = initial
    const seen = new Set([canonical(from)])
    while (!paths.includes(target) && (redirects.has(target) || redirects.has(canonical(target)) || redirects.has(stem(target)))) {
      if (seen.has(canonical(target))) throw new Error("引用重定向存在循环")
      seen.add(canonical(target))
      target = redirects.get(target) ?? redirects.get(canonical(target)) ?? redirects.get(stem(target))!
    }
    if (!safePath(target) || !paths.includes(target)) throw new Error(`引用重定向目标不存在：${target}`)
    mapping.set(canonical(from), target)
  }
  const titles = new Map<string, string>()
  for (const page of context.pages) for (const name of page.names) if (resolve(name, "") === page.path) titles.set(name, page.path)
  const targetContents = new Map<string, string>()
  for (const target of new Set(mapping.values())) targetContents.set(target, await readFile(`${projectPath}/${target}`))
  const changed: string[] = []
  try {
    for (const path of new Set([...writtenPaths, ...context.affectedPaths])) {
      if (!safePath(path)) continue
      const before = await readFile(`${projectPath}/${path}`)
      const indexedRevision = context.relations.find((edge) => edge.fromPath === path)?.fromRevision
      if (indexedRevision && indexedRevision !== await contentRevision(before)) throw new Error(`引用来源已变化，请刷新后重试：${path}`)
      const rewrite = (raw: string): string => {
        const hash = raw.indexOf("#")
        const name = hash < 0 ? raw : raw.slice(0, hash)
        const target = mapping.get(canonical(name))
        if (!target) return raw
        const anchor = hash < 0 ? "" : raw.slice(hash + 1)
        return `${paths.filter((path) => stem(path) === stem(target)).length === 1 ? stem(target) : canonical(target)}${anchor && hasWikiSection(targetContents.get(target)!, anchor) ? `#${anchor}` : ""}`
      }
      let after = mapWikiBodyText(before, (segment) => segment.replace(
        /(?<!!)\[\[([^\]\n|]+)(\|[^\]\n]*)?\]\]/g,
        (match, target: string, alias = "") => {
          const replacement = rewrite(target.trim())
          return replacement === target.trim() ? match : `[[${replacement}${alias}]]`
        },
      ))
      const related = parseFrontmatterArray(after, "related")
      const updated = [...new Set(related.map(rewrite))]
      if (JSON.stringify(related) !== JSON.stringify(updated)) after = writeFrontmatterArray(after, "related", updated)
      if (writtenPaths.includes(path)) after = normalizeWikiFileLinks(after, paths, titles)
      if (before === after) continue
      // 写入前再次核对目标，不能依据已被并发替换的章节执行降级。
      for (const [target, content] of targetContents) if (await readFile(`${projectPath}/${target}`) !== content) throw new Error(`引用目标已变化：${target}`)
      if (runId) await commitIngestPage(projectPath, runId, path, before, after, `maintenance-links-${(await contentRevision(after)).slice(7)}`, "maintenance")
      else await compareAndWriteFile(projectPath, path, before, after)
      if (targetContents.has(path)) targetContents.set(path, after)
      changed.push(path); onChanged?.(path)
    }
  } finally {
    if (changed.length) await referenceContext(projectPath, changed)
  }
  return changed
}

/** 格式阶段仅报告缺页或重名，不能生成占位页或请求模型补写；页面存在但章节缺失时视为整页链接，不计失效。 */
export async function inspectWikiReferences(projectPath: string, pages: ReviewMaterial[]): Promise<PageCheckIssue[]> {
  if (!pages.length) return []
  const context = await referenceContext(projectPath, pages.map((page) => page.path))
  const resolve = resolver(context.pages)
  const issues: PageCheckIssue[] = []
  const reported = new Set<string>()
  for (const page of pages) for (const reference of wikiReferences(page.text)) {
    const { page: name, anchor } = splitWikilinkTarget(reference)
    if (!name && anchor) continue // 当前页锚点按现状处理。
    const target = resolve(reference, page.path) ?? resolve(name, page.path)
    if (target) continue
    const key = `${page.path}\0${name}`
    if (reported.has(key)) continue
    reported.add(key)
    issues.push({ kind: "structure", manual: true, description: `失效引用 [[${name}]]：目标页面不存在或名称不唯一`, sourceEvidence: "", pageEvidence: name, pages: [page.path] })
  }
  return issues
}
