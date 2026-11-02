import type { WikiState } from "@/stores/wiki-store"
import { isStandaloneView } from "./standalone-view"

export function getAppLayoutVisibility(
  activeView: WikiState["activeView"],
  reviewConversationOpen = false,
  previewReturnView?: WikiState["previewReturnView"],
): { showLeftPanel: boolean; hasRightPanel: boolean } {
  const isStandalone = isStandaloneView(activeView) || (activeView === "wiki" && previewReturnView === "sources")
  return {
    showLeftPanel: !isStandalone,
    hasRightPanel: !isStandalone && reviewConversationOpen,
  }
}
