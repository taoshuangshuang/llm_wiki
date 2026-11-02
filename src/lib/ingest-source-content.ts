/** 只过滤可确定没有正文的来源；不按字数、语言或主题判断知识价值。 */
export interface IngestSourceSkip {
  reason: "empty" | "headings-only" | "placeholder-only" | "structure-only"
  message: string
}

/** 标题、注释和排版结构不算正文；图片、链接、代码和数字数据保留后续分析机会。 */
export function assessIngestSource(content: string, sourcePath: string): IngestSourceSkip | undefined {
  const normalized = content.replace(/\r\n?/g, "\n").replace(/\p{Cf}/gu, "").trim()
  if (!normalized) return { reason: "empty", message: "来源内容为空或仅含空白字符" }
  const body = normalized
    .replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
  // 图片本身可能承载图表或扫描内容，不能仅因缺少文字而跳过。
  if (/!\[[^\]]*\]\(\s*\S|!\[[^\]]*\]\[[^\]]*\]|<(?:img|video|audio|svg)\b/i.test(body)) return undefined

  const lines = body.split("\n")
  const text: string[] = []
  let hasHeading = false
  let fence: string | undefined
  let hasCode = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/^\s*(?:>\s*)+/, "").trim()
    const delimiter = line.match(/^(`{3,}|~{3,})/)
    if (delimiter && (!fence || (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^(`+|~+)\s*$/.test(line)))) {
      fence = fence ? undefined : delimiter[1]
      continue
    }
    if (fence) {
      text.push(line)
      hasCode ||= /[\p{L}\p{N}]/u.test(line)
      continue
    }
    if (/^#{1,6}(?:\s|$)/.test(line) || /^<h[1-6]\b/i.test(line)) {
      hasHeading = true
      continue
    }
    if (/[\p{L}\p{N}]/u.test(line) && /^\s*(?:=+|-+)\s*$/.test(lines[index + 1] ?? "")) {
      hasHeading = true
      index++
      continue
    }
    text.push(line
      .replace(/<\/?[a-z][\w-]*(?:\s[^>]*|\/?)>/gi, "")
      .replace(/&(?:nbsp|ensp|emsp|thinsp|ZeroWidthSpace|#0*160|#x0*a0);/gi, " ")
      .replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, ""))
  }
  const remainder = text.join("\n").trim()
  const title = sourcePath.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "")
  if (!hasCode && remainder && !remainder.includes("\n") && remainder === title) {
    return { reason: "headings-only", message: "来源仅含标题，没有正文内容" }
  }
  const bodyLines = text.filter((line) => /[\p{L}\p{N}]/u.test(line))
  if (!hasCode && bodyLines.length && bodyLines.every((line) => /^(?:TODO|TBD|待补充|待完善|暂无内容|此处待补充)[\s.!！。…]*$/i.test(line))) {
    return { reason: "placeholder-only", message: "来源仅含待补充等占位内容" }
  }
  if (/[\p{L}\p{N}]/u.test(remainder)) return undefined
  return hasHeading
    ? { reason: "headings-only", message: "来源仅含标题和排版符号，没有正文内容" }
    : { reason: "structure-only", message: "来源仅含符号、注释或空的排版结构，没有正文内容" }
}
