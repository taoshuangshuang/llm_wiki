import { readFile, listDirectory } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import {
  computeStructuralLint,
  type StructuralLintFinding,
  type StructuralLintPage,
} from "@/lib/lint-structural-core"
import type { LintConfig } from "@/lib/lint-config"
import { reviewIdFor, type ReviewItem } from "@/stores/review-store"

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "structure" | "semantic"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
  brokenTarget?: string
  suggestedTarget?: string
  suggestedSource?: string
  reviewItem?: ReviewItem
}

const SUGGESTION_TOKEN_WINDOW = 4000

// ── helpers ───────────────────────────────────────────────────────────────────

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function relativeToSlug(relativePath: string): string {
  // relativePath relative to wiki/ dir, e.g. "entities/foo-bar" or "queries/my-page-2024-01-01"
  return relativePath.replace(/\.md$/, "")
}

function extractTitle(content: string, fallbackPath: string): string {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontmatter) {
    const title = frontmatter[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (title?.[1]?.trim()) return title[1].trim()
  }
  const heading = content.match(/^#\s+(.+)$/m)
  if (heading?.[1]?.trim()) return heading[1].trim()
  return getFileName(fallbackPath)
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
}

function tokenizeForSuggestion(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.normalize("NFKC").toLowerCase()
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]
    if (token.length >= 2) tokens.add(token)
    if (/[\u3400-\u9fff]/u.test(token)) {
      for (const char of Array.from(token)) tokens.add(char)
    }
  }
  return tokens
}

// ── Structural lint ───────────────────────────────────────────────────────────

export interface StructuralLintOptions {
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
  config?: LintConfig
}

function runStructuralWorker(
  pages: StructuralLintPage[],
  options: StructuralLintOptions,
): Promise<StructuralLintFinding[]> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(computeStructuralLint(pages, options.onProgress, options.config))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./lint-structural.worker.ts", import.meta.url), { type: "module" })
    const abort = () => {
      worker.terminate()
      reject(new DOMException("Structural lint cancelled", "AbortError"))
    }
    if (options.signal?.aborted) {
      abort()
      return
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    worker.onerror = (event) => {
      options.signal?.removeEventListener("abort", abort)
      worker.terminate()
      reject(new Error(event.message || "Structural lint worker failed"))
    }
    worker.onmessage = (event: MessageEvent<{
      type: "progress" | "done"
      completed?: number
      total?: number
      findings?: StructuralLintFinding[]
    }>) => {
      if (event.data.type === "progress") {
        options.onProgress?.(event.data.completed ?? 0, event.data.total ?? pages.length)
        return
      }
      options.signal?.removeEventListener("abort", abort)
      worker.terminate()
      resolve(event.data.findings ?? [])
    }
    worker.postMessage({ pages, config: options.config ?? {} })
  })
}

export async function runStructuralLint(
  projectPath: string,
  options: StructuralLintOptions = {},
): Promise<LintResult[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const wikiFiles = flattenMdFiles(tree)
  // Exclude index.md and log.md from orphan checks
  const contentFiles = wikiFiles.filter(
    (f) => f.name !== "index.md" && f.name !== "log.md"
  )

  const pages: StructuralLintPage[] = []

  for (let index = 0; index < contentFiles.length; index += 1) {
    if (options.signal?.aborted) throw new DOMException("Structural lint cancelled", "AbortError")
    const f = contentFiles[index]
    try {
      const content = await readFile(f.path)
      const shortName = getRelativePath(f.path, wikiRoot)
      const slug = relativeToSlug(shortName)
      const title = extractTitle(content, shortName)
      const outlinks = extractWikilinks(content)
      const slugName = getFileName(slug)
      const tokens = Array.from(tokenizeForSuggestion(`${title}\n${slugName}\n${content.slice(0, SUGGESTION_TOKEN_WINDOW)}`))
      pages.push({ shortName, slug, title, outlinks, tokens })
    } catch {
      // skip unreadable files
    }
    options.onProgress?.(index + 1, contentFiles.length * 2)
  }
  return runStructuralWorker(pages, {
    ...options,
    onProgress: (completed, total) => options.onProgress?.(contentFiles.length + completed, contentFiles.length + total),
  })
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

/** 本地结构发现（孤儿页/无出链）统一落为审阅项，处理动作收敛到审阅视图。 */
export async function projectLintFindingsToReview(
  projectPath: string,
  findings: LintResult[],
): Promise<LintResult[]> {
  const { useReviewStore } = await import("@/stores/review-store")
  const { saveReviewItems } = await import("./persist")
  const local = findings.filter((item) => item.type === "orphan" || item.type === "no-outlinks")
  if (local.length === 0) return findings
  const reviewItems: ReviewItem[] = local.map((item) => {
    const base = {
      type: "suggestion" as const,
      logicalId: `lint:${item.type}:${item.page}`,
      evidenceVersion: "v1",
      title: item.type === "orphan" ? `孤儿页：${item.page}` : `页面无出链：${item.page}`,
      description: item.suggestedSource
        ? `${item.detail}（建议从 ${item.suggestedSource} 链入）`
        : item.suggestedTarget
          ? `${item.detail}（建议链向 ${item.suggestedTarget}）`
          : item.detail,
      affectedPages: [`wiki/${item.page}`],
      options: [
        { label: "在编辑器中打开", action: `open:${item.page}` },
        { label: "跳过", action: "Skip" },
      ],
    }
    return { ...base, id: reviewIdFor(base), resolved: false, createdAt: Date.now() }
  })
  await saveReviewItems(projectPath, reviewItems)
  const store = useReviewStore.getState()
  store.addItems(reviewItems)
  const items = store.items
  const resolvedIds = new Set(items.filter((item) => item.resolved || item.hidden || item.dismissed).map((item) => item.id))
  // 已人工解决的发现不再回到检查列表；审阅项由归并逻辑保留解决状态。
  return findings.filter((item) => !local.includes(item) ||
    !resolvedIds.has(reviewIdFor(reviewItems[local.indexOf(item)]!)))
}

/** 公共审阅事项投影为 Wiki 检查卡片，原始证据及人工状态随卡片保留。 */
export function reviewItemsToLint(items: ReviewItem[]): LintResult[] {
  return items.map((item) => ({
    type: item.type === "structure" ? item.subtype === "失效引用" ? "broken-link" : "structure" : "semantic",
    severity: item.type === "suggestion" ? "info" : "warning",
    page: (item.affectedPages?.[0] ?? "").replace(/^wiki\//, ""), detail: `[${item.type}] ${item.title}\n${item.description}`,
    affectedPages: item.affectedPages?.map((path) => path.replace(/^wiki\//, "")), reviewItem: item }))
}

/** 兼容数组调用方；未完成通过带已有结果的异常表达，不能返回空数组冒充通过。 */
export class SemanticLintIncompleteError extends Error {
  constructor(message: string, readonly results: LintResult[]) { super(message) }
}

export async function runSemanticLint(projectPath: string, llmConfig: LlmConfig, signal?: AbortSignal): Promise<LintResult[]> {
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({ type: "lint", title: "Wiki review", status: "running", detail: "Checking wiki modules...", filesWritten: [] })
  try {
    const { runWikiReview } = await import("./wiki-review")
    const report = await runWikiReview(normalizePath(projectPath), llmConfig, signal,
      (progress) => activity.updateItem(activityId, { detail: progress.detail }))
    signal?.throwIfAborted()
    const results = reviewItemsToLint(report.items)
    if (report.status !== "complete") throw new SemanticLintIncompleteError(report.reasons.join("；") || "Wiki 检查未完成", results)
    activity.updateItem(activityId, { status: "done", detail: `Found ${results.length} issue(s).` })
    return results
  } catch (error) {
    activity.updateItem(activityId, { status: "error", detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
