import { act, createElement, type ComponentProps } from "react"
import { create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatPanel } from "./chat-panel"
import { ContentArea } from "@/components/layout/content-area"
import { ChatInput } from "./chat-input"
import { StreamingMessage } from "./chat-message"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { createStreamChatHarness } from "@/test-helpers/mock-stream-chat"
import i18n from "@/i18n"

interface AgentRequest { sessionId: string; runId: string; message: string }
interface AgentEvent {
  type: string
  text?: string
  tool?: string
  input?: string
  message?: string
}
interface AgentPayload { sessionId: string; runId: string; event: AgentEvent }

const backend = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Set<(event: { payload: AgentPayload }) => void>(),
  requests: [] as AgentRequest[],
}))
const cli = createStreamChatHarness()

vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke, convertFileSrc: (path: string) => path }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: AgentPayload }) => void) => {
    backend.listeners.add(handler)
    return () => backend.listeners.delete(handler)
  }),
}))
vi.mock("@/lib/llm-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/llm-client")>(),
  streamChat: (...args: unknown[]) => cli.mock(...args),
}))
vi.mock("./chat-input", () => ({
  ChatInput: (props: Record<string, unknown>) => createElement("mock-chat-input", props),
}))
vi.mock("./chat-message", () => ({
  ChatMessage: () => null,
  StreamingMessage: (props: Record<string, unknown>) => createElement("mock-streaming-message", props),
  useSourceFiles: () => {},
}))
vi.mock("@/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => createElement("button", props),
}))
vi.mock("@/components/editor/file-preview", () => ({ FilePreview: () => null }))
vi.mock("@/components/editor/wiki-reader", () => ({ WikiReader: () => null }))
vi.mock("@/components/editor/frontmatter-panel", () => ({ FrontmatterPanel: () => null }))
vi.mock("@/components/chat/reference-knowledge-graph", () => ({ ReferenceKnowledgeGraph: () => null }))
vi.mock("@/lib/ingest", () => ({ executeIngestWrites: vi.fn() }))
vi.mock("@/components/settings/settings-view", () => ({ SettingsView: () => null }))
vi.mock("@/components/settings/sections/skills-section", () => ({ SkillsSection: () => null }))
vi.mock("@/components/sources/sources-view", () => ({ SourcesView: () => null }))
vi.mock("@/components/review/review-view", () => ({ ReviewView: () => null }))
vi.mock("@/components/lint/lint-view", () => ({ LintView: () => null }))
vi.mock("@/components/search/search-view", () => ({ SearchView: () => null }))
vi.mock("@/components/graph/graph-view", () => ({ GraphView: () => null }))
vi.mock("@/components/layout/preview-panel", () => ({ PreviewPanel: () => null }))

let panel: ReactTestRenderer | undefined

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("window", { setTimeout, clearTimeout })
  useChatStore.setState(useChatStore.getInitialState())
  useWikiStore.setState(useWikiStore.getInitialState())
  useWikiStore.setState({
    project: { id: "p", name: "测试项目", path: "/project" },
    llmConfig: { ...useWikiStore.getState().llmConfig, provider: "openai", model: "test-model", apiKey: "test-key" },
  })
  backend.listeners.clear()
  backend.requests.length = 0
  cli.reset()
  backend.invoke.mockReset().mockImplementation(async (command: string, args: { request?: AgentRequest }) => {
    if (command === "agent_list_skills") return []
    if (command === "agent_start_turn_stream") {
      backend.requests.push(args.request!)
      return args.request!.sessionId
    }
    if (command === "agent_start_turn") return { sessionId: args.request!.sessionId, message: "检索上下文" }
    if (command === "agent_cancel_turn") return true
    throw new Error(`Unexpected command: ${command}`)
  })
})

afterEach(async () => {
  await act(async () => panel?.unmount())
  panel = undefined
  vi.unstubAllGlobals()
})

function input(): ComponentProps<typeof ChatInput> {
  return panel!.root.findByType(ChatInput).props as ComponentProps<typeof ChatInput>
}

/** 从真实面板的发送入口启动请求，保持生成悬挂以确定性地交错回调。 */
async function send(text: string) {
  await act(async () => {
    const props = input()
    props.onSend(text, [], {
      useWebSearch: props.useWebSearch,
      useAnyTxtSearch: props.useAnyTxtSearch,
      agentMode: props.agentMode,
      retrievalMode: props.retrievalMode,
      skills: props.selectedSkills,
      contextFiles: props.selectedContextFiles,
    })
  })
}

async function emit(request: AgentRequest, event: AgentEvent) {
  await act(async () => {
    for (const listener of backend.listeners) listener({ payload: { ...request, event } })
  })
}

describe("聊天面板的跨会话并发", () => {
  it("切换左侧页签再返回时，保留进度并继续接收同一轮生成", async () => {
    const conversationId = useChatStore.getState().createConversation()
    useWikiStore.getState().setActiveView("chat")
    await act(async () => { panel = create(<ContentArea />) })
    await send("继续核查缓存链路")
    const request = backend.requests[0]
    await emit(request, { type: "messageDelta", text: "<think>正在核查" })
    await emit(request, { type: "toolStart", tool: "wiki.search", input: "缓存链路" })
    const progress = panel!.root.findByType(StreamingMessage).props.agentEvents
    let content = "<think>正在核查"

    // 走实际的视图切换入口，包含首次打开来源页导致布局结构改变的情况。
    for (const view of ["sources", "wiki", "review", "settings"] as const) {
      await act(async () => { useWikiStore.getState().setActiveView(view) })
      // 离开聊天页期间仍能接收增量，返回后显示最新进度。
      await emit(request, { type: "messageDelta", text: "继续" })
      content += "继续"
      await act(async () => { useWikiStore.getState().setActiveView("chat") })
      expect(input().isStreaming).toBe(true)
      expect(panel!.root.findByType(StreamingMessage).props.content).toBe(content)
      expect(panel!.root.findByType(StreamingMessage).props.agentEvents).toEqual(progress)
      expect(backend.listeners.size).toBe(1)
    }
    expect(backend.invoke.mock.calls.filter(([command]) => command === "agent_cancel_turn")).toHaveLength(0)
    await act(async () => { useWikiStore.getState().setActiveView("sources") })
    await emit(request, { type: "messageDelta", text: "</think>核查完成" })
    await emit(request, { type: "done" })
    await act(async () => { useWikiStore.getState().setActiveView("chat") })
    expect(input().isStreaming).toBe(false)
    expect(useChatStore.getState().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId, role: "assistant", content: `${content}</think>核查完成` }),
    ]))
  })

  it("第二个会话可发送；思考、工具进度和后台完成均不影响另一个会话", async () => {
    const first = useChatStore.getState().createConversation()
    await act(async () => { panel = create(<ChatPanel />) })
    await send("第一个问题")
    const firstRequest = backend.requests[0]
    await emit(firstRequest, { type: "messageDelta", text: "<think>第一轮思考" })

    // 通过界面上的“新对话”按钮切换，避免漏测按钮曾经主动停止旧请求的行为。
    await act(async () => {
      panel!.root.findAllByType("button")
        .find((button) => button.children.includes(i18n.t("chat.newChat")))!.props.onClick()
    })
    const second = useChatStore.getState().activeConversationId!
    expect(input().isStreaming).toBe(false)
    await send("第二个问题")
    expect(backend.requests).toHaveLength(2)
    expect(backend.invoke.mock.calls.filter(([command]) => command === "agent_cancel_turn")).toHaveLength(0)
    expect(backend.requests[1].sessionId).toBe(second)
    await emit(backend.requests[1], { type: "messageDelta", text: "第二轮输出" })
    await emit(firstRequest, { type: "toolStart", tool: "wiki.search", input: "第一轮检索" })
    await emit(firstRequest, { type: "messageDelta", text: "继续思考" })
    expect(panel!.root.findByType(StreamingMessage).props.content).toBe("第二轮输出")
    expect(panel!.root.findByType(StreamingMessage).props.agentEvents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: "wiki_search" })]),
    )

    await act(async () => { useChatStore.getState().setActiveConversation(first) })
    expect(panel!.root.findByType(StreamingMessage).props.content).toBe("<think>第一轮思考继续思考")
    expect(panel!.root.findByType(StreamingMessage).props.agentEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: "wiki_search", message: "第一轮检索" })]),
    )
    await act(async () => { useChatStore.getState().setActiveConversation(second) })
    await emit(firstRequest, { type: "messageDelta", text: "</think>第一轮答案" })
    await emit(firstRequest, { type: "done" })
    expect(input().isStreaming).toBe(true)
    expect(panel!.root.findByType(StreamingMessage).props.content).toBe("第二轮输出")
    await emit(backend.requests[1], { type: "done" })
    expect(input().isStreaming).toBe(false)
    expect(useChatStore.getState().messages.filter((message) => message.role === "assistant").map((message) => [message.conversationId, message.content])).toEqual([
      [first, "<think>第一轮思考继续思考</think>第一轮答案"],
      [second, "第二轮输出"],
    ])
    expect(backend.listeners.size).toBe(0)
  })

  it("同一会话阻止重复发送；停止当前会话只取消该轮请求，旧回调也不影响重试", async () => {
    const first = useChatStore.getState().createConversation()
    const second = useChatStore.getState().createConversation()
    await act(async () => { useChatStore.getState().setActiveConversation(first); panel = create(<ChatPanel />) })
    await send("第一个问题")
    await send("重复点击")
    expect(backend.requests).toHaveLength(1)
    await act(async () => { useChatStore.getState().setActiveConversation(second) })
    await send("第二个问题")
    const stoppedRequest = backend.requests[1]
    await act(async () => input().onStop())
    expect(backend.invoke).toHaveBeenCalledWith("agent_cancel_turn", {
      projectId: "p", sessionId: second, runId: stoppedRequest.runId,
    })
    expect(useChatStore.getState().conversationStreams[first]).toBeDefined()
    await send("第二个问题重试")
    await emit(stoppedRequest, { type: "messageDelta", text: "已取消请求的延迟输出" })
    await emit(stoppedRequest, { type: "done" })
    expect(input().isStreaming).toBe(true)
    await emit(backend.requests[2], { type: "messageDelta", text: "重试答案" })
    await emit(backend.requests[0], { type: "error", message: "第一轮错误" })
    expect(input().isStreaming).toBe(true)
    expect(panel!.root.findByType(StreamingMessage).props.content).toBe("重试答案")
    await emit(backend.requests[2], { type: "done" })
    expect(useChatStore.getState().getActiveMessages().filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["重试答案"])
  })

  it("CLI 会话也可并发，停止一个会话不会使另一个会话的回调失效", async () => {
    useWikiStore.setState({ llmConfig: { ...useWikiStore.getState().llmConfig, provider: "codex-cli" } })
    const first = useChatStore.getState().createConversation()
    await act(async () => { panel = create(<ChatPanel />) })
    await send("CLI 问题一")
    await act(async () => { useChatStore.getState().createConversation() })
    await send("CLI 问题二")
    expect(cli.pending).toHaveLength(2)
    // 普通 CLI 会话也携带持续授权规则，不能只由审阅上下文注入。
    expect(cli.pending[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("不要逐轮或逐文件重复确认"),
    })
    await act(async () => { cli.pending[0].callbacks.onReasoningToken?.("CLI 思考") })
    await act(async () => input().onStop())
    expect(cli.pending[1].aborted).toBe(true)
    expect(cli.pending[0].aborted).toBe(false)
    await act(async () => { await cli.complete("CLI 第一轮答案", 0) })
    expect(useChatStore.getState().messages.filter((message) => message.role === "assistant")).toEqual([
      expect.objectContaining({ conversationId: first, content: "<think>CLI 思考</think>CLI 第一轮答案" }),
    ])
  })

  it("卸载面板时取消该面板的所有并发任务并释放事件监听", async () => {
    useChatStore.getState().createConversation()
    await act(async () => { panel = create(<ChatPanel />) })
    await send("问题一")
    await act(async () => { useChatStore.getState().createConversation() })
    await send("问题二")
    expect(backend.listeners.size).toBe(2)
    await act(async () => { panel!.unmount() })
    panel = undefined
    expect(useChatStore.getState().conversationStreams).toEqual({})
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(backend.listeners.size).toBe(0)
    expect(backend.invoke.mock.calls.filter(([command]) => command === "agent_cancel_turn")).toHaveLength(2)
  })
})
