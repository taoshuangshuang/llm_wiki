import { MODEL_RULES } from "./model"
import type { ReviewMaterial } from "./types"

/** 大材料按连续正文分段，完整保留行号；容量不足会明确报错，不静默截尾。 */
export function reviewMaterialSegments(materials: ReviewMaterial[], maxContext: number | undefined, policyLength: number): ReviewMaterial[][] {
  const budget = Math.floor((maxContext ?? 128_000) - MODEL_RULES.length - policyLength - 12_000)
  if (budget < 2_000) throw new Error("审阅材料超出上下文预算，该检查未完成")
  if (JSON.stringify(materials).length <= budget) return [materials]
  const pieces: ReviewMaterial[] = []
  for (const material of materials) {
    const lines = material.text.split("\n")
    let offset = 0
    while (offset < lines.length) {
      let end = offset
      let length = 0
      while (end < lines.length && length + lines[end].length + 1 < budget / 3) length += lines[end++].length + 1
      if (end === offset) throw new Error(`页面单行超过审阅容量，未检查：${material.path}:${(material.startLine ?? 1) + offset}`)
      pieces.push({ ...material, id: `${material.id}:lines-${offset + 1}-${end}`, text: lines.slice(offset, end).join("\n"), startLine: (material.startLine ?? 1) + offset, endLine: (material.startLine ?? 1) + end - 1 })
      offset = end
    }
  }
  // 主页面与候选证据保持成对输入，不能把它们各放一段后声称已经比较过。
  const isPrimary = (entry: ReviewMaterial) => entry.role ? entry.role === "page" : entry.id.startsWith("after-")
  const primary = pieces.filter(isPrimary)
  const evidence = pieces.filter((entry) => !isPrimary(entry))
  // 大批次同时覆盖目标页之间的比较，不因分段只剩目标与对照的关系。
  const group = (entries: ReviewMaterial[]): ReviewMaterial[][] => {
    const groups: ReviewMaterial[][] = []
    let current: ReviewMaterial[] = []
    for (const entry of entries) {
      if (current.length && JSON.stringify([...current, entry]).length > budget / 2) { groups.push(current); current = [] }
      current.push(entry)
    }
    if (current.length) groups.push(current)
    return groups
  }
  const primaryGroups = group(primary), evidenceGroups = group(evidence)
  // 按容量组织组间比较，避免逐页配对造成大量重复请求；每对目标仍同处至少一个分段。
  const units = primaryGroups.flatMap((pages, index) => [
    pages, ...primaryGroups.slice(index + 1).map((entries) => [...pages, ...entries]), ...evidenceGroups.map((entries) => [...pages, ...entries]),
  ])
  const segments: ReviewMaterial[][] = []
  let current = new Map<string, ReviewMaterial>()
  for (const unit of units) {
    if (JSON.stringify(unit).length > budget) throw new Error("页面与证据对超出审阅容量，该关系未检查")
    const combined = new Map([...current, ...unit.map((entry): [string, ReviewMaterial] => [entry.id, entry])])
    if (current.size && JSON.stringify([...combined.values()]).length > budget) { segments.push([...current.values()]); current = new Map() }
    for (const entry of unit) current.set(entry.id, entry)
  }
  if (current.size) segments.push([...current.values()])
  return segments
}

