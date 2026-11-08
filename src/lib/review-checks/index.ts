/** 四项独立检查的公共入口；各调用方负责组装材料、执行修复并保存报告。 */
export { checkFormat } from "./format"
export { checkCoverage, type CoverageCheckOptions, type CoverageCheckResult } from "./coverage"
export { checkKnowledge, type ExistingKnowledgeCheckOptions } from "./knowledge"
export { checkSupplements } from "./supplement"
export { prepareReviewMaterials, reviewPageIntroduction, type PrepareReviewOptions } from "./prepare"
export type { KnowledgeCheckOptions, PageCheckIssue, ReviewMaterial, ReviewFinding, ReviewCheckResult, ReviewCheckScope, ReviewCheckLog } from "./types"
export { PENDING_MARKER, SUPPLEMENT_MARKER, findPendingSections, pendingMarkerFindings, type MarkerKind } from "./pending-marker"
