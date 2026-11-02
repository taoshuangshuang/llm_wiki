/** 通过用户可见导航验证三级布局、草稿保留和共享配置定位。 */
import { createElement } from "react"
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const files = vi.hoisted(() => new Map<string, string>())
const save = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("@/commands/fs", () => ({
  fileExists: async (path: string) => files.has(path),
  readFile: async (path: string) => { if (!files.has(path)) throw new Error("不存在"); return files.get(path)! },
  saveWorkflowFile: async (_project: string, path: string, _expected: string | null, content: string) => { await save(); files.set(`/project/${path}`, content) },
}))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn() }))
vi.mock("../sections/llm-provider-section", () => ({ LlmProviderSection: () => null }))
vi.mock("../sections/embedding-section", () => ({ EmbeddingSection: () => null }))
vi.mock("../sections/web-search-section", () => ({ WebSearchSection: () => null }))
vi.mock("../sections/mineru-section", () => ({ MineruSection: () => null }))
vi.mock("../sections/multimodal-section", () => ({ MultimodalSection: () => null }))
vi.mock("../sections/scheduled-import-section", () => ({ ScheduledImportSection: () => null }))
vi.mock("../sections/network-section", () => ({ NetworkSection: () => null }))
vi.mock("../sections/source-watch-section", () => ({ SourceWatchSection: () => null }))
vi.mock("../sections/retrieval-section", () => ({ RetrievalSection: () => null }))
vi.mock("../sections/output-section", () => ({ OutputSection: () => null }))
vi.mock("../sections/review-prompt-section", () => ({ ReviewPromptSection: () => null }))
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: React.ComponentProps<"button">) => createElement("button", props, children) }))
import { WorkflowSettingsView } from "./workflow-settings-view"
import { useWikiStore } from "@/stores/wiki-store"

let view: ReactTestRenderer | undefined
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  files.clear(); save.mockClear()
  files.set("/project/purpose.md", "原始知识目标")
  useWikiStore.setState({ project: { id: "project", name: "测试知识库", path: "/project" } })
})
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
async function render() { await act(async () => { view = create(createElement(WorkflowSettingsView)) }) }
function label(entry: ReactTestInstance): string {
  return entry.children.map((child) => typeof child === "string" ? child : label(child)).join("")
}
async function click(text: string) {
  const button = view!.root.findAllByType("button").find((entry) => label(entry).replace(/•/g, "").replace(/^\d+/, "").replace(/按条件执行$/, "") === text)
  if (!button) throw new Error(`找不到按钮：${text}`)
  await act(async () => { button.props.onClick() })
}

describe("知识流程导航与配置", () => {
  it("顶部切阶段、左侧切节点，无配置节点仍展示输入输出和职责", async () => {
    await render()
    const nav = view!.root.findByProps({ "aria-label": "知识处理主流程" })
    expect(nav.findAllByType("button")).toHaveLength(8)
    await click("匹配与写入")
    await click("页面提交与图片归位")
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("程序自动执行")
    expect(text).toContain("原子写入")
    expect(text).toContain("此节点暂无独立设置")
    expect(text).toContain("修改影响与生效方式")
  })

  it("全库引用维护位于提交后，说明章节退回和缺失引用转审阅规则", async () => {
    await render()
    await click("匹配与写入")
    await click("全库引用维护")
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("页面写入完成、格式检查之前")
    expect(text).toContain("章节不存在则退回页面链接")
    expect(text).toContain("交格式检查转待审阅")
    expect(text).toContain("不创建占位页")
  })

  it("公共设置提供业务类型与向量库入口，设置区与节点说明分别展示", async () => {
    await render()
    await click("业务类型与模块字典")
    const settings = view!.root.findByProps({ "aria-label": "节点设置" })
    expect(label(settings)).toContain("业务模块字典")
    expect(label(settings)).not.toContain("修改影响与生效方式")
    await click("向量库配置")
    expect(view!.root.findByProps({ "aria-label": "节点设置" })).toBeTruthy()
    await click("匹配与写入")
    await click("向量索引构建")
    expect(JSON.stringify(view!.toJSON())).toContain("此节点暂无独立设置")
    const reference = view!.root.findByProps({ "aria-label": "共用配置引用" }).findAllByType("button").find((entry) => label(entry).includes("向量库配置"))!
    await act(async () => { reference.props.onClick() })
    expect(JSON.stringify(view!.toJSON())).toContain("公共设置")
    expect(view!.root.findByProps({ "aria-label": "公共设置的执行节点" })).toBeTruthy()
  })

  it("文件草稿跨阶段保留，保存只提交当前文件", async () => {
    await render()
    await act(async () => { view!.root.findByProps({ "aria-label": "知识库目标与收录范围" }).props.onChange({ target: { value: "新的知识目标" } }) })
    await click("输出")
    await click("公共设置")
    expect(view!.root.findByProps({ "aria-label": "知识库目标与收录范围" }).props.value).toBe("新的知识目标")
    expect(files.get("/project/purpose.md")).toBe("原始知识目标")
    await click("保存当前文件")
    expect(files.get("/project/purpose.md")).toBe("新的知识目标")
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("共用规则以跳转呈现，切换项目丢弃旧项目草稿", async () => {
    await render()
    await click("后台审阅")
    await click("知识补充建议")
    const reference = view!.root.findByProps({ "aria-label": "共用配置引用" }).findAllByType("button").find((button) => label(button).includes("已有知识核对与共用规则"))!
    await act(async () => { reference.props.onClick() })
    expect(view!.root.findAllByType("textarea").some((entry) => entry.props["aria-label"] === "统一后台审阅")).toBe(true)
    await act(async () => { useWikiStore.setState({ project: { id: "other", name: "另一个", path: "/other" } }) })
    expect(view!.root.findByProps({ "aria-label": "知识库目标与收录范围" }).props.value).toBe("")
  })
})
