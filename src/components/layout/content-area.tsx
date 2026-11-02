import { ImportProcessView } from "@/components/sources/import-process-view"
import { useEffect, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { ChatPanel } from "@/components/chat/chat-panel"
import { WorkflowSettingsView } from "@/components/settings/workflow/workflow-settings-view"
import { SettingsView } from "@/components/settings/settings-view"
import { SkillsSection } from "@/components/settings/sections/skills-section"
import { SourcesView } from "@/components/sources/sources-view"
import { ReviewView } from "@/components/review/review-view"
import { LintView } from "@/components/lint/lint-view"
import { KnowledgeWorkspace } from "./knowledge-workspace"
import { GraphView } from "@/components/graph/graph-view"
import { PreviewPanel } from "./preview-panel"

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)

  // Keep SourcesView mounted after its first visit. Opening a source uses the
  // full-width wiki preview, and unmounting the source tree here would discard
  // its scroll position, expanded folders, and incremental row limit. Hiding
  // the mounted view makes closing the preview a true return operation.
  const [hasMountedSources, setHasMountedSources] = useState(activeView === "sources")
  // 页签切换只隐藏聊天；真正卸载或切换项目时仍由 ChatPanel 释放请求。
  const [hasMountedChat, setHasMountedChat] = useState(activeView === "chat")

  useEffect(() => {
    if (activeView === "sources") setHasMountedSources(true)
    if (activeView === "chat") setHasMountedChat(true)
  }, [activeView])

  // Include the current view directly so the first navigation to Sources does
  // not wait for the effect above and briefly render an empty content area.
  // 首次进入时立即渲染，并保持各视图的位置固定，避免首次打开来源页
  // 改变组件树结构而重建聊天，进而取消仍在生成的任务。
  return (
    <>
      {(hasMountedChat || activeView === "chat") && (
        <div key="chat" className={activeView === "chat" ? "h-full" : "hidden"}>
          <ChatPanel />
        </div>
      )}
      {(hasMountedSources || activeView === "sources") && (
        <div key="sources" className={activeView === "sources" ? "h-full" : "hidden"}>
          <SourcesView />
        </div>
      )}
      {activeView !== "chat" && activeView !== "sources" && (
        <ActiveContent key="active" activeView={activeView} />
      )}
    </>
  )
}

function ActiveContent({
  activeView,
}: {
  activeView: ReturnType<typeof useWikiStore.getState>["activeView"]
}) {
  switch (activeView) {
    case "chat":
      return null
    case "wiki":
    case "search":
      return <KnowledgeWorkspace />
    case "workflow":
      return <WorkflowSettingsView />
    case "settings":
      return <SettingsView />
    case "skills":
      return <SkillsView />
    case "sources":
      return null
    case "imports":
      return <ImportProcessView />
    case "review":
      return <ReviewView />
    case "lint":
      return <LintView />
    case "graph":
      return <GraphView />
    default:
      return <PreviewPanel />
  }
}

function SkillsView() {
  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-3xl">
        <SkillsSection />
      </div>
    </div>
  )
}
