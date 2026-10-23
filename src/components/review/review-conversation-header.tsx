import { CheckCircle2, FileText } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { confirmReviewConversationResolved, reviewContextFiles } from "@/lib/review-chat"
import { reviewTypeConfig } from "@/components/review/review-type-config"

/** 会话顶部展示核查目标；由用户明确确认条目已处理。 */
export function ReviewConversationHeader({ projectPath, conversationId, onOpenFile }: {
  projectPath: string
  conversationId: string
  onOpenFile: (path: string) => void
}) {
  const { t } = useTranslation()
  const snapshot = useChatStore((state) => state.conversations.find((conversation) => conversation.id === conversationId)?.reviewContext)
  const isStreaming = useChatStore((state) => Boolean(state.conversationStreams[conversationId]))
  const item = useReviewStore((state) => state.items.find((review) => review.id === snapshot?.id))
  const context = item ?? snapshot
  if (!context) return null
  const files = reviewContextFiles(projectPath, context)
  const config = reviewTypeConfig[context.type]
  const Icon = config.icon

  return (
    <div className="shrink-0 space-y-2 border-b bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} aria-hidden="true" />
          {t(`review.types.${context.type}`)}
          <span className="text-muted-foreground">· {t(item?.resolved ? "review.resolvedStatus" : item ? "review.pendingStatus" : "review.removedStatus")}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={!item || item.resolved || isStreaming}
          onClick={() => confirmReviewConversationResolved(projectPath, conversationId, t("review.resolvedFromConversation", { id: conversationId }))}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t(item?.resolved ? "review.resolvedStatus" : "review.confirmResolved")}
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer break-words text-[13px] leading-5 font-normal">{context.title}</summary>
        <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{context.description}</p>
        <div className="mt-2 flex flex-col gap-1">
          {files.map((path) => (
            <button key={path} type="button" onClick={() => onOpenFile(path)} className="flex min-w-0 items-center gap-1 text-left text-xs text-primary hover:underline" title={path}>
              <FileText className="h-3 w-3 shrink-0" /><span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      </details>
      <p className="text-[11px] text-muted-foreground">{t("review.conversationHint")}</p>
    </div>
  )
}
