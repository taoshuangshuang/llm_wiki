/** 独立检查的材料与结果协议；不携带入库任务、审阅 UI 或持久化状态。 */
import type { LlmConfig } from "@/stores/wiki-store"
import type { ReviewEvidence } from "@/stores/review-store"
import type { CodeConflictAnalysis } from "../code-conflict-types"

/** 诊断接收器由执行入口注入；检查不依赖日志文件或入库日志实例。 */
export interface ReviewCheckLog { record: (event: string, data?: unknown, stage?: string) => void }

/** 正文及其固定版本、位置；片段必须保留在原文中的真实行号。 */
export interface ReviewMaterial extends ReviewEvidence {
  id: string
  role?: "source" | "before" | "page" | "related"
}
/** 检查发现的事实问题；事项身份、人工状态与操作按钮由执行入口补充。 */
export interface ReviewFinding {
  type: "contradiction" | "duplicate" | "suggestion"
  title: string
  description: string
  subtype?: string
  risk?: string
  evidence: ReviewEvidence[]
  affectedPages: string[]
  codeAnalysis?: CodeConflictAnalysis
}
export type ReviewCheckScope = Omit<ReviewMaterial, "text">

export interface ReviewCheckResult<TIssue> {
  status: "complete" | "partial" | "incomplete" | "cancelled" | "failed"
  issues: TIssue[]
  /** 已执行检查所消费的范围；是否全部核验完成须同时判断 status。 */
  checkedScope: ReviewCheckScope[]
  reason?: string
  /** 已有逐字证据但适用条件无法核实的事项，调用方转人工确认；存在待确认事项不代表执行未完成。 */
  pending?: TIssue[]
}

/** 格式与覆盖问题兼容原验收协议，报告转换由各执行入口负责。 */
export interface PageCheckIssue {
  kind: "structure" | "coverage"
  /** 缺失引用只转人工，不能在格式阶段通过模型生成占位页。 */
  manual?: boolean
  description: string
  sourceEvidence: string
  pageEvidence: string
  pages: string[]
}

export interface KnowledgeCheckOptions {
  materials: ReviewMaterial[]
  policy: string
  llmConfig: LlmConfig
  outputLanguage: string
  signal?: AbortSignal
  /** 调用方补充项目用途、检索覆盖范围等信息，不代替正文证据。 */
  context?: Record<string, unknown>
  task?: string
  checkId?: string
  processLog?: ReviewCheckLog
  /** 本次目标页；其他材料仅作对照，问题必须有目标页的正文证据。 */
  targetPaths?: string[]
}

/** 将实际消费的材料投影为检查范围，不复制整段正文到结果中。 */
export function materialScope({ text: _text, ...scope }: ReviewMaterial): ReviewCheckScope { return scope }

/** 失败保留已获得的问题；取消、未完成均不能作为“未发现问题”。 */
export function failureResult<T>(error: unknown, issues: T[], checkedScope: ReviewCheckScope[], signal?: AbortSignal): ReviewCheckResult<T> {
  const cancelled = signal?.aborted || error instanceof DOMException && error.name === "AbortError"
  return {
    status: cancelled ? "cancelled" : checkedScope.length ? "partial" : "incomplete",
    issues, checkedScope,
    reason: error instanceof Error ? error.message : String(error),
  }
}

/** 只处理内容页面；聚合导航由应用维护，不作为原文覆盖证据。 */
export function isReviewContentPath(path: string): boolean {
  return path.startsWith("wiki/") && path.endsWith(".md") &&
    !/[\\\x00-\x1f]/.test(path) &&
    path.split("/").every((part) => part !== ".." && part !== "." && part !== "") &&
    !["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(path)
}
