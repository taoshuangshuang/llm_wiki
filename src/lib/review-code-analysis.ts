/** 已有冲突复用自动核验能力，跨视图保持执行并按项目保存结果。 */
import type { ReviewItem } from "@/stores/review-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { LlmConfig } from "@/stores/wiki-store"
import { analyzeReviewCode } from "./code-conflict-analysis"
import { loadReviewItems, saveReviewItems } from "./persist"

const running = new Map<string, Promise<void>>()

export function runReviewCodeAnalysis(projectPath: string, item: ReviewItem, config: LlmConfig, language: string): Promise<void> {
  const key = projectPath + "\0" + item.id
  const current = running.get(key)
  if (current) return current
  const task = (async () => {
    if (item.historical || !["contradiction", "confirm"].includes(item.type)) throw new Error("请先重新检查当前页面的事实冲突")
    const analysis = await analyzeReviewCode(projectPath, item, config, undefined, language)
    if (!analysis) throw new Error("相关页面的业务模块尚无已保存的源码绑定")
    const stored = (await loadReviewItems(projectPath)).find((entry) => entry.id === item.id)
    if (!stored || JSON.stringify(stored.evidence) !== JSON.stringify(item.evidence)) throw new Error("事项证据已变化，请刷新后核验")
    await saveReviewItems(projectPath, [{ ...stored, codeAnalysis: analysis }])
    if (useWikiStore.getState().project?.path === projectPath) useReviewStore.getState().setItems(await loadReviewItems(projectPath))
  })().finally(() => { running.delete(key) })
  running.set(key, task)
  return task
}
