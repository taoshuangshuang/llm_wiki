/** 检查任务的只读恢复与原子快照；不保存模型配置，不在恢复时发起检查。 */
import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import type { LintItem } from "@/stores/lint-store"
import { DEFAULT_LINT_RUN, type LintRunState } from "@/stores/lint-run-store"
import { loadLintItems, loadReviewItems } from "./persist"
import { loadWikiReviewCheckpoints } from "./wiki-review-checkpoints"
import { loadWikiReviewBatches } from "./wiki-review"
import { contentRevision } from "./content-revision"
import { reviewItemsToLint } from "./lint"

export interface LintRunHistory { version: 1; run: LintRunState; items: LintItem[] }
const historyWrites = new Map<string, Promise<void>>()
const historyPath = (path: string) => `${path}/.llm-wiki/lint-run.json`

/** 旧快照可能把结构事项统一标为 semantic；按原始审阅类型恢复，不改变身份和处理状态。 */
function restoreItemTypes(items: LintItem[]): LintItem[] {
  return items.map((item) => item.reviewItem ? { ...item, ...reviewItemsToLint([item.reviewItem])[0] } : item)
}

export async function saveLintRunHistory(path: string, run: LintRunState, items: LintItem[]): Promise<void> {
  const content = JSON.stringify({ version: 1, run, items } satisfies LintRunHistory)
  const write = (historyWrites.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await createDirectory(`${path}/.llm-wiki`)
    await writeFileAtomic(historyPath(path), content)
  })
  historyWrites.set(path, write)
  try { await write } finally { if (historyWrites.get(path) === write) historyWrites.delete(path) }
}

/** 新版直接恢复任务快照；旧版从模块检查点重建完成数及待继续状态。 */
export async function loadLintRunHistory(path: string): Promise<LintRunHistory | null> {
  if (await fileExists(historyPath(path))) {
    const history = JSON.parse(await readFile(historyPath(path))) as LintRunHistory
    const run = history?.run
    if (history?.version !== 1 || !run || !Array.isArray(history.items)
      || !["structural", "semantic"].includes(run.phase)
      || [run.running, run.paused, run.pausing, run.runSemantic, run.hasRun].some((value) => typeof value !== "boolean")
      || (run.progress && (!Number.isInteger(run.progress.completed) || !Number.isInteger(run.progress.total)
        || run.progress.completed < 0 || run.progress.total < run.progress.completed))) {
      throw new Error("检查任务历史格式无效，未恢复进度")
    }
    return { ...history, items: restoreItemTypes(history.items), run: { ...run, running: false, pausing: false, paused: run.running || run.pausing || run.paused, hasRun: run.hasRun || run.running || run.pausing || run.paused } }
  }
  const saved = restoreItemTypes(await loadLintItems(path))
  const checkpoints = await loadWikiReviewCheckpoints(path)
  if (!Object.keys(checkpoints.modules).length) {
    return saved.length ? { version: 1, run: { ...DEFAULT_LINT_RUN, hasRun: true }, items: saved } : null
  }
  const loaded = await loadWikiReviewBatches(path)
  const batches = await Promise.all(loaded.batches.map(async (batch) => ({ ...batch,
    checkpoint: checkpoints.modules[await contentRevision(JSON.stringify({ moduleId: batch.moduleId, paths: batch.pages.map((page) => page.path) }))],
  })))
  const completed = batches.filter((batch) => batch.checkpoint?.status === "complete").length
  const current = batches.find((batch) => batch.checkpoint?.status !== "complete")
  const reviews = new Map((await loadReviewItems(path)).map((item) => [item.id, item]))
  const findings = new Map(batches.flatMap((batch) => batch.checkpoint?.items ?? []).map((item) => [item.id, reviews.get(item.id) ?? item]))
  const semantic = reviewItemsToLint([...findings.values()].filter((item) => !item.resolved && !item.hidden && !item.dismissed))
  return { version: 1, run: { ...DEFAULT_LINT_RUN, hasRun: true, runSemantic: true, phase: "semantic",
    progress: { completed, total: batches.length }, paused: Boolean(current),
    detail: current ? `待继续检查：${current.name}` : null, error: loaded.errors.join("；") || null,
  }, items: [...saved.filter((item) => !item.reviewItem && item.type !== "semantic" && item.type !== "structure"), ...semantic.map((item, index) => ({ ...item, id: `restored-semantic-${index}`, createdAt: Date.now() }))] }
}
