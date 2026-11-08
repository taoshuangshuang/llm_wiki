/** 有界、只读的源码检索命令，仓库授权由后端核对已保存的项目绑定。 */
import { invoke } from "@tauri-apps/api/core"

export interface CodeEvidence {
  path: string
  revision: string
  startLine: number
  endLine: number
  text: string
  via: string
}
export interface CodeEvidenceResult {
  repository: string
  commit: string
  branch: string
  dirty: boolean
  configRevision: string
  evidence: CodeEvidence[]
  notes: string[]
}
export function collectCodeEvidence(projectPath: string, repository: string, queries: string[], paths: string[]): Promise<CodeEvidenceResult> {
  return invoke("collect_code_evidence", { projectPath, repository, queries, paths })
}
export function verifyCodeEvidence(projectPath: string, result: CodeEvidenceResult): Promise<boolean> {
  return invoke("verify_code_evidence", {
    projectPath, repository: result.repository, commit: result.commit,
    configRevision: result.configRevision, evidence: result.evidence,
  })
}
