/** 审阅请求应跨导航持续运行，仅在关闭面板、切换项目或卸载布局时取消。 */
import { createElement, useEffect, useMemo } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatRunRegistry, type ChatRun } from "@/lib/chat-runs"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewChatStore } from "@/stores/review-chat-store"

vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn() }))
vi.mock("./icon-sidebar", () => ({ IconSidebar: () => null }))
vi.mock("./update-banner", () => ({ UpdateBanner: () => null }))
vi.mock("./sidebar-panel", () => ({ SidebarPanel: () => null }))
vi.mock("./content-area", () => ({ ContentArea: () => null }))
vi.mock("@/components/chat/chat-panel", () => ({ ChatPanel: RequestOwner }))
import { AppLayout } from "./app-layout"
import { WorkspaceRightPanel } from "./workspace-right-panel"

const cancelBackend = vi.fn()
let registry: ChatRunRegistry
let view: ReactTestRenderer | undefined

/** 替换模型与消息渲染依赖，保留 ChatPanel 的请求归属及卸载清理契约。 */
function RequestOwner() {
  const project = useWikiStore((state) => state.project)
  registry = useMemo(() => new ChatRunRegistry(cancelBackend), [project?.id, project?.path])
  const ownedRegistry = registry
  useEffect(() => () => ownedRegistry.cancelAll(), [ownedRegistry])
  return createElement("div", { "data-testid": "review-request-owner" })
}

afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.unstubAllGlobals()
})

/** 从已打开的审阅会话启动一次包含流内容的生成请求。 */
async function startReview(): Promise<ChatRun> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("localStorage", { getItem: () => null })
  cancelBackend.mockClear()
  useWikiStore.setState({ project: { id: "p", path: "/project", name: "项目" }, activeView: "review" })
  useChatStore.setState({
    conversations: [{ id: "review", title: "审阅", createdAt: 0, updatedAt: 0 }],
    activeConversationId: "review", conversationStreams: {},
  })
  useReviewChatStore.getState().open("/project", "review")
  await act(async () => { view = create(createElement(AppLayout, { onSwitchProject: () => {} })) })
  const run = registry.start("review")!
  useChatStore.getState().setStreamContent("review", "处理中")
  useChatStore.getState().setStreamEvents("review", [{ stage: "reading_context", message: "读取附件", status: "running" }])
  return run
}

describe("审阅会话导航保活", () => {
  it.each(["chat", "settings", "imports", "workflow", "skills", "wiki", "search", "graph", "sources", "lint"] as const)("切到 %s 再回来保留原请求及生成内容", async (destination) => {
    const run = await startReview()
    await act(async () => { useWikiStore.setState({ activeView: destination }) })
    expect(run.controller.signal.aborted).toBe(false)
    expect(cancelBackend).not.toHaveBeenCalled()
    const hidden = ["chat", "settings", "imports", "workflow", "skills", "sources"].includes(destination)
    const panelContainer = view!.root.findByType(WorkspaceRightPanel).parent!.parent!
    expect(panelContainer.props.className === "hidden").toBe(hidden)
    // 隐藏期间仍可接收流输出；切换主聊天会话也不能抢回焦点。
    expect(registry.isCurrent(run)).toBe(true)
    useChatStore.getState().appendStreamToken("，继续生成", "review")
    if (hidden) {
      await act(async () => { useChatStore.getState().setActiveConversation("another") })
      expect(useChatStore.getState().activeConversationId).toBe("another")
    }
    await act(async () => { useWikiStore.setState({ activeView: "review" }) })
    expect(run.controller.signal.aborted).toBe(false)
    expect(useChatStore.getState().conversationStreams.review?.content).toBe("处理中，继续生成")
    expect(useChatStore.getState().conversationStreams.review?.agentEvents).toEqual([
      { stage: "reading_context", message: "读取附件", status: "running" },
    ])
    expect(cancelBackend).not.toHaveBeenCalled()
    expect(useChatStore.getState().activeConversationId).toBe("review")
  })

  it.each(["close", "project", "unmount"] as const)("%s 仍会取消原请求并释放流状态", async (action) => {
    const run = await startReview()
    await act(async () => {
      if (action === "close") view!.root.findByProps({ "aria-label": "review.closePanel" }).props.onClick()
      if (action === "project") useWikiStore.setState({ project: { id: "other", path: "/other", name: "其他项目" } })
      if (action === "unmount") { view!.unmount(); view = undefined }
    })
    expect(run.controller.signal.aborted).toBe(true)
    expect(cancelBackend).toHaveBeenCalledExactlyOnceWith(run)
    expect(useChatStore.getState().conversationStreams.review).toBeUndefined()
  })
})
