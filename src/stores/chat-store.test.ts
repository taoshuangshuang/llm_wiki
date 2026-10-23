import { beforeEach, describe, expect, it } from "vitest"
import { useChatStore } from "./chat-store"

describe("chat-store conversation isolation", () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [],
      activeConversationId: null,
      messages: [],
      isStreaming: false,
      streamingContent: "",
      conversationStreams: {},
      mode: "chat",
      ingestSource: null,
      useWebSearch: false,
      useAnyTxtSearch: false,
      agentMode: "standard",
      retrievalMode: "standard",
      selectedSkills: [],
      selectedContextFiles: [],
      disabledSkills: [],
    })
  })

  it("defaults to standard retrieval and allows explicit retrieval modes", () => {
    expect(useChatStore.getState().retrievalMode).toBe("standard")
    useChatStore.getState().setRetrievalMode("smart")
    expect(useChatStore.getState().retrievalMode).toBe("smart")
    useChatStore.getState().setRetrievalMode("faithful")
    expect(useChatStore.getState().retrievalMode).toBe("faithful")
  })

  it("keeps two conversations generating independently when tokens and completion interleave", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().setStreaming(true, first)
    useChatStore.getState().appendStreamToken("<think>会话一", first)

    // 新建另一个会话不能停止已经运行的任务。
    const second = useChatStore.getState().createConversation()
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingContent).toBe("")
    useChatStore.getState().setStreaming(true, second)
    useChatStore.getState().appendStreamToken("会话二回答", second)
    useChatStore.getState().appendStreamToken("继续思考", first)
    expect(useChatStore.getState().streamingContent).toBe("会话二回答")

    useChatStore.getState().setActiveConversation(first)
    expect(useChatStore.getState().streamingContent).toBe("<think>会话一继续思考")
    useChatStore.getState().setActiveConversation(second)

    // 后台任务完成不能清空前台任务的缓存或关闭其生成状态。
    useChatStore.getState().finalizeStreamForConversation(first, "<think>会话一继续思考</think>会话一回答")
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingContent).toBe("会话二回答")
    useChatStore.getState().finalizeStreamForConversation(second, "会话二回答")
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().getActiveMessages().map((message) => message.content)).toEqual(["会话二回答"])
  })

  it("deleting a generating conversation does not clear another conversation or resurrect deleted messages", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().setStreaming(true, first)
    const second = useChatStore.getState().createConversation()
    useChatStore.getState().setStreaming(true, second)
    useChatStore.getState().appendStreamToken("保留第二个会话", second)

    useChatStore.getState().deleteConversation(first)
    // 已删除请求的延迟输出与完成回调不能重新创建消息，也不能结束另一个流。
    useChatStore.getState().appendStreamToken("延迟输出", first)
    useChatStore.getState().finalizeStreamForConversation(first, "延迟完成")
    expect(useChatStore.getState().conversationStreams[first]).toBeUndefined()
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingContent).toBe("保留第二个会话")
    expect(useChatStore.getState().messages).toEqual([])
  })

  it("writes async assistant results back to the original conversation", () => {
    const store = useChatStore.getState()
    const first = store.createConversation()
    store.addMessageToConversation(first, "user", "first question")

    const second = useChatStore.getState().createConversation()
    expect(useChatStore.getState().activeConversationId).toBe(second)

    useChatStore
      .getState()
      .finalizeStreamForConversation(first, "first answer")

    const state = useChatStore.getState()
    const firstMessages = state.messages.filter((message) => message.conversationId === first)
    const secondMessages = state.messages.filter((message) => message.conversationId === second)

    expect(firstMessages.map((message) => message.content)).toEqual([
      "first question",
      "first answer",
    ])
    expect(secondMessages).toEqual([])
  })

  it("clears stale stream content when a new stream starts", () => {
    useChatStore.setState({
      streamingContent: "old conversation tokens",
      isStreaming: false,
    })

    useChatStore.getState().setStreaming(true)

    expect(useChatStore.getState().streamingContent).toBe("")
    expect(useChatStore.getState().isStreaming).toBe(true)
  })

  it("creates globally unique message ids across conversations", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().addMessageToConversation(first, "user", "first")

    const second = useChatStore.getState().createConversation()
    useChatStore.getState().addMessageToConversation(second, "user", "second")

    const ids = useChatStore.getState().messages.map((message) => message.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("restores the complete thinking stream after switching away and back", () => {
    const first = useChatStore.getState().createConversation()
    const second = useChatStore.getState().createConversation()
    useChatStore.getState().setActiveConversation(first)
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().appendStreamToken("<think>正在分析第一部分")

    // 切换时不应丢失已经接收的思考内容；后台继续收到的增量也应保留。
    useChatStore.getState().setActiveConversation(second)
    useChatStore.getState().setActiveConversation(first)
    expect(useChatStore.getState().streamingContent).toBe("<think>正在分析第一部分")

    useChatStore.getState().setActiveConversation(second)
    useChatStore.getState().appendStreamToken("，继续分析第二部分", first)
    useChatStore.getState().setActiveConversation(first)

    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingContent).toBe("<think>正在分析第一部分，继续分析第二部分")
  })

  it("keeps thinking and the final answer in the original conversation when it finishes in the background", () => {
    const first = useChatStore.getState().createConversation()
    const second = useChatStore.getState().createConversation()
    useChatStore.getState().setActiveConversation(first)
    useChatStore.getState().setStreaming(true)
    useChatStore.getState().appendStreamToken("<think>正在分析")

    // 用户停留在另一个会话时完成生成，最终消息仍应写回原会话。
    useChatStore.getState().setActiveConversation(second)
    const response = "<think>正在分析，分析完成</think>最终回答"
    useChatStore.getState().finalizeStreamForConversation(first, response)
    expect(useChatStore.getState().getActiveMessages()).toEqual([])

    useChatStore.getState().setActiveConversation(first)
    expect(useChatStore.getState().getActiveMessages()).toEqual([
      expect.objectContaining({ role: "assistant", content: response }),
    ])
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("removes the last assistant message only from the active conversation", () => {
    useChatStore.setState({
      conversations: [
        { id: "c1", title: "One", createdAt: 1, updatedAt: 1 },
        { id: "c2", title: "Two", createdAt: 2, updatedAt: 2 },
      ],
      activeConversationId: "c2",
      messages: [
        { id: "same", conversationId: "c1", role: "assistant", content: "keep", timestamp: 1 },
        { id: "same", conversationId: "c2", role: "assistant", content: "remove", timestamp: 2 },
      ],
    })

    useChatStore.getState().removeLastAssistantMessage()

    expect(useChatStore.getState().messages).toEqual([
      { id: "same", conversationId: "c1", role: "assistant", content: "keep", timestamp: 1 },
    ])
  })

  it("clears stale stream content when creating a conversation or switching while idle", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.setState({
      streamingContent: "old conversation tokens",
      isStreaming: true,
    })

    const second = useChatStore.getState().createConversation()

    expect(useChatStore.getState().activeConversationId).toBe(second)
    expect(useChatStore.getState().streamingContent).toBe("")
    expect(useChatStore.getState().isStreaming).toBe(false)

    useChatStore.setState({
      streamingContent: "more stale tokens",
      isStreaming: false,
    })
    useChatStore.getState().setActiveConversation(first)

    expect(useChatStore.getState().activeConversationId).toBe(first)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("stores selected skills per conversation and starts new conversations empty", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().setSelectedSkills(["cover-image"])

    const second = useChatStore.getState().createConversation()

    expect(useChatStore.getState().activeConversationId).toBe(second)
    expect(useChatStore.getState().selectedSkills).toEqual([])

    useChatStore.getState().setSelectedSkills(["ppt"])
    useChatStore.getState().setActiveConversation(first)

    expect(useChatStore.getState().selectedSkills).toEqual(["cover-image"])

    useChatStore.getState().setActiveConversation(second)

    expect(useChatStore.getState().selectedSkills).toEqual(["ppt"])
  })

  it("stores selected context files per conversation and starts new conversations empty", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().setSelectedContextFiles(["wiki/overview.md"])

    const second = useChatStore.getState().createConversation()
    expect(useChatStore.getState().selectedContextFiles).toEqual([])

    useChatStore.getState().setSelectedContextFiles(["raw/sources/source.txt"])
    useChatStore.getState().setActiveConversation(first)
    expect(useChatStore.getState().selectedContextFiles).toEqual(["wiki/overview.md"])

    useChatStore.getState().setActiveConversation(second)
    expect(useChatStore.getState().selectedContextFiles).toEqual(["raw/sources/source.txt"])
  })

  it("stores the context file snapshot on the user message", () => {
    const conversationId = useChatStore.getState().createConversation()
    useChatStore.getState().addMessageToConversation(
      conversationId,
      "user",
      "summarize this",
      [],
      ["/project/wiki/overview.md"],
    )

    expect(useChatStore.getState().messages[0].contextFiles).toEqual([
      "/project/wiki/overview.md",
    ])
  })
})
