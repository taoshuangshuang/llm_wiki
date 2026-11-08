/** 正文中以固定标题标识的未决段落；程序扫描，不依赖模型判断。 */
import type { ReviewFinding, ReviewMaterial } from "./types"

/** 待确认：来源说法冲突、需人工裁决；待补充：信息缺失、需补齐资料。 */
export const PENDING_MARKER = "【待确认】"
export const SUPPLEMENT_MARKER = "【待补充】"
export type MarkerKind = "confirm" | "supplement"
const MARKERS: Record<MarkerKind, string> = { confirm: PENDING_MARKER, supplement: SUPPLEMENT_MARKER }
const HEADING = /^(#{1,6})\s+(.*)$/

export interface PendingSection { title: string; startLine: number; endLine: number; text: string }

/** 标题以标识开头的整节，至下一个同级或更高级标题为止；代码块内的行不当作标题。 */
export function findPendingSections(text: string, firstLine = 1, marker = PENDING_MARKER): PendingSection[] {
  const lines = text.split("\n")
  const sections: PendingSection[] = []
  const open: { level: number; title: string; start: number }[] = []
  let fenced = false
  const close = (end: number) => {
    const section = open.pop()
    if (!section) return
    while (end > section.start && !lines[end].trim()) end--
    sections.push({ title: section.title, startLine: firstLine + section.start, endLine: firstLine + end, text: lines.slice(section.start, end + 1).join("\n") })
  }
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = !fenced && HEADING.exec(line)
    if (!heading) return
    const level = heading[1].length
    while (open.length && level <= open[open.length - 1].level) close(index - 1)
    const title = heading[2].trim()
    if (title.startsWith(marker)) open.push({ level, title: title.slice(marker.length).trim() || `未命名${marker.slice(1, -1)}事项`, start: index })
  })
  while (open.length) close(lines.length - 1)
  return sections.sort((a, b) => a.startLine - b.startLine)
}

/** 每个标识段落生成一条发现，证据为整段原文；对照材料不扫描。 */
export function pendingMarkerFindings(materials: ReviewMaterial[], targetPaths?: string[], kind: MarkerKind = "confirm"): ReviewFinding[] {
  const marker = MARKERS[kind]
  return materials
    .filter((material) => material.role !== "related" && (!targetPaths || targetPaths.includes(material.path)))
    .flatMap((material) => findPendingSections(material.text, material.startLine, marker).map((section): ReviewFinding => ({
      ...(kind === "confirm"
        ? { type: "contradiction" as const, subtype: "待确认标识", title: `待确认：${section.title}`,
          description: `页面以「${marker}」标识了多来源说法不一致、尚未裁决的内容，需人工确认后统一并移除标识。` }
        : { type: "suggestion" as const, subtype: "待补充标识", title: `待补充：${section.title}`,
          description: `页面以「${marker}」标识了缺失或未说明的信息，需补齐资料后更新正文并移除标识。` }),
      evidence: [{ path: material.path, revision: material.revision, text: section.text, startLine: section.startLine, endLine: section.endLine, ...(material.snapshot ? { snapshot: material.snapshot } : {}) }],
      affectedPages: [material.path],
    })))
}

/** 模型发现的证据全部落在标识段落内时视为同一事项，避免重复报告。 */
export function insideMarkedSections(issue: ReviewFinding, marked: ReviewFinding[]): boolean {
  return issue.evidence.every((entry) => marked.some((finding) => finding.evidence[0].path === entry.path && finding.evidence[0].text.includes(entry.text)))
}
