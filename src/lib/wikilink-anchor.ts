/**
 * Shared helpers for Obsidian-style `[[page#heading]]` targets.
 *
 * The split is always on the FIRST `#`: page titles containing `#`
 * are rare, while headings containing `#` (e.g. `C#`) are common
 * enough that splitting on the last one would corrupt them.
 */
export interface WikilinkTarget {
  /** Page part; empty string for same-page `[[#heading]]` links. */
  page: string
  /** Heading part without the leading `#`; empty when absent. */
  anchor: string
}

export function splitWikilinkTarget(target: string): WikilinkTarget {
  const trimmed = target.trim()
  const hash = trimmed.indexOf("#")
  if (hash < 0) return { page: trimmed, anchor: "" }
  return { page: trimmed.slice(0, hash).trim(), anchor: trimmed.slice(hash + 1).trim() }
}

/**
 * Collapse a heading or anchor to a comparison key: NFKC (so full-width
 * punctuation/spaces fold to ASCII), case-insensitive, all whitespace
 * removed, surrounding `#` markers and inline markdown emphasis dropped.
 */
export function normalizeHeadingAnchor(text: string): string {
  let decoded = text
  try { decoded = decodeURIComponent(text) } catch { /* 非法编码按原文比较。 */ }
  return decoded
    .normalize("NFKC")
    .replace(/^[#\s]+|[#\s]+$/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
}

/** Visible text of a rendered heading element, for anchor matching. */
export function headingElementMatches(element: Element, anchor: string): boolean {
  const key = normalizeHeadingAnchor(anchor)
  if (!key) return false
  return normalizeHeadingAnchor(element.textContent ?? "") === key
}

export function findHeadingElement(root: ParentNode, anchor: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    if (headingElementMatches(element, anchor)) return element
  }
  return null
}
