import { create } from "zustand"

export type ReviewPanelTab = "review" | "research"

interface ReviewChatState {
  session: { projectPath: string; conversationId: string } | null
  activeTab: ReviewPanelTab
  open: (projectPath: string, conversationId: string) => void
  setActiveTab: (tab: ReviewPanelTab) => void
  close: () => void
}

/** 只保存右侧面板的临时状态；会话及条目关联由聊天历史持久化。 */
export const useReviewChatStore = create<ReviewChatState>((set) => ({
  session: null,
  activeTab: "review",
  open: (projectPath, conversationId) => set({ session: { projectPath, conversationId }, activeTab: "review" }),
  setActiveTab: (activeTab) => set({ activeTab }),
  close: () => set({ session: null, activeTab: "review" }),
}))
