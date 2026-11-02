/** 审阅十页计划、目标断点与有限执行预算；不改变公共检索的融合规则。 */
import { invoke } from "@tauri-apps/api/core"
import { fileExists, getFileMd5, listDirectory, readFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { contentRevision, loadIngestRun, updateIngestRun, type IngestRun, type IngestReviewBatch } from "./ingest-run"
import { isIngestKnowledgePath } from "./ingest-knowledge-path"
import type { RetrievalResult } from "./evidence-retrieval"
import { prepareReviewMaterials } from "./review-checks/prepare"
import type { IngestProcessLog } from "./ingest-process-log"
import type { FileNode } from "@/types/wiki"

/** 语料变更、有效通道及向量模型都参与断点身份；读取失败时禁止复用旧检索。 */
export async function reviewCorpusIdentity(projectPath: string): Promise<string | undefined> {
  try {
    const config = await invoke("retrieval_config", { projectPath })
    if (!config) return undefined
    const entries: unknown[] = []
    const visit = async (nodes: FileNode[]): Promise<void> => {
      for (const node of nodes) {
        if (node.is_dir) await visit(node.children ?? [])
        else if (node.path.endsWith(".md")) entries.push([node.path, await getFileMd5(node.path)])
      }
    }
    await visit(await listDirectory(`${projectPath}/wiki`))
    const { apiKey: _key, ...embedding } = useWikiStore.getState().embeddingConfig
    const indexRoot = `${projectPath}/.llm-wiki/lancedb`
    if (embedding.enabled && await fileExists(indexRoot)) {
      const visitIndex = async (nodes: FileNode[]): Promise<void> => {
        for (const node of nodes) {
          if (node.is_dir) await visitIndex(node.children ?? [])
          else if (node.name.endsWith(".manifest")) entries.push(["vector-index", node.path, await getFileMd5(node.path)])
        }
      }
      await visitIndex(await listDirectory(indexRoot))
    }
    return contentRevision(JSON.stringify({ retrievalVersion: "title-recall-own-scope-v2", config, embedding, entries: entries.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) }))
  } catch { return undefined }
}

/** 成员使用二进制路径顺序和内容版本生成身份，历史整文记录也可建立新批次。 */
export async function ensureReviewBatchPlan(projectPath: string, run: IngestRun, rulesRevision: string): Promise<IngestReviewBatch[]> {
  const paths = Object.keys(run.pages).filter(isIngestKnowledgePath).sort()
  const refs = paths.map((path, index) => ({ path, revision: run.pages[path].revision, targetId: `page-${index}` }))
  const planId = await contentRevision(JSON.stringify({ revision: run.revision, source: run.sourceRevision, rulesRevision, refs }))
  const current = await loadIngestRun(projectPath, run.runId)
  if (current.review?.planId === planId && current.review.batches) return current.review.batches
  const batches: IngestReviewBatch[] = []
  for (let offset = 0; offset < refs.length; offset += 10) {
    const pageRefs = refs.slice(offset, offset + 10)
    batches.push({ batchId: (await contentRevision(JSON.stringify({ planId, pageRefs }))).slice(7), index: batches.length + 1, pageRefs, status: "pending", checks: {}, attempts: 0, elapsedMs: 0 })
  }
  await updateIngestRun(projectPath, run.runId, (state) => {
    if (!state.review) throw new Error("尚未建立审阅报告")
    state.review.planId = planId
    state.review.batches = batches
  })
  return batches
}

/** 只消费仍能核实的证据；不能把已删除页面或人工编辑当作可复用版本。 */
export async function retrievalEvidenceCurrent(path: string, retrieval?: RetrievalResult): Promise<boolean> {
  for (const entry of retrieval?.evidence ?? []) {
    if (!await fileExists(`${path}/${entry.path}`) || await contentRevision(await readFile(`${path}/${entry.path}`)) !== entry.revision) return false
  }
  return true
}

/** 同批成功目标不重复执行；恢复仍使用原批次的剩余正文预算。 */
export async function retrieveReviewBatch(projectPath: string, run: IngestRun, batch: IngestReviewBatch, reusable: boolean, log?: IngestProcessLog, contextCharLimit = 40_000): Promise<RetrievalResult> {
  const previous = reusable ? batch.retrieval : undefined
  const completedIds = new Set(previous?.targetResults.filter((target) => target.status === "matched" || target.status === "no_match").map((target) => target.targetId))
  const refs = batch.pageRefs.filter((ref) => !completedIds.has(ref.targetId))
  if (!refs.length && previous) return previous
  const retainedEvidence = previous?.evidence.filter((entry) => entry.targetIds.some((id) => completedIds.has(id))) ?? []
  const retainedChars = retainedEvidence.reduce((sum, entry) => sum + entry.text.length, 0)
  const result = await prepareReviewMaterials({ projectPath,
    targets: refs.map((ref) => ({ id: ref.targetId, path: ref.path, revision: ref.revision, text: run.pages[ref.path].after, startLine: 1, endLine: run.pages[ref.path].after.split("\n").length })),
    scope: { corpus: "wiki", excludePaths: [] }, checkpoint: previous?.execution.channelResults ? { configVersion: previous.execution.configVersion, corpusVersion: previous.execution.corpusVersion, channelResults: previous.execution.channelResults } : undefined,
    budget: { timeLimitMs: 60_000, candidateLimit: 320, queryLimit: 32, contextCharLimit: Math.max(0, contextCharLimit - retainedChars) }, processLog: log,
  })
  // 旧协议的整轮完成结论原样保留；有目标分项时，缺项必须标为未执行。
  const returned = new Set(result.targetResults.map((target) => target.targetId))
  const targetResults = [...(previous?.targetResults.filter((target) => completedIds.has(target.targetId)) ?? []), ...result.targetResults,
    ...refs.filter((ref) => !returned.has(ref.targetId)).map((ref) => ({ targetId: ref.targetId, status: "not_run" as const, evidenceIds: [], reason: "检索未返回该目标的结果" }))]
  if (!completedIds.size) return result.status === "completed" && !result.targetResults.length ? result : { ...result, targetResults }
  const evidence = new Map(retainedEvidence.map((entry) => [entry.id, entry]))
  for (const entry of result.evidence) {
    const old = evidence.get(entry.id)
    evidence.set(entry.id, old ? { ...entry, targetIds: [...new Set([...old.targetIds, ...entry.targetIds])], ranks: { ...old.ranks, ...entry.ranks } } : entry)
  }
  const retainedStates = previous?.execution.channelStates.filter((state) => state.targetId && completedIds.has(state.targetId)) ?? []
  const retainedQueries = previous?.execution.queries.filter((query) => completedIds.has(query.targetId)) ?? []
  const retainedChannels = previous?.execution.channelResults?.filter((channel) => completedIds.has(channel.targetId)) ?? []
  return { ...result, execution: { ...result.execution, queries: [...retainedQueries, ...result.execution.queries], channelStates: [...retainedStates, ...result.execution.channelStates], channelResults: result.execution.channelResults ? [...retainedChannels, ...result.execution.channelResults] : undefined }, targetResults, evidence: [...evidence.values()], relations: [...new Map([...(previous?.relations ?? []), ...result.relations].map((entry) => [entry.id, entry])).values()] }
}

/** 中文摘要保留失败目标及通道原因，内部重复预算标记不直接堆给用户。 */
export function reviewBatchError(batch: IngestReviewBatch, total: number, retrieval: RetrievalResult): string {
  const incomplete = retrieval.targetResults.filter((target) => target.status === "incomplete").length
  const notRun = retrieval.targetResults.filter((target) => target.status === "not_run").length
  const reasons = [...new Set(retrieval.execution.channelStates.filter((state) => ["failed", "unavailable"].includes(state.status)).map((state) => `${state.channel === "vector" ? "向量" : state.channel}通道：${state.reason ?? state.status}`))]
  const timedOut = retrieval.execution.budgetReached.some((reason) => /timeLimit|task-budget/.test(reason))
  return `第 ${batch.index}/${total} 批检索${timedOut ? "超时" : "未完成"}：${incomplete} 页检查不完整，${notRun} 页未执行${reasons.length ? `；${reasons.join("；")}` : ""}`
}
