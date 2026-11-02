/** 入库后审阅：对照原文与实际落盘页面，保存结构和覆盖待审阅项。 */
import { createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import { checkCoverage } from "./review-checks/coverage"
import { inspectStructure } from "./review-checks/format"
import { isReviewContentPath } from "./review-checks/types"
import { sourceSummarySlugFromIdentity } from "@/lib/source-identity"
import type { IngestPrompts } from "@/lib/ingest-prompts"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ReviewItem } from "@/stores/review-store"
import type { FileNode } from "@/types/wiki"
import { acceptanceFailureReviews } from "@/lib/ingest-acceptance-reviews"
import { withProjectLock } from "@/lib/project-mutex"
import { assertIngestSnapshotsUnchanged } from "@/lib/ingest-write-guard"

export type { PageCheckIssue as AcceptanceIssue } from "./review-checks/types"
import type { PageCheckIssue as AcceptanceIssue } from "./review-checks/types"
export { inspectStructure } from "./review-checks/format"

interface AcceptanceRound {
  summaries: string[]
  issues: AcceptanceIssue[]
}

export interface AcceptanceReport {
  sourceIdentity: string
  status: "clear" | "pending-review" | "passed" | "failed"
  rounds: AcceptanceRound[]
  error?: string
  updatedAt: number
}

type AcceptanceReview = Omit<ReviewItem, "id" | "resolved" | "createdAt">

export interface AcceptanceOptions {
  projectPath: string
  sourceIdentity: string
  sourcePath: string
  sourceContent: string
  schema: string
  purpose: string
  writtenPaths: string[]
  llmConfig: LlmConfig
  prompts: IngestPrompts
  signal?: AbortSignal
  onProgress?: (detail: string) => void
  /** 提交后固定的实际落盘内容；审阅模型在锁外运行，避免混入后续任务的修改。 */
  pageSnapshot?: { pages: Record<string, string>; knownPagePaths: string[] }
  /** 统一审阅的来源范围断点；始终对照全部实际页面，跨批承载的内容不会误判遗漏。 */
  coverageChecks?: Record<string, { summary: string; issues: AcceptanceIssue[] }>
  onCoverageSegment?: (id: string, result: { summary: string; issues: AcceptanceIssue[] }) => Promise<void>
  onCoverageStart?: () => void
  /** 合并前独有贡献与来源同时核对，避免另设覆盖前后互查。 */
  beforePages?: Record<string, string>
}

export interface AcceptanceResult {
  report: AcceptanceReport
  reviews: AcceptanceReview[]
}

/** 每次审阅读取真实落盘页，不以模型自报的写入结果作为证据。 */
async function inspect(options: AcceptanceOptions, round: AcceptanceRound, includeFormat = true): Promise<void> {
  const pages: Record<string, string> = {}
  const { issues, summaries } = round
  for (const path of new Set(options.writtenPaths.filter(isReviewContentPath))) {
    pages[path] = options.pageSnapshot?.pages[path] ?? await readFile(`${options.projectPath}/${path}`)
    if (includeFormat) issues.push(...inspectStructure(path, pages[path], options.schema))
  }
  if (!Object.keys(pages).length) {
    throw new Error("没有可审阅的知识页面")
  }
  // 提供项目的真实文件清单，避免把未参与本次写入的已有链接目标误判成断链。
  const knownPagePaths: string[] = []
  const collectPaths = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.is_dir) collectPaths(node.children ?? [])
      else if (node.path.endsWith(".md")) knownPagePaths.push(node.path.slice(options.projectPath.length + 1))
    }
  }
  if (options.pageSnapshot) knownPagePaths.push(...options.pageSnapshot.knownPagePaths)
  else collectPaths(await listDirectory(`${options.projectPath}/wiki`))
  const result = await checkCoverage({
    sourceIdentity: options.sourceIdentity, sourcePath: options.sourcePath, sourceContent: options.sourceContent,
    pages, beforePages: options.beforePages, knownPagePaths, schema: options.schema, purpose: options.purpose,
    prompt: options.prompts.acceptance, llmConfig: options.llmConfig, signal: options.signal,
    readPage: (path) => readFile(`${options.projectPath}/${path}`), onProgress: options.onProgress,
    coverageChecks: options.coverageChecks, onCoverageStart: options.onCoverageStart, onCoverageSegment: options.onCoverageSegment,
  })
  issues.push(...result.issues)
  summaries.push(...result.summaries)
  options.signal?.throwIfAborted()
  if (result.status !== "complete") throw new Error(result.reason ?? "内容覆盖检查未完成")
}

/** 统一后台审阅复用的内部检查；不写旧验收目录，也不直接发布全局事项。 */
export async function inspectIngestContent(options: AcceptanceOptions): Promise<AcceptanceReport> {
  const report: AcceptanceReport = { sourceIdentity: options.sourceIdentity, status: "pending-review", rounds: [], updatedAt: Date.now() }
  const round: AcceptanceRound = { summaries: [], issues: [] }
  report.rounds.push(round)
  try {
    await inspect(options, round, false)
    report.status = round.issues.length ? "pending-review" : "clear"
  } catch (error) {
    options.signal?.throwIfAborted()
    report.error = error instanceof Error ? error.message : String(error)
  }
  return report
}

/** 只收集待审阅项；问题或模型错误不改变已经完成的文件写入。 */
export async function runIngestAcceptance(options: AcceptanceOptions): Promise<AcceptanceResult> {
  const report: AcceptanceReport = {
    sourceIdentity: options.sourceIdentity, status: "pending-review", rounds: [], updatedAt: Date.now(),
  }
  try {
    const round: AcceptanceRound = { summaries: [], issues: [] }
    report.rounds.push(round)
    await inspect(options, round)
    report.status = round.issues.length ? "pending-review" : "clear"
  } catch (error) {
    if (options.signal?.aborted) throw error
    report.error = error instanceof Error ? error.message : String(error)
  }
  const directory = `${options.projectPath}/.llm-wiki/acceptance`
  try {
    await withProjectLock(options.projectPath, async () => {
      options.signal?.throwIfAborted()
      if (options.pageSnapshot) {
        try {
          await assertIngestSnapshotsUnchanged(options.projectPath,
            new Map(Object.entries(options.pageSnapshot.pages).filter(([path]) => isReviewContentPath(path))))
        } catch (error) {
          report.status = "pending-review"
          report.error = `审阅期间页面已变化，本次结果需重新核对：${error instanceof Error ? error.message : String(error)}`
        }
      }
      await createDirectory(directory)
      await writeFile(`${directory}/${sourceSummarySlugFromIdentity(options.sourceIdentity)}.json`, JSON.stringify(report, null, 2))
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    // 报告写入失败也保留已发现的问题，交由 review.json 统一持久化。
    report.status = "pending-review"
    report.error = [report.error, `审阅报告保存失败：${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("；")
  }
  return { report, reviews: acceptanceFailureReviews(options.sourcePath, report) }
}
