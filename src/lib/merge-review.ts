import type { ReviewItem } from "@/stores/review-store"

/** 旧协议仅缺少结构化判断，这些兼容提示本身不能证明存在内容歧义。 */
export function isMergeProtocolNotice(reason: string): boolean {
  return ["旧合并返回未明确内容歧义，需后台复核", "旧合并协议未明确返回内容歧义判断"].includes(reason.trim())
}

/** 识别历史审阅中的协议提示，保留记录但不再把提示展示成已确认的风险。 */
export function isLegacyMergeNotice(item: Pick<ReviewItem, "type" | "description">): boolean {
  return item.type === "merge" && isMergeProtocolNotice(item.description)
}

/** 旧目标核对记录未保存原始响应时，明确可确认的失败边界，避免臆造具体冲突。 */
export function pageTargetFailureNote(description: string): string | undefined {
  const notes: Record<string, string> = {
    "页面主题核对未返回有效 JSON": "当时的模型响应无法解析为 JSON；未保存原始响应或解析错误，无法进一步区分空响应、格式错误等原因。",
    "页面主题核对未完整返回有效候选判断": "模型未为所有候选返回合法且唯一的判断；未保存原始响应或校验明细，无法确定具体遗漏或错误的候选。",
    "页面存在多个合并目标或主题无法确认": "当时可能有多个候选被判为同一主题，或至少一个候选无法确认；未保存逐项判断与理由，无法还原具体目标及分歧。",
    "页面主题核对响应被截断": "当时模型响应被截断；未保存截断的原始响应，无法还原完整判断。",
    "页面主题核对上下文容量不足，未截断正文或执行合并": "完整正文超过当时的上下文容量；未保存容量明细，无法还原具体超限数值。",
  }
  return notes[description]
}

/** 目标选择失败属于未完成核对，不能仅凭这类运行事件认定内容冲突。 */
export function isPageTargetFailure(description: string): boolean {
  return pageTargetFailureNote(description.split("\n", 1)[0]) !== undefined
}
