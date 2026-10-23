import { useEffect } from "react"
import { X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ChatPanel } from "@/components/chat/chat-panel"
import { useChatStore } from "@/stores/chat-store"
import { useResearchStore } from "@/stores/research-store"
import { useReviewChatStore } from "@/stores/review-chat-store"
import { ResearchPanel } from "./research-panel"

/** 共用右侧空间；切换标签只隐藏内容，不中断聊天或研究任务。 */
export function WorkspaceRightPanel({ conversationId }: { conversationId?: string }) {
  const { t } = useTranslation()
  const activeTab = useReviewChatStore((state) => state.activeTab)
  const setActiveTab = useReviewChatStore((state) => state.setActiveTab)
  const close = useReviewChatStore((state) => state.close)
  const setResearchOpen = useResearchStore((state) => state.setPanelOpen)
  const showConversation = Boolean(conversationId && activeTab === "review")

  useEffect(() => {
    if (conversationId) {
      useChatStore.getState().setActiveConversation(conversationId)
    }
  }, [conversationId])

  if (!conversationId) return <ResearchPanel />
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-2">
        <div className="flex min-w-0 flex-1 gap-1" role="tablist" aria-label={t("review.panelTabs")}>
          <button type="button" role="tab" aria-selected={showConversation} aria-controls="review-conversation-panel" id="review-conversation-tab" onClick={() => setActiveTab("review")} className={`rounded px-2 py-1 text-xs ${showConversation ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent"}`}>
            {t("review.conversationTab")}
          </button>
          <button type="button" role="tab" aria-selected={!showConversation} aria-controls="review-research-panel" id="review-research-tab" onClick={() => { setResearchOpen(true); setActiveTab("research") }} className={`rounded px-2 py-1 text-xs ${!showConversation ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent"}`}>
            {t("research.title")}
          </button>
        </div>
        <button type="button" onClick={() => { close(); setResearchOpen(false) }} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label={t("review.closePanel")}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className={`min-h-0 flex-1 ${showConversation ? "" : "hidden"}`} role="tabpanel" id="review-conversation-panel" aria-labelledby="review-conversation-tab">
        <ChatPanel compact />
      </div>
      <div className={`min-h-0 flex-1 ${showConversation ? "hidden" : ""}`} role="tabpanel" id="review-research-panel" aria-labelledby="review-research-tab">
        <ResearchPanel embedded />
      </div>
    </div>
  )
}
