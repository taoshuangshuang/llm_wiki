/** 检查任务由后台运行器持有，页面只订阅进度并发起启动或取消。 */
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { withProjectLock } from "./project-mutex"
import { DEFAULT_LINT_RUN, useLintRunStore } from "@/stores/lint-run-store"
import { runStructuralLint, reviewItemsToLint, projectLintFindingsToReview, type LintResult } from "./lint"
import { runWikiReview } from "./wiki-review"
import { hasUsableLlm } from "./has-usable-llm"
import { normalizePath } from "./path-utils"
import { refreshProjectFileTree } from "./project-file-tree-refresh"
import { saveLintItems } from "./persist"
import { loadLintRunHistory, saveLintRunHistory, type LintRunHistory } from "./lint-run-history"
import type { LintConfig } from "./lint-config"

type RunOptions = Parameters<typeof startLintRun>[0]
const pausedRuns = new Map<string, { options: RunOptions; results: LintResult[] }>()

const liveResults = new Map<string, LintResult[]>()
const restores = new Map<string, Promise<void>>()
const resetting = new Set<string>()

/** 只恢复显示；已运行的会话不被磁盘旧快照覆盖，切换项目不串数据。 */
export async function restoreLintRun(projectPath: string, options: { restoreItems?: boolean } = {}): Promise<void> {
  const path = normalizePath(projectPath)
  if (resetting.has(path)) return
  const active = () => normalizePath(useWikiStore.getState().project?.path ?? "") === path
  if (useLintRunStore.getState().runs[path]) {
    // 页面往返不覆盖用户刚处理的列表；项目重新打开时才补回该项目的数据。
    if (options.restoreItems && active()) {
      const run = useLintRunStore.getState().runs[path]
      if (run.running && liveResults.has(path)) useLintStore.getState().replaceResults(liveResults.get(path)!)
      else {
        const history = await loadLintRunHistory(path)
        if (history && active() && useLintRunStore.getState().runs[path] === run) {
          liveResults.set(path, history.items)
          useLintStore.getState().setItems(history.items)
        }
      }
    }
    return
  }
  if (restores.has(path)) return restores.get(path)
  const restoring = (async () => {
    try {
      const history = await loadLintRunHistory(path)
      if (!history || useLintRunStore.getState().runs[path]) return
      useLintRunStore.getState().update(path, history.run)
      liveResults.set(path, history.items)
      if (active()) useLintStore.getState().setItems(history.items)
    } catch (error) {
      if (!useLintRunStore.getState().runs[path]) useLintRunStore.getState().update(path, { hasRun: true, error: String(error) })
    }
  })()
  restores.set(path, restoring)
  try { await restoring } finally { if (restores.get(path) === restoring) restores.delete(path) }
}

const controllers = new Map<string, AbortController>()

/** 清除本项目检查进度和结果；保留页面、检查配置及人工审阅状态。 */
export async function resetLintRun(projectPath: string): Promise<void> {
  const path = normalizePath(projectPath)
  if (controllers.has(path)) throw new Error("请先暂停检查，等待进度保存完成后再重置")
  if (resetting.has(path)) throw new Error("正在重置检查进度")
  resetting.add(path)
  try {
    await restores.get(path)
    const run = { ...DEFAULT_LINT_RUN, runSemantic: useLintRunStore.getState().runs[path]?.runSemantic ?? false }
    await withProjectLock(path, async () => {
      await createDirectory(`${path}/.llm-wiki`)
      await writeFileAtomic(`${path}/.llm-wiki/wiki-review-checkpoints.json`, JSON.stringify({ version: 1, modules: {} }))
    })
    await saveLintItems(path, [])
    await saveLintRunHistory(path, run, [])
    pausedRuns.delete(path)
    liveResults.delete(path)
    useLintRunStore.getState().update(path, run)
    if (normalizePath(useWikiStore.getState().project?.path ?? "") === path) useLintStore.getState().setItems([])
  } finally {
    resetting.delete(path)
  }
}

/** 显式取消目标项目；卸载、切换视图均不调用此方法。 */
export function cancelLintRun(projectPath: string): void { controllers.get(normalizePath(projectPath))?.abort() }

/** 立即中断请求，待结果和检查点保存完成后允许继续。 */
export function pauseLintRun(projectPath: string): void {
  const path = normalizePath(projectPath)
  const controller = controllers.get(path)
  if (!controller || controller.signal.aborted) return
  useLintRunStore.getState().update(path, { pausing: true })
  controller.abort()
}

/** 会话内继续沿用本次配置；重启后使用当前配置，按检查点跳过完成批次。 */
export async function resumeLintRun(projectPath: string, fallbackOptions?: RunOptions): Promise<void> {
  const paused = pausedRuns.get(normalizePath(projectPath))
  if (paused) await executeLintRun(paused.options, paused.results)
  else if (fallbackOptions) await executeLintRun(fallbackOptions, liveResults.get(normalizePath(projectPath)) ?? [])
}

export async function startLintRun(options: {
  project: { path: string; id: string }; llmConfig: LlmConfig; config: LintConfig; runSemantic: boolean
  messages: { preparing: string; incomplete: string; needsModel: string }
}): Promise<void> {
  await executeLintRun(options)
}

async function executeLintRun(options: RunOptions, previousResults?: LintResult[]): Promise<void> {
  const path = normalizePath(options.project.path)
  if (controllers.has(path) || resetting.has(path)) return
  const controller = new AbortController()
  controllers.set(path, controller)
  const update = (patch: Parameters<ReturnType<typeof useLintRunStore.getState>["update"]>[1]) => {
    useLintRunStore.getState().update(path, patch)
    persistHistory()
  }
  const active = () => normalizePath(useWikiStore.getState().project?.path ?? "") === path
  let results: LintResult[] = previousResults ?? []
  pausedRuns.delete(path)
  let pendingHistory: LintRunHistory | undefined
  let writingHistory = false
  let historyWrite = Promise.resolve()
  // 连续进度事件合并为最新快照，单会话串行原子写入，避免旧进度覆盖新进度。
  const persistHistory = () => {
    pendingHistory = { version: 1, run: { ...useLintRunStore.getState().runs[path] },
      items: results.map((result, index) => ({ ...result, id: `lint-${index + 1}`, createdAt: Date.now() })) }
    if (writingHistory) return
    writingHistory = true
    historyWrite = (async () => {
      try {
        while (pendingHistory) {
          const snapshot = pendingHistory
          pendingHistory = undefined
          await saveLintRunHistory(path, snapshot.run, snapshot.items)
        }
      } finally { writingHistory = false }
    })().catch((error) => useLintRunStore.getState().update(path, { error: `检查任务历史保存失败：${String(error)}` }))
  }
  const publish = () => {
    liveResults.set(path, results)
    persistHistory()
    if (!active()) return
    const store = useLintStore.getState()
    store.replaceResults(results)
  }
  update({ running: true, paused: false, pausing: false, phase: "structural", runSemantic: options.runSemantic, hasRun: previousResults !== undefined, progress: null, detail: null, error: null })
  publish()
  try {
    const structural = await runStructuralLint(path, { signal: controller.signal, config: options.config, onProgress: (progress, total) => update({ progress: { completed: progress, total } }) })
    controller.signal.throwIfAborted()
    const synced = await projectLintFindingsToReview(path, structural)
    results = [...synced, ...(previousResults?.filter((item) => item.reviewItem || item.type === "semantic" || item.type === "structure") ?? [])]
    publish()
    if (options.runSemantic && hasUsableLlm(options.llmConfig)) {
      update({ phase: "semantic", progress: null, detail: options.messages.preparing })
      const report = await runWikiReview(path, options.llmConfig, controller.signal,
        (progress) => update({ progress, detail: progress.detail }),
        (items) => {
          results = [...results.filter((item) => !item.reviewItem && item.type !== "semantic" && item.type !== "structure"), ...reviewItemsToLint(items)]
          publish()
        })
      if (report.changedPages?.length && !controller.signal.aborted) results = await projectLintFindingsToReview(path, await runStructuralLint(path, { signal: controller.signal, config: options.config }))
      results = [...results.filter((item) => !item.reviewItem && item.type !== "semantic" && item.type !== "structure"), ...reviewItemsToLint(report.items)]
      publish()
      if (report.status !== "complete" && !controller.signal.aborted) update({ error: report.reasons.join("；") || options.messages.incomplete })
      if (active()) await refreshProjectFileTree(path, { projectId: options.project.id, bumpDataVersion: true })
    } else if (options.runSemantic) update({ error: options.messages.needsModel })
  } catch (error) {
    if (!controller.signal.aborted) update({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    // 非当前项目的结果写回其自身文件，不覆盖当前项目的问题列表。
    try {
      const persisted: LintItem[] = results.map((result, index) => ({ ...result, id: `lint-${index + 1}`, createdAt: Date.now() }))
      await saveLintItems(path, persisted)
    } catch (error) { update({ error: error instanceof Error ? error.message : String(error) }) }
    const paused = controller.signal.aborted && useLintRunStore.getState().runs[path]?.pausing === true
    if (paused) pausedRuns.set(path, { options, results })
    update({ running: false, paused, pausing: false, hasRun: true })
    await historyWrite
    if (controllers.get(path) === controller) controllers.delete(path)
  }
}
