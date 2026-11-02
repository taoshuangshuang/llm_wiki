/** 入库审核与 Wiki 检查共同使用的独立召回，不依赖入库记录。 */
import { retrieveEvidence, type RetrievalRequest, type RetrievalResult } from "../evidence-retrieval"
import { parseFrontmatter, extractPageTitle } from "../frontmatter"
import type { ReviewMaterial, ReviewCheckLog } from "./types"

/** 优先使用本文概括，其次页首介绍或首个章节，保留完整段落。 */
export function reviewPageIntroduction(content: string): string {
  const { body } = parseFrontmatter(content)
  const lines = body.replace(/\r\n/g, "\n").split("\n")
  const headings: { index: number; level: number; name: string }[] = []
  let fence = ""
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = ""; continue }
    if (fence) continue
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (heading) headings.push({ index, level: heading[1].length, name: heading[2] })
  }
  const overview = headings.find((heading) => /本文概括|本文概述|内容概括/.test(heading.name))
  const inline = lines.findIndex((line) => /^\s*(?:>\s*)?(?:\*\*)?本文(?:概括|概述)(?:\*\*)?\s*[:：]/.test(line))
  if (overview || inline >= 0) {
    const start = overview?.index ?? inline
    const next = headings.find((heading) => heading.index > start && (!overview || heading.level <= overview.level))
    return lines.slice(start, next?.index ?? lines.length).join("\n").trim()
  }
  const first = headings.find((heading) => heading.level > 1)
  const leading = lines.slice(0, first?.index ?? lines.length).filter((line) => !/^#\s/.test(line)).join("\n").trim()
  if (leading) return leading
  if (!first) return ""
  const next = headings.find((heading) => heading.index > first.index && heading.level <= first.level)
  return lines.slice(first.index, next?.index ?? lines.length).join("\n").trim()
}

export interface PrepareReviewOptions {
  projectPath: string
  targets: (ReviewMaterial & { queryText?: string })[]
  scope?: RetrievalRequest["scope"]
  budget?: RetrievalRequest["budget"]
  checkpoint?: RetrievalRequest["checkpoint"]
  signal?: AbortSignal
  processLog?: ReviewCheckLog
}

/** 每次召回最多 32 个目标；一个模块仍是一项任务，目标分组只用于检索预算。 */
export async function prepareReviewMaterials(options: PrepareReviewOptions): Promise<RetrievalResult> {
  options.signal?.throwIfAborted()
  if (!options.targets.length || options.targets.length > 32) throw new Error("单次相关知识召回需要 1～32 个目标页面")
  const result = await retrieveEvidence({
    projectPath: options.projectPath, scene: "review",
    targets: options.targets.map((page) => ({ id: page.id, path: page.path, title: extractPageTitle(page.text), text: page.queryText ?? (reviewPageIntroduction(page.text) || extractPageTitle(page.text) || page.path) })),
    scope: { ...(options.scope ?? { corpus: "wiki" }), excludePaths: [...new Set([...(options.scope?.excludePaths ?? []), ...options.targets.map((page) => page.path)])] }, budget: options.budget, checkpoint: options.checkpoint,
  }, options.processLog)
  options.signal?.throwIfAborted()
  return result
}
