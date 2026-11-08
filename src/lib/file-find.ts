/** 文件内按字面量查找，忽略大小写；返回原文偏移，供阅读和源码模式共用。 */
export function findTextMatches(text: string, query: string): { start: number; end: number }[] {
  if (!query) return []
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return Array.from(text.matchAll(new RegExp(escaped, "giu")), (match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }))
}

/** 跨行内标签建立 Range，不修改 React 管理的 DOM，避免破坏链接和选区编辑。 */
export function findDocumentRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const groups: { block: Element | null; nodes: Text[]; text: string }[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const parent = node.parentElement
    if (!parent || parent.closest('button, script, style, textarea, [hidden], [aria-hidden="true"], .katex-mathml')) continue
    const block = parent.closest("p, li, h1, h2, h3, h4, h5, h6, pre, td, th, text, foreignObject")
    let group = groups[groups.length - 1]
    if (!group || group.block !== block) {
      group = { block, nodes: [], text: "" }
      groups.push(group)
    }
    group.nodes.push(node)
    group.text += node.data
  }
  return groups.flatMap(({ nodes, text }) => findTextMatches(text, query).map(({ start, end }) => {
    const range = document.createRange()
    let offset = 0
    let started = false
    for (const node of nodes) {
      const next = offset + node.length
      if (!started && start < next) {
        range.setStart(node, start - offset)
        started = true
      }
      if (started && end <= next) {
        range.setEnd(node, end - offset)
        break
      }
      offset = next
    }
    return range
  }))
}
