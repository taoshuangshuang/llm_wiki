import { invoke } from "@tauri-apps/api/core"

export interface FileChangeProposal {
  id: string
  path: string
  original: string
  proposed: string | null
  source: string
  createdAt: number
  status: "pending" | "approved" | "rejected"
  reviewedAt: number | null
}

export interface FileApprovalState {
  importantPaths: string[]
  proposals: FileChangeProposal[]
}

export function getFileApprovals(projectPath: string): Promise<FileApprovalState> {
  return invoke("get_file_approvals", { projectPath })
}

export function setImportantFile(projectPath: string, filePath: string, important: boolean): Promise<void> {
  return invoke("set_important_file", { projectPath, filePath, important })
}

export function reviewFileChange(projectPath: string, proposalId: string, approve: boolean): Promise<void> {
  return invoke("review_file_change", { projectPath, proposalId, approve })
}

/** 人工在原文编辑器中输入的内容使用独立入口，模型写入仍经过审核。 */
export function saveHumanFile(path: string, contents: string): Promise<void> {
  return invoke("save_human_file", { path, contents })
}

/** 移动草稿只绑定一个目标路径；界面必须展示为移动，不能用删除差异误导审批者。 */
export function proposalMoveTarget(item: FileChangeProposal): string | null {
  const prefix = "wiki.move_page:"
  return item.proposed === null && item.source.startsWith(prefix) ? item.source.slice(prefix.length) : null
}
