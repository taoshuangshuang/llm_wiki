/** 判断可计入入库结果的知识页；维护文件、来源摘要和不安全路径不计入。 */
export function isIngestKnowledgePath(path: string): boolean {
  return path.startsWith("wiki/") && /\.md$/i.test(path) &&
    !/[\\\x00-\x1f]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..") &&
    !/^wiki\/sources\//i.test(path) && !/(?:^|\/)(?:index|overview|log)\.md$/i.test(path)
}
