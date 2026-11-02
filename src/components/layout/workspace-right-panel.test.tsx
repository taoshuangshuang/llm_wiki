/** 研究功能下线后，工作区右侧只呈现审阅会话。 */
import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("@/components/chat/chat-panel", () => ({ ChatPanel: () => createElement("div", null, "审阅会话") }))
import { WorkspaceRightPanel } from "./workspace-right-panel"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewChatStore } from "@/stores/review-chat-store"
let view: ReactTestRenderer | undefined
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
describe("审阅右侧面板", () => {
  it("在各工作区仅呈现会话，关闭时清理面板会话状态", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    useWikiStore.setState({ activeView: "review" })
    useReviewChatStore.getState().open("/project", "conversation")
    await act(async () => { view = create(createElement(WorkspaceRightPanel, { conversationId: "conversation" })) })
    expect(JSON.stringify(view!.toJSON())).toContain("审阅会话")
    await act(async () => { useWikiStore.setState({ activeView: "wiki" }) })
    expect(JSON.stringify(view!.toJSON())).toContain("审阅会话")
    expect(JSON.stringify(view!.toJSON())).not.toContain("review-research-tab")
    await act(async () => { view!.root.findByType("button").props.onClick() })
    expect(useReviewChatStore.getState().session).toBeNull()
  })
  it("没有会话时不显示其他功能面板", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    await act(async () => { view = create(createElement(WorkspaceRightPanel)) })
    expect(view!.toJSON()).toBeNull()
  })
})
