import { create } from "zustand"
import type { LintResult } from "@/lib/lint"

export interface LintItem {
  id: string
  type: LintResult["type"]
  severity: LintResult["severity"]
  page: string
  detail: string
  affectedPages?: string[]
  brokenTarget?: string
  suggestedTarget?: string
  suggestedSource?: string
  reviewItem?: LintResult["reviewItem"]
  createdAt: number
}

function lintResultToItem(result: LintResult): LintItem {
  return {
    type: result.type,
    severity: result.severity,
    page: result.page,
    detail: result.detail,
    affectedPages: result.affectedPages,
    brokenTarget: result.brokenTarget,
    suggestedTarget: result.suggestedTarget,
    suggestedSource: result.suggestedSource,
    reviewItem: result.reviewItem,
    id: `lint-${++counter}`,
    createdAt: Date.now(),
  }
}

function syncCounterFromItems(items: readonly LintItem[]): void {
  for (const item of items) {
    const match = /^lint-(\d+)$/.exec(item.id)
    if (!match) continue
    const idNumber = Number(match[1])
    if (Number.isFinite(idNumber) && idNumber > counter) {
      counter = idNumber
    }
  }
}

/** 语义事项按审阅身份保持卡片稳定，结构问题按输入输出身份匹配。 */
function lintResultKey(result: LintResult): string {
  return result.reviewItem?.id
    ? `semantic:${result.reviewItem.id}`
    : result.type === "broken-link" && result.brokenTarget
      ? JSON.stringify([result.type, result.page, result.brokenTarget])
      : JSON.stringify([result.type, result.page, result.detail])
}

/** 合并重复问题并修复旧数据的 ID 冲突，避免列表筛选时残留错误卡片。 */
function normalizeLintItems(items: readonly LintItem[]): LintItem[] {
  syncCounterFromItems(items)
  const unique = new Map<string, LintItem>()
  const ids = new Set<string>()
  for (const item of items) {
    const key = lintResultKey(item)
    if (unique.has(key)) continue
    const next = ids.has(item.id) ? { ...item, id: `lint-${++counter}` } : item
    ids.add(next.id)
    unique.set(key, next)
  }
  return [...unique.values()]
}

interface LintState {
  items: LintItem[]
  setItems: (items: LintItem[]) => void
  replaceResults: (results: LintResult[]) => void
  addItems: (results: LintResult[]) => void
  removeItem: (id: string) => void
  removeItems: (ids: string[]) => void
  clearItems: () => void
}

let counter = 0

export const useLintStore = create<LintState>((set) => ({
  items: [],

  setItems: (items) => {
    set({ items: normalizeLintItems(items) })
  },

  // 增量快照保留原卡片 ID，后续批次更新不会丢失用户的勾选状态。
  replaceResults: (results) => set((state) => {
    const previous = new Map(state.items.map((item) => [lintResultKey(item), item]))
    return { items: normalizeLintItems(results.map((result) => {
      const old = previous.get(lintResultKey(result))
      return old ? { ...result, id: old.id, createdAt: old.createdAt } : lintResultToItem(result)
    })) }
  }),

  addItems: (results) =>
    set((state) => ({
      items: normalizeLintItems([...state.items, ...results.map(lintResultToItem)]),
    })),

  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  removeItems: (ids) =>
    set((state) => {
      const remove = new Set(ids)
      return {
        items: state.items.filter((item) => !remove.has(item.id)),
      }
    }),

  clearItems: () => set({ items: [] }),
}))
