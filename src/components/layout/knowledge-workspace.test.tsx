/** 验证浏览与搜索共用入口后，预览切换不会丢弃搜索输入。 */
import { createElement, useState } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("@/components/search/search-view", () => ({
  SearchView: function SearchView() {
    const [query, setQuery] = useState("")
    return createElement("input", { value: query, onChange: (value: string) => setQuery(value) })
  },
}))
vi.mock("./preview-panel", () => ({ PreviewPanel: () => createElement("div", null, "页面预览") }))
import { KnowledgeWorkspace } from "./knowledge-workspace"
import { useWikiStore } from "@/stores/wiki-store"
let view: ReactTestRenderer | undefined
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.unstubAllGlobals()
})
describe("知识浏览与搜索", () => {
  it("从浏览进入搜索、打开结果、返回搜索后保留查询", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    useWikiStore.setState({ activeView: "wiki", previewReturnView: null })
    await act(async () => { view = create(createElement(KnowledgeWorkspace)) })
    expect(JSON.stringify(view!.toJSON())).toContain("页面预览")
    await act(async () => { view!.root.findAllByType("button")[1].props.onClick() })
    expect(useWikiStore.getState().activeView).toBe("search")
    await act(async () => { view!.root.findByType("input").props.onChange("元数据") })
    await act(async () => { useWikiStore.getState().openFileInPreview("/project/wiki/example.md", "正文") })
    expect(useWikiStore.getState().activeView).toBe("wiki")
    expect(JSON.stringify(view!.toJSON())).toContain("页面预览")
    await act(async () => { useWikiStore.getState().closePreview() })
    expect(useWikiStore.getState().activeView).toBe("search")
    expect(view!.root.findByType("input").props.value).toBe("元数据")
  })
})
