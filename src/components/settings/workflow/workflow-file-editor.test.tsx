/** 折叠操作只改变可见性；用途清晰、路径不重复、草稿与保存行为保持完整。 */
import { createElement } from "react"
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: React.ComponentProps<"button">) => createElement("button", props, children) }))
import { WorkflowFileEditor } from "./workflow-file-editor"
import type { WorkflowDocumentDraft } from "./workflow-documents"

let view: ReactTestRenderer | undefined
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
function text(entry: ReactTestInstance): string {
  return entry.children.map((child) => typeof child === "string" ? child : text(child)).join("")
}
const file = { title: "内容覆盖审阅规则", description: "对照来源快照与落盘页面，识别关键知识的遗漏与失真。", prompt: "acceptance" as const }
const path = "prompts/06-01-最终验收规则.md"
const initial: WorkflowDocumentDraft = { path, source: path, expected: "原始规则", original: "原始规则", content: "原始规则", defaultContent: "默认规则" }

describe("流程文件设置卡片", () => {
  it("用途与路径各展示一次，提示词默认收起并可展开", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    await act(async () => { view = create(createElement(WorkflowFileEditor, { file, value: initial, busy: false, onChange: vi.fn(), onSave: vi.fn(), onReload: vi.fn() })) })
    const content = text(view!.root)
    expect(content.split(path)).toHaveLength(2)
    expect(content).toContain(file.description)
    expect(content).not.toContain("配置来源：")
    expect(view!.root.findByType("details").props.open).toBe(false)
    await act(async () => { view!.root.findByType("details").props.onToggle({ currentTarget: { open: true } }) })
    expect(view!.root.findByType("details").props.open).toBe(true)
    expect(text(view!.root)).toContain("收起提示词")
  })

  it("编辑后收起再展开保留草稿，仍通过当前文件按钮保存", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const save = vi.fn()
    let value = initial
    const onChange = (content: string) => {
      value = { ...value, content }
      view!.update(createElement(WorkflowFileEditor, { file, value, busy: false, onChange, onSave: save, onReload: vi.fn() }))
    }
    await act(async () => { view = create(createElement(WorkflowFileEditor, { file, value, busy: false, onChange, onSave: save, onReload: vi.fn() })) })
    await act(async () => { view!.root.findByType("details").props.onToggle({ currentTarget: { open: true } }) })
    await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "修改后的规则" } }) })
    await act(async () => { view!.root.findByType("details").props.onToggle({ currentTarget: { open: false } }) })
    expect(text(view!.root)).toContain("未保存修改")
    await act(async () => { view!.root.findByType("details").props.onToggle({ currentTarget: { open: true } }) })
    expect(view!.root.findByType("textarea").props.value).toBe("修改后的规则")
    const button = view!.root.findAllByType("button").find((entry) => text(entry) === "保存当前文件")!
    expect(button.props.disabled).toBe(false)
    await act(async () => { button.props.onClick() })
    expect(save).toHaveBeenCalledTimes(1)
  })
})
