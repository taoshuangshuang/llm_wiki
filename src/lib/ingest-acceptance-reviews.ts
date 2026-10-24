/** 将写入后的结构、覆盖问题转为待审阅项，兼容历史验收报告。 */
import type { AcceptanceReport } from "./ingest-acceptance"
import type { ReviewItem } from "@/stores/review-store"

export const INGEST_REVIEWED_ACTION = "已审阅"

export function acceptanceFailureReviews(
  sourcePath: string,
  report: AcceptanceReport,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const lastRound = report.rounds[report.rounds.length - 1]
  // 兼容历史报告，旧版 conflict 项不属于结构或覆盖验收问题。
  const issues = (lastRound?.issues ?? []).filter((issue) => issue.kind === "structure" || issue.kind === "coverage")
  const reviews: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = issues.map((issue) => ({
    type: issue.kind,
    title: `入库审阅：${report.sourceIdentity}：${issue.description}`,
    description: `${issue.description}\n\n来源依据：${issue.sourceEvidence || "见原始来源"}\n\n页面依据：${issue.pageEvidence || "见受影响页面及审阅报告"}\n\n请核对原文和相关页面，可发起会话补充证据或处理意见，完成后确认已审阅。`,
    sourcePath,
    affectedPages: issue.pages,
    options: [{ label: INGEST_REVIEWED_ACTION, action: INGEST_REVIEWED_ACTION }],
  }))
  // 检查未完成不等于页面结构错误，使用既有“待确认”类型提示人工核查。
  if (report.error) reviews.push({
    type: "confirm",
    title: `入库审阅：${report.sourceIdentity}：${report.error}`,
    description: `自动审阅未完成：${report.error}\n\n请核对原文和已写入页面的结构及内容覆盖，完成后确认已审阅。`,
    sourcePath,
    options: [{ label: INGEST_REVIEWED_ACTION, action: INGEST_REVIEWED_ACTION }],
  })
  return reviews
}
