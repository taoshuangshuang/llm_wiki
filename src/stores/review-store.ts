import { create } from "zustand"
import { normalizeReviewTitle } from "@/lib/review-utils"
import type { CodeConflictAnalysis } from "@/lib/code-conflict-types"

export interface ReviewOption {
  label: string
  action: string // identifier for the action
  kind?: "inspect" | "chat" | "acknowledge" | "dismiss" | "create-page" | "research"
}

/** 行号和正文对应 revision 指定的固定版本；旧页正文从运行快照读取。 */
export interface ReviewEvidence {
  path: string
  revision: string
  text: string
  startLine: number
  endLine: number
  snapshot?: { runId: string; side: "before" | "after" | "source" }
    | { runId: string; side: "candidate"; eventId: string }
}

export interface ReviewItem {
  id: string
  type: "merge" | "contradiction" | "duplicate" | "missing-page" | "confirm" | "suggestion" | "structure" | "coverage"
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ReviewOption[]
  resolved: boolean
  /** 用户点 X 忽略的事项保留记录，防止历史报告或再次入库将其恢复。 */
  dismissed?: boolean
  resolvedAction?: string
  createdAt: number
  schemaVersion?: 2
  logicalId?: string
  evidenceVersion?: string
  subtype?: string
  runIds?: string[]
  evidence?: ReviewEvidence[]
  outcome?: string
  risk?: string
  historical?: boolean
  hidden?: boolean
  resolvedEvidenceVersion?: string
  legacyIds?: string[]
  resolutionUpdatedAt?: number
  repair?: { status: "resolved" | "unresolved"; reason: string }
  codeAnalysis?: CodeConflictAnalysis
}

interface ReviewState {
  items: ReviewItem[]
  addItem: (item: Omit<ReviewItem, "id" | "resolved" | "createdAt">) => void
  addItems: (items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]) => void
  setItems: (items: ReviewItem[]) => void
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  clearResolved: () => void
}

/**
 * Content-derived stable id. The SAME logical review (same type + same
 * normalized title) always gets the SAME id, so it survives ingest
 * regeneration, file moves, and reloads — and an external caller (the
 * resolve API) can target it reliably.
 *
 * Deliberately NOT counter-based (the old `review-N` scheme re-numbered
 * every review whenever the queue rebuilt, discarding resolved state)
 * and deliberately NOT keyed on sourcePath (mutable — a file rename
 * would re-id the review, the exact instability we're removing).
 *
 * "Collision" — two inputs sharing an id — is the intended behaviour:
 * identical content is the same review. Stability is bounded by
 * `normalizeReviewTitle` across LLM regenerations, the same ceiling the
 * previous dedup already accepted.
 */
export function reviewIdFor(item: Pick<ReviewItem, "type" | "title"> & Partial<Pick<ReviewItem, "schemaVersion" | "logicalId" | "evidenceVersion">>): string {
  if (item.schemaVersion === 2 && item.logicalId && item.evidenceVersion) return `review-v2-${item.logicalId}-${item.evidenceVersion}`
  const key = `${item.type}::${normalizeReviewTitle(item.title)}`
  // FNV-1a (32-bit) — small, deterministic, dependency-free.
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `review-${(h >>> 0).toString(16).padStart(8, "0")}`
}

/** Union two optional string arrays, dropping the field when empty. */
function unionField(a?: string[], b?: string[]): string[] | undefined {
  const merged = Array.from(new Set([...(a ?? []), ...(b ?? [])]))
  return merged.length > 0 ? merged : undefined
}

function mergeOptions(a: ReviewOption[], b: ReviewOption[]): ReviewOption[] {
  const byAction = new Map<string, ReviewOption>()
  for (const option of [...a, ...b]) {
    byAction.set(option.action, option)
  }
  return [...byAction.values()]
}

/**
 * Collapse two items that resolved to the same stable id. resolved
 * wins (if either was resolved, the survivor is), union the array
 * fields, keep the earliest createdAt, prefer a non-empty description.
 */
function mergeReviewItems(a: ReviewItem, b: ReviewItem): ReviewItem {
  const latest = (b.resolutionUpdatedAt ?? 0) > (a.resolutionUpdatedAt ?? 0) ? b : a
  const resolved = (a.resolutionUpdatedAt || b.resolutionUpdatedAt) ? latest.resolved : a.resolved || b.resolved
  const resolvedAction = resolved ? latest.resolvedAction ?? a.resolvedAction ?? b.resolvedAction : undefined
  return {
    ...a, ...b, // Both share the same evidence identity; retain the newest evidence metadata.
    resolved,
    resolvedAction,
    resolutionUpdatedAt: latest.resolutionUpdatedAt,
    hidden: latest.hidden ?? a.hidden ?? b.hidden,
    dismissed: resolved && ((a.resolutionUpdatedAt || b.resolutionUpdatedAt) ? latest.dismissed : a.dismissed || b.dismissed) || undefined,
    description: b.description || a.description,
    codeAnalysis: (a.codeAnalysis?.checkedAt ?? 0) > (b.codeAnalysis?.checkedAt ?? 0) ? a.codeAnalysis : b.codeAnalysis ?? a.codeAnalysis,
    sourcePath: b.sourcePath ?? a.sourcePath,
    affectedPages: unionField(a.affectedPages, b.affectedPages),
    runIds: unionField(a.runIds, b.runIds),
    legacyIds: unionField(a.legacyIds, b.legacyIds),
    searchQueries: unionField(a.searchQueries, b.searchQueries),
    options: mergeOptions(a.options, b.options),
    createdAt: Math.min(a.createdAt, b.createdAt),
  }
}

export function normalizeReviewItems(items: ReviewItem[]): ReviewItem[] {
  const byId = new Map<string, ReviewItem>()
  for (const raw of items) {
    const id = reviewIdFor(raw)
    const remapped: ReviewItem = { ...raw, id, ...(raw.id !== id ? { legacyIds: unionField(raw.legacyIds, [raw.id]) } : {}) }
    const existing = byId.get(remapped.id)
    byId.set(remapped.id, existing ? mergeReviewItems(existing, remapped) : remapped)
  }
  return [...byId.values()]
}

export const useReviewStore = create<ReviewState>((set) => ({
  items: [],

  addItem: (item) =>
    set((state) => {
      const id = reviewIdFor(item)
      // Same-content item already present (possibly resolved) → keep it
      // as-is so resolved state survives. The stable id makes this a
      // simple identity check, no separate dedup key.
      if (state.items.some((it) => it.id === id)) {
        return { items: state.items }
      }
      return {
        items: [...state.items, { ...item, id, resolved: false, createdAt: Date.now() }],
      }
    }),

  addItems: (items) =>
    set((state) => {
      // Dedup on the content-stable id against ALL existing items —
      // including resolved ones. The previous scheme only deduped
      // against *pending* items, which is exactly why re-surfacing a
      // review during ingest discarded its resolved state. Now a
      // resolved review with the same content is preserved (resolved
      // wins), with array fields merged.
      const result = [...state.items]
      const indexById = new Map<string, number>()
      result.forEach((it, idx) => indexById.set(it.id, idx))

      for (const incoming of items) {
        const id = reviewIdFor(incoming)
        const existingIdx = indexById.get(id)

        if (existingIdx !== undefined) {
          const old = result[existingIdx]
          result[existingIdx] = {
            ...old, // preserves resolved / resolvedAction / createdAt / id
            description: incoming.description || old.description,
            sourcePath: incoming.sourcePath ?? old.sourcePath,
            affectedPages: unionField(old.affectedPages, incoming.affectedPages),
            searchQueries: unionField(old.searchQueries, incoming.searchQueries),
            runIds: unionField(old.runIds, incoming.runIds),
            evidence: incoming.evidence ?? old.evidence,
            outcome: incoming.outcome ?? old.outcome,
            risk: incoming.risk ?? old.risk,
            codeAnalysis: (old.codeAnalysis?.checkedAt ?? 0) > (incoming.codeAnalysis?.checkedAt ?? 0) ? old.codeAnalysis : incoming.codeAnalysis ?? old.codeAnalysis,
            historical: incoming.historical ?? old.historical,
            repair: incoming.repair ?? old.repair,
          }
        } else {
          // 同一结构问题在页面改版后会以新的证据版本再次出现；旧版本的未决
          // 事项由新事项接替，按历史证据退出待审列表，避免同一问题并列两条。
          if (incoming.type === "structure" && incoming.logicalId) {
            for (let index = 0; index < result.length; index++) {
              const old = result[index]
              if (old.type === "structure" && old.logicalId === incoming.logicalId && !old.resolved && !old.historical && !old.hidden && !old.dismissed) {
                result[index] = { ...old, historical: true }
              }
            }
          }
          result.push({ ...incoming, id, resolved: false, createdAt: Date.now() })
          indexById.set(id, result.length - 1)
        }
      }

      return { items: result }
    }),

  setItems: (items) => {
    // Migrate-on-load: remap every item to its content-stable id,
    // collapsing any that share one. Old counter ids (review-N) and
    // their resolved state are folded in here (resolved wins), so a
    // resolved review keeps its resolution across the id-scheme change.
    // Computing the id from content (not the old id) makes this
    // idempotent — no migration-version flag needed.
    set({ items: normalizeReviewItems(items) })
  },

  resolveItem: (id, action) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, resolved: true, resolvedAction: action, resolvedEvidenceVersion: item.evidenceVersion, resolutionUpdatedAt: Date.now() } : item
      ),
    })),

  dismissItem: (id) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, resolved: true, dismissed: true, resolvedAction: "dismiss", resolvedEvidenceVersion: item.evidenceVersion, resolutionUpdatedAt: Date.now() } : item
      ),
    })),

  clearResolved: () =>
    set((state) => ({
      // 增量持久化保留人工状态，清理仅隐藏历史，避免重新打开项目后复活。
      items: state.items.map((item) => item.resolved && !item.dismissed || item.historical ? { ...item, hidden: true, resolutionUpdatedAt: Date.now() } : item),
    })),
}))
