/** 入库、审阅、搜索和问答共用的 Rust 证据检索协议；前端不再自行融合分数。 */
import { invoke } from "@tauri-apps/api/core"
import { useWikiStore } from "@/stores/wiki-store"
import type { IngestProcessLog } from "./ingest-process-log"

export type RetrievalChannel = "title" | "vector" | "keyword" | "indexPage" | "graph"
export interface RetrievalEvidence {
  id: string
  targetIds: string[]
  path: string
  title: string
  revision: string
  headingPath: string[]
  range: { startLine: number; endLine: number }
  text: string
  ranks: Record<string, number>
  retrievalSources: { channel: RetrievalChannel; queryId: string; rank: number }[]
  relationIds: string[]
}
export interface RetrievalRelation {
  id: string; fromPath: string; fromRevision: string; toPath?: string; targetText: string
  kind: "wikilink" | "related" | "markdownLink"; anchor?: string
  range?: { startLine: number; endLine: number }; nearbyText?: string
  resolution: "resolved" | "missing" | "ambiguous"; usedForRecall: boolean
}
export interface RetrievalRequest {
  projectPath: string
  scene: "ingest" | "review" | "qa" | "search"
  targets: { id: string; text: string; title?: string; path?: string }[]
  scope?: { corpus: "wiki" | "sources"; includePaths?: string[]; excludePaths?: string[] }
  channels?: Partial<Record<RetrievalChannel, boolean>>
  checkpoint?: Pick<RetrievalResult["execution"], "configVersion" | "corpusVersion" | "channelResults">
  budget?: { contextCharLimit?: number; candidateLimit?: number; queryLimit?: number; timeLimitMs?: number }
}
export interface RetrievalResult {
  status: "completed" | "partial" | "disabled" | "failed"
  evidence: RetrievalEvidence[]
  relations: RetrievalRelation[]
  targetResults: { targetId: string; status: "matched" | "no_match" | "incomplete" | "not_run"; evidenceIds: string[]; reason?: string; elapsedMs?: number; usage?: { candidates: number; contextChars: number } }[]
  execution: {
    corpusVersion?: string
    channelResults?: { targetId: string; queryRevision: string; channel: RetrievalChannel; status: string; candidates: { path: string; revision: string; rank: number; quote: string | null }[] }[]
    configVersion: string; queries: { id: string; targetId: string; text: string; title?: string }[]
    channelStates: { targetId?: string; reused?: boolean; elapsedMs?: number; candidates?: number; channel: RetrievalChannel; status: "completed" | "disabled" | "unavailable" | "failed" | "skipped"; reason?: string }[]
    warnings: string[]; budgetReached: string[]; elapsedMs: number
    usage: { candidates: number; queries: number; contextChars: number; readChars: number }
    trace?: unknown[]
  }
}

export async function retrieveEvidence(request: RetrievalRequest, processLog?: Pick<IngestProcessLog, "record">): Promise<RetrievalResult> {
  const started = Date.now()
  processLog?.record("retrieval-start", request, "retrieval")
  try {
    const result = await invoke<RetrievalResult>("retrieve_evidence", { request, embeddingConfig: useWikiStore.getState().embeddingConfig, recordTrace: Boolean(processLog) })
    processLog?.record("retrieval-finish", { result, elapsedMs: Date.now() - started }, "retrieval")
    // 详细诊断只写日志，不能进入原有模型上下文或改变检索消费协议。
    const { trace: _trace, ...execution } = result.execution
    return { ...result, execution }
  } catch (error) {
    processLog?.record("retrieval-error", { error, elapsedMs: Date.now() - started }, "retrieval")
    throw error
  }
}
