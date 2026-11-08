import type { CodeEvidence, CodeEvidenceResult } from "@/commands/code-evidence"

/** 源码分析作为冲突事项的附加证据，人工处理状态独立保存。 */
export interface CodeConflictAnalysis {
  status: "complete" | "inconclusive" | "failed" | "stale"
  summary: string
  checkedAt: number
  configurationRevision?: string
  repositories: Pick<CodeEvidenceResult, "repository" | "commit" | "branch" | "dirty" | "notes">[]
  evidence: (CodeEvidence & { id: string; repository: string; commit: string })[]
  findings: { description: string; citations: { id: string; quote: string }[] }[]
}
