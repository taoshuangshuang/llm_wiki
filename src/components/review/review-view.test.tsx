/** 审阅页仅保留核查与处理，历史研究选项也不能重新暴露研究入口。 */
import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/review/file-approval-panel", () => ({ FileApprovalPanel: () => null }))
vi.mock("@/lib/review-chat", () => ({ openReviewConversation: vi.fn() }))
vi.mock("@/lib/review-create-page", () => ({ createPagesFromReview: vi.fn() }))
vi.mock("@/lib/ingest-review-queue", () => ({ retryIngestReview: vi.fn(async () => {}) }))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn() }))
vi.mock("@/commands/fs", () => ({ readFile: vi.fn(), deleteFile: vi.fn(), clipServerStatus: vi.fn(async () => "ok") }))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipProvider: ({ children }: React.PropsWithChildren) => children,
  TooltipContent: ({ children }: React.PropsWithChildren) => createElement("div", null, children),
  TooltipTrigger: ({ children, ...props }: React.ComponentProps<"button">) => createElement("button", props, children),
}))
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: React.ComponentProps<"button">) => createElement("button", props, children) }))
import { ReviewView } from "./review-view"
import { readFile } from "@/commands/fs"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { retryIngestReview } from "@/lib/ingest-review-queue"
import { IconSidebar } from "@/components/layout/icon-sidebar"

let view: ReactTestRenderer | undefined
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
describe("审阅研究入口移除", () => {
  it("相关文档可打开预览，读取失败保留审阅页并提示", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    useWikiStore.setState({ project: { id: "p", name: "项目", path: "/project" }, activeView: "review", reviewRunFilter: null })
    useReviewStore.setState({ items: [{ id: "links", type: "coverage", title: "文档核查", description: "核查",
      affectedPages: ["wiki/topics/业务对象 (Biz Object).md", "faqs/已删除.md"], options: [], resolved: false, createdAt: 0 }] })
    vi.mocked(readFile).mockResolvedValueOnce("# 业务对象").mockRejectedValueOnce(new Error("missing"))
    await act(async () => { view = create(createElement(ReviewView)) })
    const link = (path: string) => view!.root.findAllByType("button").find((node) => node.props.title === `打开文档：${path}`)!
    // 完整路径中的中文、空格和括号保持原样，预览关闭后回到审阅。
    await act(async () => { await link("wiki/topics/业务对象 (Biz Object).md").props.onClick() })
    expect(readFile).toHaveBeenCalledWith("/project/wiki/topics/业务对象 (Biz Object).md")
    expect(useWikiStore.getState()).toMatchObject({ activeView: "wiki", fileContent: "# 业务对象", previewReturnView: "review" })
    useWikiStore.getState().closePreview()
    await act(async () => { await link("faqs/已删除.md").props.onClick() })
    expect(useWikiStore.getState().activeView).toBe("review")
    expect(view!.root.findByProps({ role: "alert" }).children.join("")).toContain("无法打开文档")
  })

  it("导入筛选的重要数为0但侧栏有4项时，点击侧栏应打开全部重要事项", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    useWikiStore.setState({ project: { id: "p", name: "项目", path: "/project" }, activeView: "review", reviewRunFilter: "run-selected" })
    useReviewStore.setState({ items: [
      ...Array.from({ length: 4 }, (_, index) => ({ id: `important-${index}`, type: "coverage" as const,
        title: `其他导入的遗漏-${index}`, description: "需核查", options: [], resolved: false, createdAt: 0, runIds: ["run-other"] })),
      ...Array.from({ length: 10 }, (_, index) => ({ id: `optional-${index}`, type: "suggestion" as const,
        title: `当前导入的建议-${index}`, description: "按需研究", options: [], resolved: false, createdAt: 0, runIds: ["run-selected"] })),
    ] })
    await act(async () => { view = create(createElement("div", null,
      createElement(IconSidebar, { onSwitchProject: () => {} }), createElement(ReviewView))) })
    const button = (label: string) => view!.root.findAllByType("button").find((node) => node.children.includes(label))!
    const importantCount = () => button("review.important").findByType("span").children.join("")
    const sidebar = () => view!.root.findAllByType("button").find((node) =>
      node.findAllByType("span").some((span) => span.props.className?.includes("absolute") && span.children.join("") === "4"))!
    expect(importantCount()).toBe("0")
    expect(sidebar()).toBeDefined()
    await act(async () => sidebar().props.onClick())
    expect(importantCount()).toBe("4")
    expect(useWikiStore.getState().reviewRunFilter).toBeNull()
    expect(JSON.stringify(view!.toJSON())).toContain("其他导入的遗漏-0")
    // 即使已在全局非重要页，再点角标也应回到其对应的全局重要列表。
    await act(async () => button("review.optional").props.onClick())
    await act(async () => sidebar().props.onClick())
    expect(button("review.important").props["aria-pressed"]).toBe(true)
    expect(JSON.stringify(view!.toJSON())).not.toContain("当前导入的建议-0")
  })

  it("默认只显示重要事项，切换分类后批量操作仅影响可见事项", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    useWikiStore.setState({ project: { id: "p", name: "项目", path: "/project" }, reviewRunFilter: null })
    useReviewStore.setState({ items: (["coverage", "suggestion", "missing-page"] as const).map((type) => ({
      id: type, type, title: `事项-${type}`, description: "材料", resolved: false, createdAt: 0, options: [],
    })) })
    await act(async () => { view = create(createElement(ReviewView)) })
    expect(JSON.stringify(view!.toJSON())).toContain("事项-coverage")
    expect(JSON.stringify(view!.toJSON())).not.toContain("事项-suggestion")
    const button = (key: string) => view!.root.findAllByType("button").find((node) => node.children.includes(key))!
    expect(button("review.important").findByType("span").children.join("")).toBe("1")
    expect(button("review.optional").findByType("span").children.join("")).toBe("2")
    // 先在重要页选中一项，再切到非重要，不能把隐藏的选择一起批量处理。
    await act(async () => view!.root.findAllByType("input")[0].props.onChange())
    await act(async () => button("review.optional").props.onClick())
    expect(JSON.stringify(view!.toJSON())).not.toContain("事项-coverage")
    expect(JSON.stringify(view!.toJSON())).toContain("事项-missing-page")
    expect(button("review.markSelectedResolved").props.disabled).toBe(true)
    await act(async () => view!.root.findAllByType("input")[0].props.onChange())
    await act(async () => button("review.markSelectedResolved").props.onClick())
    expect(useReviewStore.getState().items.map((item) => [item.type, item.resolved])).toEqual([
      ["coverage", false], ["suggestion", true], ["missing-page", true],
    ])
  })

  it.each([false, true])("主题核对失败展示具体诊断，历史记录缺失=%s时明确说明", async (historical) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    useWikiStore.setState({ project: { id: "p", name: "项目", path: "/project" }, reviewRunFilter: null })
    useReviewStore.setState({ items: [{ id: "target-failure", type: "merge", title: "合并问题：wiki/a.md",
      description: "页面主题核对未返回有效 JSON" + (historical ? "" : "\n\n具体原因：\nJSON 解析失败：Unexpected token\n待核对候选：wiki/b.md\n原始响应：\n无法判断"),
      risk: "页面主题核对未返回有效 JSON", options: [], resolved: false, createdAt: 0,
    }] })
    await act(async () => { view = create(createElement(ReviewView)) })
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("尚未证实存在内容冲突")
    if (historical) {
      expect(text).toContain("原因记录不完整")
      expect(text).toContain("未保存原始响应或解析错误")
    } else {
      expect(text).toContain("JSON 解析失败：Unexpected token")
      expect(text).toContain("wiki/b.md")
      expect(text).not.toContain("原因记录不完整")
    }
  })

  it("旧协议记录说明缺少歧义结论，可重新核查且不会自动标记已解决", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    useWikiStore.setState({ project: { id: "p", name: "项目", path: "/project" }, reviewRunFilter: null })
    useReviewStore.setState({ items: [{ id: "legacy-merge", type: "merge", title: "合并问题：wiki/faqs/a.md", description: "旧合并返回未明确内容歧义，需后台复核", risk: "旧合并返回未明确内容歧义，需后台复核", outcome: "保留模型合并稿并交后台复核", affectedPages: ["wiki/faqs/a.md"], evidence: [], runIds: ["run-a"], options: [], resolved: false, createdAt: 0 }] })
    await act(async () => { view = create(createElement(ReviewView)) })
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("未记录具体歧义")
    expect(text).toContain("重新核查")
    expect(text).not.toContain("风险：")
    expect(text).not.toContain("合并问题：")
    const retry = view!.root.findAllByType("button").find((button) => button.children.includes("重新核查"))!
    await act(async () => { await retry.props.onClick() })
    expect(retryIngestReview).toHaveBeenCalledWith("/project", "run-a", ["wiki/faqs/a.md"])
    expect(JSON.stringify(view!.toJSON())).toContain("已加入核查队列")
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("保留研究建议事项和普通操作，移除单项、批量及历史自定义研究动作", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    useWikiStore.setState({ project: { id: "p", name: "项目", path: "/project" }, reviewRunFilter: null })
    useReviewStore.setState({ items: [{ id: "review-1", schemaVersion: 2, type: "suggestion", title: "仍需核查的建议", description: "待核查证据", resolved: false, createdAt: 0,
      options: [{ label: "遗留研究入口", action: "__deep_research__" }, { label: "自定义调研", action: "研究该主题" }, { label: "结构化研究", action: "custom-action", kind: "research" }, { label: "普通确认", action: "acknowledge" }],
    }] })
    await act(async () => { view = create(createElement(ReviewView)) })
    // 研究建议默认归入非重要，切换后仍能执行普通确认动作。
    expect(JSON.stringify(view!.toJSON())).not.toContain("仍需核查的建议")
    const optional = view!.root.findAllByType("button").find((button) => button.children.includes("review.optional"))!
    await act(async () => optional.props.onClick())
    const text = JSON.stringify(view!.toJSON())
    for (const removed of ["遗留研究入口", "自定义调研", "结构化研究", "research.title", "review.researchSelected"]) expect(text).not.toContain(removed)
    expect(text).toContain("仍需核查的建议")
    expect(text).toContain("普通确认")
    expect(text).toContain("review.startConversation")
    const acknowledge = view!.root.findAllByType("button").find((button) => button.children.includes("普通确认"))!
    await act(async () => { acknowledge.props.onClick() })
    expect(useReviewStore.getState().items[0].resolved).toBe(true)
  })
})
