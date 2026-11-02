/** 固定来源与切分计划；父记录只保存身份和分析断点，页面结果以子块 run 为准。 */
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { readIngestHistory } from "./ingest-history"
import { beginIngestRun, contentRevision, listIngestRuns, type IngestRun } from "./ingest-run"
import { normalizePath } from "./path-utils"
import { withProjectLock } from "./project-mutex"

export interface SourceChunkPlan {
  id: string
  index: number
  total: number
  headingPath: string
  overlapBefore: string
  main: string
  /** 规范化原文中的 UTF-16 范围；每段分别定位，不能用整个 main 猜测位置。 */
  sourceRanges?: { start: number; end: number; startLine: number; endLine: number }[]
}
export interface IngestDocument {
  version: 1
  documentRunId: string
  projectId: string
  sourcePath: string
  sourceIdentity: string
  sourceRevision: string
  originalRevision: string
  splitVersion: "semantic-v2"
  createdAt: number
  archived?: boolean
  cancelled?: boolean
  chunks: (SourceChunkPlan & { runId: string; analysis?: string; digestBefore?: string; digestAfter?: string; analysisRevision?: string; analysisContentRevision?: string })[]
}

function directory(path: string, id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("文档运行 ID 无效")
  return `${normalizePath(path)}/.llm-wiki/ingest-documents/${id}`
}
export async function loadIngestDocument(path: string, id: string): Promise<IngestDocument> {
  const document = JSON.parse(await readFile(`${directory(path, id)}/manifest.json`)) as IngestDocument
  if (document.version !== 1 || document.documentRunId !== id || !document.chunks.length) throw new Error("来源切分计划损坏")
  return document
}
export async function listIngestDocuments(path: string): Promise<IngestDocument[]> {
  const root = `${normalizePath(path)}/.llm-wiki/ingest-documents`
  const records = await readIngestHistory(root, (id) => loadIngestDocument(path, id))
  return records.sort((a, b) => b.createdAt - a.createdAt)
}
export async function updateIngestDocument(path: string, id: string, update: (document: IngestDocument) => void): Promise<IngestDocument> {
  return withProjectLock(`ingest-document\0${path}\0${id}`, async () => {
    const document = await loadIngestDocument(path, id)
    update(document)
    await writeFileAtomic(`${directory(path, id)}/manifest.json`, JSON.stringify(document, null, 2))
    return document
  })
}

/** 只恢复同一固定来源的未完成计划；配置变化不重排已经保存的逻辑子块。 */
export async function findIncompleteIngestDocument(path: string, identity: string, source: string, originalRevision: string): Promise<IngestDocument | undefined> {
  const revision = await contentRevision(source.replace(/\r\n/g, "\n"))
  const runs = await listIngestRuns(path)
  return (await listIngestDocuments(path)).find((document) => !document.archived && document.sourceIdentity === identity && document.sourceRevision === revision && document.originalRevision === originalRevision && document.chunks.some((chunk) => !runs.some((run) => run.documentRunId === document.documentRunId && run.chunk?.id === chunk.id && run.writeStatus === "complete")))
}

/** 先保存全部子块身份，再幂等创建运行记录；中断不会改变任务数。 */
export async function createIngestDocument(path: string, projectId: string, sourcePath: string, identity: string, source: string, originalRevision: string, chunks: SourceChunkPlan[]): Promise<IngestDocument> {
  const content = source.replace(/\r\n/g, "\n")
  const document: IngestDocument = {
    version: 1, documentRunId: crypto.randomUUID(), projectId, sourcePath, sourceIdentity: identity,
    sourceRevision: await contentRevision(content), originalRevision, splitVersion: "semantic-v2", createdAt: Date.now(),
    chunks: chunks.map((chunk) => ({ ...chunk, runId: crypto.randomUUID() })),
  }
  await createDirectory(directory(path, document.documentRunId))
  await writeFileAtomic(`${directory(path, document.documentRunId)}/source.json`, JSON.stringify({ content, sourceRevision: document.sourceRevision, originalRevision, offsets: "UTF-16" }))
  await writeFileAtomic(`${directory(path, document.documentRunId)}/manifest.json`, JSON.stringify(document, null, 2))
  await ensureDocumentRuns(path, document)
  return document
}

export async function ensureDocumentRuns(path: string, document: IngestDocument): Promise<IngestRun[]> {
  const records: IngestRun[] = []
  for (const chunk of document.chunks) records.push(await beginIngestRun(path, document.projectId, document.sourcePath, document.sourceIdentity, chunk.main, {
    documentRunId: document.documentRunId, documentSourceRevision: document.sourceRevision, runId: chunk.runId,
    chunk: { id: chunk.id, index: chunk.index, total: chunk.total, headingPath: chunk.headingPath, overlapBefore: chunk.overlapBefore, sourceRanges: chunk.sourceRanges }, pending: true,
  }))
  return records
}
