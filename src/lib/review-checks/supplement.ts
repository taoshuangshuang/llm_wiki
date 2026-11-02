/** 知识补充检查：识别影响当前主题理解或使用的重要未知。 */
import { requestReviewIssues } from "./model"
import { failureResult, materialScope, type KnowledgeCheckOptions, type ReviewCheckResult, type ReviewFinding } from "./types"

/** 返回带正文依据的补充事项，不因检索无命中或没有独立概念页就认定缺失。 */
export async function checkSupplements(options: KnowledgeCheckOptions): Promise<ReviewCheckResult<ReviewFinding>> {
  try {
    options.signal?.throwIfAborted()
    if (!options.materials.length) throw new Error("没有可检查的正文材料")
    const issues = await requestReviewIssues(options, "suggestion", "核对必要的知识补充建议，合并同一未知；只报直接影响理解或使用的重要缺口；已标未知且无新关键影响证据时不重复报告")
    return { status: "complete", issues, checkedScope: options.materials.map(materialScope) }
  } catch (error) { return failureResult(error, [], [], options.signal) }
}
