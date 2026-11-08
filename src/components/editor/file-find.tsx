import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react"
import { ArrowDown, ArrowUp, Search, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { findDocumentRanges, findTextMatches } from "@/lib/file-find"

interface FileFindProps {
  ownerRef: RefObject<HTMLDivElement | null>
  readerRef: RefObject<HTMLDivElement | null>
  textareaRef: RefObject<HTMLTextAreaElement | null>
  content: string
  mode: "read" | "edit"
  filePath?: string
}

/** 当前文件的悬浮查找框，支持快捷键、循环跳转及无 DOM 改写的阅读高亮。 */
export function FileFind({ ownerRef, readerRef, textareaRef, content, mode, filePath }: FileFindProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [ranges, setRanges] = useState<Range[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const highlightName = `file-find-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`
  const matches = mode === "edit" ? findTextMatches(content, query) : ranges
  const total = matches.length
  const index = total ? Math.min(active, total - 1) : 0

  const close = useCallback(() => {
    setOpen(false)
    ownerRef.current?.focus({ preventScroll: true })
  }, [ownerRef])

  useEffect(() => {
    if (typeof window === "undefined") return
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        const owner = ownerRef.current
        if (!owner || !owner.getClientRects().length) return
        const focusedOwner = (event.target as Element | null)?.closest?.("[data-file-find-owner]")
        if (focusedOwner && focusedOwner !== owner) return
        event.preventDefault()
        setOpen(true)
        inputRef.current?.focus()
        inputRef.current?.select()
      } else if (open && event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [open, ownerRef, close])

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [open])

  useEffect(() => { setActive(0) }, [query, mode, filePath])

  useEffect(() => {
    const root = readerRef.current
    if (!open || mode !== "read" || !root || !query) {
      setRanges([])
      return
    }
    const refresh = () => setRanges(findDocumentRanges(root, query))
    refresh()
    // Mermaid 等内容会异步渲染，完成后重新纳入当前文件搜索。
    const observer = new MutationObserver(refresh)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [open, query, mode, content, readerRef])

  useEffect(() => {
    if (!open || mode !== "read") return
    // CSS Highlight 保留原始 DOM 和浏览器选区，关闭或卸载时清理。
    if (typeof Highlight === "undefined" || !CSS.highlights) return
    CSS.highlights.set(highlightName, new Highlight(...ranges))
    CSS.highlights.set(`${highlightName}-active`, new Highlight(...(ranges[index] ? [ranges[index]] : [])))
    return () => {
      CSS.highlights.delete(highlightName)
      CSS.highlights.delete(`${highlightName}-active`)
    }
  }, [open, mode, ranges, index, highlightName])

  useEffect(() => {
    if (!open || !total) return
    if (mode === "read") {
      const root = readerRef.current
      const range = ranges[index]
      if (!root || !range) return
      const rect = range.getBoundingClientRect()
      const viewport = root.getBoundingClientRect()
      root.scrollBy({ top: rect.top - viewport.top - viewport.height / 2, behavior: "auto" })
    } else {
      const textarea = textareaRef.current
      const match = findTextMatches(content, query)[index]
      if (!textarea || !match) return
      textarea.setSelectionRange(match.start, match.end)
      // 保持输入焦点在查找框，同时让源码中的选中行进入可视区域。
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24
      const line = content.slice(0, match.start).split("\n").length - 1
      textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 2)
    }
  }, [open, mode, ranges, index, total, content, query, readerRef, textareaRef])

  const move = (step: number) => {
    if (total) setActive((index + step + total) % total)
  }

  if (!open) return null
  return (
    <div role="search" aria-label={t("editor.find.title")} className="absolute right-3 top-12 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl">
      <style>{`::highlight(${highlightName}) { background: #facc1555; color: inherit; }
        ::highlight(${highlightName}-active) { background: #f59e0b; color: #171717; }`}</style>
      <Search className="mx-1 h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0) }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1) }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close() }
        }}
        aria-label={t("editor.find.title")}
        placeholder={t("editor.find.placeholder")}
        className="min-w-0 w-44 bg-transparent px-1 py-1 text-sm outline-none"
      />
      <span role="status" aria-live="polite" className="shrink-0 px-1 text-xs text-muted-foreground">
        {query ? total ? `${index + 1}/${total}` : t("editor.find.noResults") : "0/0"}
      </span>
      <button type="button" disabled={!total} onClick={() => move(-1)} aria-label={t("editor.find.previous")} title={t("editor.find.previous")} className="rounded p-1 hover:bg-accent disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
      <button type="button" disabled={!total} onClick={() => move(1)} aria-label={t("editor.find.next")} title={t("editor.find.next")} className="rounded p-1 hover:bg-accent disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
      <button type="button" onClick={close} aria-label={t("editor.find.close")} title={t("editor.find.close")} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
    </div>
  )
}
