import { AlertTriangle, Copy, FileQuestion, ListChecks, Lightbulb, MessageSquare, ScanText } from "lucide-react"
import type { ReviewItem } from "@/stores/review-store"

/** 审阅卡片与会话共用类型图标和颜色，并声明需要置顶的审阅类型。 */
export const reviewTypeConfig: Record<ReviewItem["type"], { icon: typeof AlertTriangle; color: string; pinned?: boolean }> = {
  contradiction: { icon: AlertTriangle, color: "text-amber-500", pinned: true },
  duplicate: { icon: Copy, color: "text-blue-500" },
  "missing-page": { icon: FileQuestion, color: "text-purple-500" },
  confirm: { icon: MessageSquare, color: "text-foreground" },
  suggestion: { icon: Lightbulb, color: "text-emerald-500" },
  structure: { icon: ListChecks, color: "text-orange-500", pinned: true },
  coverage: { icon: ScanText, color: "text-cyan-600", pinned: true },
}
