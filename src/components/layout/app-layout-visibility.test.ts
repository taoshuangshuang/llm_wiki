import { describe, expect, it } from "vitest"
import { getAppLayoutVisibility } from "./app-layout-visibility"

describe("工作区面板可见性", () => {
  it.each(["sources", "workflow", "imports", "chat", "settings", "skills"] as const)("%s 使用完整工作区，不显示额外侧栏", (view) => {
    expect(getAppLayoutVisibility(view, true)).toEqual({ showLeftPanel: false, hasRightPanel: false })
  })

  it("从原始资料打开预览时继续使用完整宽度", () => {
    expect(getAppLayoutVisibility("wiki", true, "sources")).toEqual({ showLeftPanel: false, hasRightPanel: false })
  })

  it.each(["wiki", "search", "review", "graph"] as const)("%s 保留资料导航，仅在有审阅会话时打开右侧面板", (view) => {
    expect(getAppLayoutVisibility(view)).toEqual({ showLeftPanel: true, hasRightPanel: false })
    expect(getAppLayoutVisibility(view, true)).toEqual({ showLeftPanel: true, hasRightPanel: true })
  })
})
