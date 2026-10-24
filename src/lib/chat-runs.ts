import { useChatStore } from "@/stores/chat-store"

/** 一次会话请求的身份与取消信号，不随用户切换会话而改变。 */
export interface ChatRun {
  conversationId: string
  runId: string
  controller: AbortController
}

/** 管理一个聊天面板拥有的请求；不同会话可并发，同一会话只允许一轮生成。 */
export class ChatRunRegistry {
  private readonly runs = new Map<string, ChatRun>()

  constructor(private readonly cancelBackend: (run: ChatRun) => void) {}

  /** 原子地登记请求并打开所属会话的流，重复发送返回空值。 */
  start(conversationId: string): ChatRun | null {
    const state = useChatStore.getState()
    if (state.conversationStreams[conversationId]
      || !state.conversations.some((conversation) => conversation.id === conversationId)) return null
    const run: ChatRun = {
      conversationId,
      runId: `ui-${crypto.randomUUID()}`,
      controller: new AbortController(),
    }
    this.runs.set(conversationId, run)
    state.setStreaming(true, conversationId, run.runId)
    return run
  }

  /** 已停止、已删除或已被新请求替代的回调不能再修改会话。 */
  isCurrent(run: ChatRun): boolean {
    return this.runs.get(run.conversationId) === run
      && !run.controller.signal.aborted
      && useChatStore.getState().conversationStreams[run.conversationId]?.runId === run.runId
  }

  /** 仅释放本轮拥有的状态，旧请求的收尾不能清除后续重试。 */
  finish(run: ChatRun): void {
    if (this.runs.get(run.conversationId) !== run) return
    this.runs.delete(run.conversationId)
    if (useChatStore.getState().conversationStreams[run.conversationId]?.runId === run.runId) {
      useChatStore.getState().setStreaming(false, run.conversationId)
    }
  }

  /** 同时取消对应会话的前端流与后端任务。 */
  cancel(conversationId: string): void {
    const run = this.runs.get(conversationId)
    if (!run) return
    this.finish(run)
    run.controller.abort()
    this.cancelBackend(run)
  }

  /** 面板卸载或切换项目时，释放该面板拥有的全部请求。 */
  cancelAll(): void {
    for (const conversationId of this.runs.keys()) this.cancel(conversationId)
  }
}
