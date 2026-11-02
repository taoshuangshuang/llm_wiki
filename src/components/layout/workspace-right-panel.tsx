import { useEffect } from "react"
import { X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ChatPanel } from "@/components/chat/chat-panel"
import { useChatStore } from "@/stores/chat-store"
import { useReviewChatStore } from "@/stores/review-chat-store"

/** 右侧空间仅呈现条目对应的审阅会话。 */
export function WorkspaceRightPanel({ conversationId, visible = true }: { conversationId?: string; visible?: boolean }) {
  const { t } = useTranslation()
  const close = useReviewChatStore((state) => state.close)

  useEffect(() => {
    // 隐藏期间允许主聊天切换会话，重新展示时恢复条目对应的审阅会话。
    if (visible && conversationId) useChatStore.getState().setActiveConversation(conversationId)
  }, [conversationId, visible])

  if (!conversationId) return null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b px-2 py-2">
        <span className="px-2 text-xs font-medium">{t("review.conversationTab")}</span>
        <button type="button" onClick={close} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label={t("review.closePanel")}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ChatPanel compact />
      </div>
    </div>
  )
}
