/** 正文改动与事实覆盖分开记录；无变更也有可审阅、可失效的页面依据。 */
export interface IngestResult {
  outcome: "written" | "unchanged"
  writtenPaths: string[]
  coveredPaths: string[]
}

/** 只有显式无变更标记才能表示成功，空响应不能代替该结果。 */
export function parseUnchangedPaths(output: string): string[] {
  const paths = new Set<string>()
  let block: "file" | "review" | null = null
  let fence: string | null = null
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    if (block) {
      if (block === "file" && /^---\s*END\s+FILE\s*---\s*$/i.test(line) ||
          block === "review" && /^---\s*END\s+REVIEW\s*---\s*$/i.test(line)) block = null
      continue
    }
    if (/^---\s*FILE:.*---\s*$/i.test(line)) { block = "file"; continue }
    if (/^---\s*REVIEW:.*---\s*$/i.test(line)) { block = "review"; continue }
    const unchanged = line.match(/^---UNCHANGED:[ \t]*([^\r\n]+?)[ \t]*---[ \t]*$/)
    if (unchanged) paths.add(unchanged[1].trim())
  }
  return [...paths]
}
