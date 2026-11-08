import { describe, it, expect } from "vitest"
import { retireStaleStructureItems } from "./review-structure-retire"
import type { ReviewItem } from "@/stores/review-store"

function item(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "review-v2-x-y", type: "structure", title: "失效引用 [[旧页]]", description: "失效引用 [[旧页]]：目标页面不存在或名称不唯一",
    options: [], resolved: false, createdAt: 0, affectedPages: ["wiki/a.md"], ...overrides,
  }
}

describe("retireStaleStructureItems — 旧版本结构事项退役", () => {
  it("退役本轮已检查页面上未重现的未决结构事项", () => {
    const stale = item({ id: "old" })
    const retired = retireStaleStructureItems([stale], ["wiki/a.md"], ["new"])
    expect(retired).toEqual([{ ...stale, historical: true }])
  })

  it("本轮重现（同一 id）的事项不退役", () => {
    expect(retireStaleStructureItems([item({ id: "same" })], ["wiki/a.md"], ["same"])).toEqual([])
  })

  it("未在本轮检查范围内的页面保持不变", () => {
    expect(retireStaleStructureItems([item({ id: "old", affectedPages: ["wiki/b.md"] })], ["wiki/a.md"], [])).toEqual([])
    // 跨页事项只有全部页面都被检查过才能判定过期。
    expect(retireStaleStructureItems([item({ id: "old", affectedPages: ["wiki/a.md", "wiki/b.md"] })], ["wiki/a.md"], [])).toEqual([])
  })

  it("已处理、历史或非结构事项不参与退役", () => {
    const items = [
      item({ id: "resolved", resolved: true }),
      item({ id: "historical", historical: true }),
      item({ id: "hidden", hidden: true }),
      item({ id: "dismissed", dismissed: true }),
      item({ id: "knowledge", type: "contradiction" }),
      item({ id: "no-pages", affectedPages: [] }),
    ]
    expect(retireStaleStructureItems(items, ["wiki/a.md"], [])).toEqual([])
  })
})
