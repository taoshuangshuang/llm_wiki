import { create } from "zustand"

interface ReviewChatState {
  session: { projectPath: string; conversationId: string } | null
  open: (projectPath: string, conversationId: string) => void
  close: () => void
}

/** 只保存右侧面板的临时状态；会话及条目关联由聊天历史持久化。 */
export const useReviewChatStore = create<ReviewChatState>((set) => ({
  session: null,
  open: (projectPath, conversationId) => set({ session: { projectPath, conversationId } }),
  close: () => set({ session: null }),
}))
