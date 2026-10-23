/** Tauri 拒绝时可能返回字符串；统一识别后端的待审核结果。 */
export function isFileApprovalRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("FILE_APPROVAL_REQUIRED:")
}
