/** 监控、筛选与并发分别显示，关闭监控后仍允许调整手动导入使用的筛选规则。 */
import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SourceWatchSection } from "./source-watch-section"
import { createSettingsDraft } from "../settings-draft"

let view: ReactTestRenderer | undefined
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
describe("来源配置按执行职责拆分", () => {
  it("文件筛选只显示允许类型、排除规则与大小限制，监控关闭也可编辑", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const draft = createSettingsDraft()
    draft.sourceWatchConfig.enabled = false
    await act(async () => { view = create(createElement(SourceWatchSection, { draft, setDraft: vi.fn(), projectReady: true, part: "filters" })) })
    const fields = view!.root.findAllByType("input")
    expect(fields.length).toBeGreaterThan(10)
    expect(fields.every((field) => !field.props.disabled)).toBe(true)
    expect(view!.root.findAllByType("textarea")).toHaveLength(3)
    expect(fields.filter((field) => field.props.type === "number")).toHaveLength(1)
  })

  it("任务准备只显示两项并发和保留提取文本，不出现监控或筛选表单", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    await act(async () => { view = create(createElement(SourceWatchSection, { draft: createSettingsDraft(), setDraft: vi.fn(), projectReady: true, part: "processing" })) })
    expect(view!.root.findAllByType("input").map((field) => field.props.type)).toEqual(["number", "number", "checkbox"])
    expect(view!.root.findAllByType("textarea")).toHaveLength(0)
  })
})
