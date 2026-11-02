/** 从公开入库／审阅入口验证任务归属、串行顺序和断点；正文与业务记录真实落盘。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string) => command === "retrieval_config" ? { effective: { keyword: true, vector: false, indexPage: true, graph: false } } : undefined) }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))
vi.mock("./ingest-acceptance", async (original) => ({ ...await original<typeof import("./ingest-acceptance")>(), inspectIngestContent: vi.fn(async () => ({ status: "clear", rounds: [], updatedAt: 0, sourceIdentity: "source.md" })) }))

import { autoIngest, executeIngestWrites, splitSourceIntoSemanticChunks } from "./ingest"
import { streamChat } from "./llm-client"
import { retrieveEvidence, type RetrievalRequest, type RetrievalResult } from "./evidence-retrieval"
import { beginIngestRun, commitIngestPage, contentRevision, listIngestRuns, loadIngestRun, updateIngestRun } from "./ingest-run"
import { createIngestDocument, ensureDocumentRuns, listIngestDocuments } from "./ingest-document"
import { runIngestReview } from "./ingest-review"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"

let project: Awaited<ReturnType<typeof createTempProject>>
let generationPages: number[]
let events: string[]
let generationCount: number
const pageText = (id: string) => `---\ntype: concept\ntitle: ${id}\nsources: [source.md]\n---\n# ${id}\n${id} 的独立事实与明确适用条件。`
const config = () => ({ ...useWikiStore.getState().llmConfig, provider: "custom" as const, model: "test", maxContextSize: 128_000 })
function retrieval(request: RetrievalRequest): RetrievalResult {
  return { status: "completed", evidence: [], relations: [], targetResults: request.targets.map((target) => ({ targetId: target.id, status: "no_match", evidenceIds: [] })), execution: { configVersion: "test", queries: [], channelStates: [], warnings: [], budgetReached: [], elapsedMs: 1, usage: { candidates: 0, queries: request.targets.length, contextChars: 0, readChars: 0 } } }
}

beforeEach(async () => {
  vi.clearAllMocks()
  project = await createTempProject("chunk-pipeline")
  await writeFileRaw(`${project.path}/schema.md`, "# Schema")
  useWikiStore.setState({ project: { id: "chunks", name: "chunks", path: project.path }, outputLanguage: "Chinese", embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false }, multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false } })
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  generationPages = [1]
  generationCount = 0
  events = []
  vi.mocked(retrieveEvidence).mockImplementation(async (request) => { events.push(`retrieve:${request.targets.length}`); return retrieval(request) })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    const input = JSON.parse(String(messages[1].content))
    if (system.includes("generate wiki files")) {
      const ordinal = ++generationCount
      events.push(`generate:${ordinal}`)
      callbacks.onToken(Array.from({ length: generationPages[ordinal - 1] ?? 1 }, (_, index) => {
        const id = `unit-${ordinal}-${String(index).padStart(2, "0")}`
        return `---FILE: wiki/concepts/${id}.md---\n${pageText(id)}\n---END FILE---`
      }).join("\n"))
    } else if (input.chunk) {
      events.push(`analyze:${input.chunk.index}`)
      callbacks.onToken(`## Chunk Analysis\n子块 ${input.chunk.index} 的完整分析。\n## Updated Global Digest\n累计摘要 ${input.chunk.index}。`)
    } else if (input.materials) {
      events.push("review")
      callbacks.onToken('{"issues":[]}')
    } else if (system.startsWith("核对新知识页和候选页")) {
      callbacks.onToken('{"decisions":[]}')
    } else callbacks.onToken("来源的完整分析。")
    callbacks.onDone()
  })
})
afterEach(async () => { vi.restoreAllMocks(); await project.cleanup() })

async function preparedPages(count: number) {
  const run = await beginIngestRun(project.path, "chunks", "raw/sources/source.md", "source.md", "主体事实。")
  // 反序写入用于验证批次成员只依赖固定路径顺序。
  for (let index = count - 1; index >= 0; index--) {
    const id = `page-${String(index).padStart(2, "0")}`
    await commitIngestPage(project.path, run.runId, `wiki/concepts/${id}.md`, null, pageText(id), id, "create")
  }
  await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "complete" })
  return run
}

describe("长文子块与十页审阅流水线", () => {
  it("交互补写沿用单个文档与运行身份，已有运行的补写也会等待本轮审阅", async () => {
    const source = `${project.path}/raw/sources/source.md`
    await writeFileRaw(source, "交互确认的完整事实。")
    useChatStore.setState({ conversations: [], messages: [], activeConversationId: null, ingestSource: source, mode: "ingest" })
    const conversationId = useChatStore.getState().createConversation()
    useChatStore.getState().addMessageToConversation(conversationId, "user", "请保存已确认的事实。")
    const normal = vi.mocked(streamChat).getMockImplementation()!
    let writes = 0
    vi.mocked(streamChat).mockImplementation(async (...args) => {
      const [, messages, callbacks] = args
      if (String(messages[0].content).startsWith("You are a wiki generation assistant")) {
        writes++
        const id = `interactive-${writes}`
        callbacks.onToken(`---FILE: wiki/concepts/${id}.md---\n${pageText(id)}\n---END FILE---${writes === 1 ? "\n---FILE: wiki/concepts/unfinished.md---\n未完成" : ""}`)
        callbacks.onDone()
      } else await normal(...args)
    })
    await executeIngestWrites(project.path, config())
    const [first] = await listIngestRuns(project.path)
    expect(first.writeStatus).toBe("partial")
    expect(first.reviewRequested).toBe(false)
    const reviews = events.filter((event) => event === "review").length
    await executeIngestWrites(project.path, config())
    const [second] = await listIngestRuns(project.path)
    expect(second.runId).toBe(first.runId)
    expect(second.documentRunId).toBe(first.documentRunId)
    expect(second.writeStatus).toBe("complete")
    expect(second.reviewRequested).toBe(false)
    expect(events.filter((event) => event === "review").length).toBeGreaterThan(reviews)
    expect(await listIngestDocuments(project.path)).toHaveLength(1)
  })

  it("来源写入与手动审阅共用串行入口，等待中的审阅不会插入当前写入", async () => {
    const manual = await preparedPages(1)
    const source = `${project.path}/raw/sources/source.md`
    await writeFileRaw(source, "另一个来源事实。")
    const normal = vi.mocked(streamChat).getMockImplementation()!
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(streamChat).mockImplementation(async (...args) => {
      const [, messages] = args
      if (String(messages[0].content).includes("generate wiki files")) { started(); await gate }
      await normal(...args)
    })
    const writing = autoIngest(project.path, source, config())
    await entered
    const reviewing = runIngestReview(project.path, manual.runId, config())
    try {
      // 写入被门闩固定时，另一入口的业务记录尚未认领为 running。
      await realFs.readFile(`${project.path}/schema.md`)
      expect((await loadIngestRun(project.path, manual.runId)).reviewStatus).toBe("pending")
      expect(events).not.toContain("review")
    } finally { release() }
    await Promise.all([writing, reviewing])
    expect((await loadIngestRun(project.path, manual.runId)).reviewStatus).toBe("complete")
  })

  it("相同主体的两个子块身份互不合并，父计划落盘后中断仍使用预留运行身份", async () => {
    const chunks = [1, 2].map((index) => ({ id: `chunk-${index}`, index, total: 2, main: "完全相同的原文。", headingPath: "章节", overlapBefore: "" }))
    const document = await createIngestDocument(project.path, "chunks", "raw/sources/source.md", "source.md", "完全相同的原文。\n\n完全相同的原文。", "raw-version", chunks)
    const initial = await ensureDocumentRuns(project.path, document)
    expect(initial.map((run) => run.sourceRevision)).toEqual([initial[0].sourceRevision, initial[0].sourceRevision])
    expect(initial[0].runId).not.toBe(initial[1].runId)
    // 模拟第二个子块尚未创建 manifest 就中断；恢复必须使用父计划已有的身份。
    await realFs.deleteFile(`${project.path}/.llm-wiki/ingest-runs/${initial[1].runId}/manifest.json`)
    const recovered = await ensureDocumentRuns(project.path, document)
    expect(recovered.map((run) => run.runId)).toEqual(initial.map((run) => run.runId))
    expect(await listIngestRuns(project.path)).toHaveLength(2)
  })

  it("后块更新共享页保留前块写后快照，并把前块报告标为历史", async () => {
    const document = await createIngestDocument(project.path, "chunks", "raw/sources/source.md", "source.md", "事实甲。\n\n事实乙。", "version", [
      { id: "chunk-1", index: 1, total: 2, main: "事实甲。", headingPath: "甲", overlapBefore: "" },
      { id: "chunk-2", index: 2, total: 2, main: "事实乙。", headingPath: "乙", overlapBefore: "事实甲。" },
    ])
    const [first, second] = await ensureDocumentRuns(project.path, document)
    const path = "wiki/concepts/shared.md"
    const original = pageText("共享页")
    await commitIngestPage(project.path, first.runId, path, null, original, "first", "create")
    await updateIngestRun(project.path, first.runId, (run) => { run.writeStatus = "complete" })
    await runIngestReview(project.path, first.runId, config())
    await commitIngestPage(project.path, second.runId, path, original, `${original}\n事实乙。`, "second", "merge")
    const before = await loadIngestRun(project.path, first.runId)
    const after = await loadIngestRun(project.path, second.runId)
    expect(before.pages[path].after).toBe(original)
    expect(before.review?.historical).toBe(true)
    expect(after.pages[path].before).toBe(original)
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(`${original}\n事实乙。`)
  })

  it("普通分析与块内分析先后截断时，仅内部细分，逻辑子块任务数保持固定", async () => {
    const source = `${project.path}/raw/sources/source.md`
    await writeFileRaw(source, "一条完整事实。".repeat(1500))
    const normal = vi.mocked(streamChat).getMockImplementation()!
    let ordinaryTruncated = false
    let childTruncated = false
    vi.mocked(streamChat).mockImplementation(async (...args) => {
      const [, messages, callbacks] = args
      const input = JSON.parse(String(messages[1].content))
      if (!ordinaryTruncated && input.source && !input.analysis) {
        ordinaryTruncated = true
        callbacks.onToken("不可用于生成的截断分析")
        callbacks.onDone({ truncated: true, finishReason: "length" })
      } else if (input.chunk && !childTruncated) {
        childTruncated = true
        callbacks.onToken("块内截断也不能用于生成")
        callbacks.onDone({ truncated: true, finishReason: "length" })
      } else await normal(...args)
    })
    await autoIngest(project.path, source, config())
    const [document] = await listIngestDocuments(project.path)
    const runs = await listIngestRuns(project.path)
    expect(document.chunks).toHaveLength(2)
    expect(runs).toHaveLength(2)
    expect(generationCount).toBe(2)
    for (const run of runs) expect(run.generation?.analysis).not.toContain("截断")
  })

  it("普通来源生成 17 页时仍是一个子块任务，按 10＋7 检索，每批各有 60 秒", async () => {
    generationPages = [17]
    const source = `${project.path}/raw/sources/source.md`
    await writeFileRaw(source, "普通来源事实。")
    await autoIngest(project.path, source, config())
    const documents = await listIngestDocuments(project.path)
    const runs = await listIngestRuns(project.path)
    expect(documents).toHaveLength(1)
    expect(documents[0].chunks).toHaveLength(1)
    expect(runs).toHaveLength(1)
    expect(runs[0].review?.batches?.map((batch) => batch.pageRefs.length)).toEqual([10, 7])
    expect(runs[0].reviewStatus).toBe("complete")
    const requests = vi.mocked(retrieveEvidence).mock.calls.map(([request]) => request).filter((request) => request.scene === "review")
    expect(requests.map((request) => request.targets.length)).toEqual([10, 7])
    expect(requests.every((request) => request.budget?.timeLimitMs === 60_000)).toBe(true)
  })

  it("两个主体子块分别生成和审阅，第一块审阅结束后才分析第二块", async () => {
    generationPages = [23, 12]
    const source = `${project.path}/raw/sources/source.md`
    await writeFileRaw(source, `${"甲块独立事实。".repeat(5500)}\n\n${"乙块独立事实。".repeat(5500)}`)
    await autoIngest(project.path, source, config())
    const [document] = await listIngestDocuments(project.path)
    const runs = await listIngestRuns(project.path)
    expect(document.chunks).toHaveLength(2)
    expect(runs).toHaveLength(2)
    const ordered = [...runs].sort((a, b) => a.chunk!.index - b.chunk!.index)
    expect(ordered.map((run) => run.review?.batches?.map((batch) => batch.pageRefs.length))).toEqual([[10, 10, 3], [10, 2]])
    expect(new Set(runs.map((run) => run.runId)).size).toBe(2)
    expect(runs.every((run) => run.documentRunId === document.documentRunId && run.reviewStatus === "complete")).toBe(true)
    expect(events.indexOf("generate:1")).toBeLessThan(events.indexOf("analyze:2"))
    expect(events.lastIndexOf("review", events.indexOf("analyze:2") - 1)).toBeGreaterThan(events.indexOf("generate:1"))
    const generationInputs = vi.mocked(streamChat).mock.calls.filter(([, messages]) => String(messages[0].content).includes("generate wiki files")).map(([, messages]) => JSON.parse(JSON.parse(String(messages[1].content)).source))
    expect(generationInputs.map((input) => input.chunk_index)).toEqual([1, 2])
    expect(generationInputs[1].auxiliary_context.global_digest).toContain("累计摘要 1")
    expect(await readFileRaw(`${project.path}/.llm-wiki/ingest-runs/${document.chunks[1].runId}/source.json`)).not.toContain("overlapBefore")
  })

  it("第一批有 2 页成功、8 页未执行时仍处理第二批；续跑保留批次身份和成功目标", async () => {
    const run = await preparedPages(17)
    const requests: string[][] = []
    let first = true
    vi.mocked(retrieveEvidence).mockImplementation(async (request) => {
      requests.push(request.targets.map((target) => target.id))
      const result = retrieval(request)
      if (first) {
        first = false
        result.status = "partial"
        result.targetResults = request.targets.map((target, index) => ({ targetId: target.id, status: index < 2 ? "no_match" : "not_run", evidenceIds: [] }))
        result.execution.budgetReached = ["timeLimit"]
      }
      return result
    })
    await runIngestReview(project.path, run.runId, config())
    const firstAttempt = await loadIngestRun(project.path, run.runId)
    expect(firstAttempt.review?.batches?.map((batch) => batch.status)).toEqual(["incomplete", "complete"])
    expect(firstAttempt.reviewStatus).toBe("incomplete")
    expect(requests.map((ids) => ids.length)).toEqual([10, 7])
    const batchIds = firstAttempt.review?.batches?.map((batch) => batch.batchId)
    await runIngestReview(project.path, run.runId, config())
    const resumed = await loadIngestRun(project.path, run.runId)
    expect(resumed.reviewStatus).toBe("complete")
    expect(resumed.review?.batches?.map((batch) => batch.batchId)).toEqual(batchIds)
    expect(requests.map((ids) => ids.length)).toEqual([10, 7, 8])
    expect(requests[2]).not.toContain("page-0")
    expect(requests[2]).not.toContain("page-1")
  })

  it("语料新增后废弃旧无命中断点，重新核对全部批次", async () => {
    const run = await preparedPages(23)
    await runIngestReview(project.path, run.runId, config())
    const first = await loadIngestRun(project.path, run.runId)
    expect(first.review?.batches?.map((batch) => batch.pageRefs.length)).toEqual([10, 10, 3])
    vi.mocked(retrieveEvidence).mockClear()
    await writeFileRaw(`${project.path}/wiki/concepts/added.md`, pageText("新增相关页"))
    await runIngestReview(project.path, run.runId, config())
    expect(vi.mocked(retrieveEvidence).mock.calls.map(([request]) => request.targets.length)).toEqual([10, 10, 3])
  })

  it("检索命中的本轮跨批重复进入统一知识检查，自动整理失败保留一条人工事项", async () => {
    const run = await preparedPages(23)
    const duplicate = "共同核心事实：请求必须携带租户身份，缓存按租户隔离。"
    for (const id of ["page-00", "page-22"]) {
      const path = `wiki/concepts/${id}.md`
      await commitIngestPage(project.path, run.runId, path, pageText(id), pageText(id).replace(`${id} 的独立事实与明确适用条件。`, duplicate), `${id}-updated`, "merge")
    }
    vi.mocked(retrieveEvidence).mockImplementation(async (request) => {
      const result = retrieval(request)
      const path = "wiki/concepts/page-22.md"
      const text = await readFileRaw(`${project.path}/${path}`)
      result.evidence = [{ id: "retrieved-page-22", targetIds: request.targets.map((target) => target.id), path, title: "另一批页面", revision: await contentRevision(text), text, range: { startLine: 1, endLine: text.split("\n").length }, headingPath: [], ranks: {}, retrievalSources: [], relationIds: [] }]
      return result
    })
    const normal = vi.mocked(streamChat).getMockImplementation()!
    vi.mocked(streamChat).mockImplementation(async (...args) => {
      const [, messages, callbacks] = args
      const input = JSON.parse(String(messages[1].content))
      const first = input.materials?.find((entry: { path: string; id: string }) => entry.id.startsWith("after-") && entry.path.endsWith("page-00.md"))
      const last = input.materials?.find((entry: { path: string; id: string }) => entry.id === "retrieved-page-22" && entry.path.endsWith("page-22.md"))
      if (String(messages[0].content).includes("本次检查仅允许 type=contradiction|duplicate") && first && last) {
        callbacks.onToken(JSON.stringify({ issues: [{ type: "duplicate", title: "跨批重复", description: "两页核心事实相同", evidence: [{ id: first.id, quote: duplicate }, { id: last.id, quote: duplicate }] }] }))
        callbacks.onDone()
      } else await normal(...args)
    })
    await runIngestReview(project.path, run.runId, config())
    const report = await loadIngestRun(project.path, run.runId)
    expect(report.reviewStatus).toBe("complete")
    expect(useReviewStore.getState().items.filter((item) => item.type === "duplicate")).toEqual([expect.objectContaining({ affectedPages: ["wiki/concepts/page-22.md", "wiki/concepts/page-00.md"].sort(), title: "跨批重复" })])
    expect(new Set(report.review?.issueIds).size).toBe(report.review?.issueIds.length)
    expect(report.review?.commonChecks).toBeUndefined()
    expect(report.repairAttempts).toMatchObject([{ stage: "knowledge", status: "failed" }])
  })

  it("重复原文段落按前向范围映射，UTF-16 偏移能还原每个实际主体", () => {
    const paragraph = "相同段落😀。".repeat(400)
    const source = `${paragraph}\r\n\r\n${paragraph}\r\n\r\n${paragraph}`
    const normalized = source.replace(/\r\n/g, "\n")
    const chunks = splitSourceIntoSemanticChunks(source, 3000, 100)
    expect(chunks.length).toBeGreaterThan(1)
    let previousEnd = 0
    for (const chunk of chunks) {
      expect(chunk.sourceRanges?.map((range) => normalized.slice(range.start, range.end)).join("\n\n")).toBe(chunk.main)
      for (const range of chunk.sourceRanges ?? []) { expect(range.start).toBeGreaterThanOrEqual(previousEnd); previousEnd = range.end }
    }
  })
})
