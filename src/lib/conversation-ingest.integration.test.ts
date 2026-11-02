import { retrieveEvidence } from "./evidence-retrieval"
/** 从对话凭据入口经过真实公共队列和入库实现，验证最终文件、查重、审阅和持久化结果。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@/commands/fs", () => ({ ...realFs, writeFile: vi.fn(realFs.writeFile) }))
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./ingest-acceptance", () => ({
  runIngestAcceptance: vi.fn(async () => ({ report: { status: "clear", rounds: [] }, reviews: [] })),
}))
vi.mock("./sweep-reviews", () => ({ sweepResolvedReviews: vi.fn(async () => 0) }))
vi.mock("./project-identity", () => ({
  getProjectPathById: vi.fn(async () => useWikiStore.getState().project?.path ?? null),
}))
vi.mock("./embedding", async (importOriginal) => ({
  ...await importOriginal<typeof import("./embedding")>(),
  fetchEmbedding: vi.fn(async () => [1, 0]),
  vectorSearchChunks: vi.fn(async () => [{ page_id: "concepts/redis-cache", score: 0.95 }]),
  embedPage: vi.fn(async () => true),
}))

import { invoke } from "@tauri-apps/api/core"
import { writeFile } from "@/commands/fs"
import { listIngestRuns } from "./ingest-run"
import { transferConversationIngests } from "./conversation-ingest"
import { clearQueueState, getQueue, pauseProcessing, pauseQueue, restoreQueue } from "./ingest-queue"
import { streamChat } from "./llm-client"
import { embedPage } from "./embedding"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

const sourcePath = `raw/sources/conversations/${"a".repeat(64)}.md`
const requestedPath = "wiki/concepts/cache-strategy.md"
const existingPath = "wiki/concepts/redis-cache.md"
const original = '---\ntype: concept\ntitle: Redis Cache\nsources: [manual.md]\n---\n# Redis Cache\nExisting expiry rules must remain.'
const incoming = '---\ntype: concept\ntitle: Cache Strategy\n---\n# Cache Strategy\nNew cache invalidation evidence.'
let temp: Awaited<ReturnType<typeof createTempProject>>
let verdict: "same" | "different" | "uncertain"
let pending: boolean
let failMerge: boolean

beforeEach(async () => {
  clearQueueState()
  vi.clearAllMocks()
  vi.mocked(retrieveEvidence).mockImplementation(async (request) => ({
    status: "completed", evidence: (useWikiStore.getState().embeddingConfig.enabled ? request.scope?.includePaths ?? [] : []).filter((path) => path.endsWith("redis-cache.md")).map((path) => ({ path })),
    relations: [], targetResults: [], execution: { warnings: [] },
  } as unknown as Awaited<ReturnType<typeof retrieveEvidence>>))
  vi.mocked(writeFile).mockImplementation(realFs.writeFile)
  temp = await createTempProject("conversation-ingest")
  verdict = "same"
  pending = true
  failMerge = false
  await writeFileRaw(`${temp.path}/schema.md`, "# Schema\nPreserve provenance and independent topics.")
  await writeFileRaw(`${temp.path}/${existingPath}`, original)
  await writeFileRaw(`${temp.path}/${sourcePath}`, "# Cache Strategy\nNew cache invalidation evidence.")
  useWikiStore.setState({
    project: { id: "conversation-ingest", name: "对话入库测试", path: temp.path },
    outputLanguage: "auto",
    sourceWatchConfig: { ...useWikiStore.getState().sourceWatchConfig, enabled: false, autoIngest: false },
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: true, model: "test", endpoint: "http://embedding.invalid" },
  })
  useWikiStore.getState().setLlmConfig({
    ...useWikiStore.getState().llmConfig, provider: "openai", apiKey: "test", model: "test", maxContextSize: 128000,
  })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_conversation_ingests") return pending ? [{ id: "a".repeat(64), sourcePath, requestedPath }] : []
    if (command === "acknowledge_conversation_ingest") { pending = false; return undefined }
    return undefined
  })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    let response = "Analysis of confirmed conversation knowledge."
    if (system.includes("generate wiki files")) {
      response = `---FILE: ${requestedPath}---\n${incoming}\n---END FILE---`
    } else if (system.startsWith("核对新知识页和候选页")) {
      response = JSON.stringify({ decisions: [{ path: existingPath, verdict }] })
    } else if (system.startsWith("You are merging ")) {
      if (failMerge) { callbacks.onError(new Error("merge unavailable")); return }
      response = `${incoming}\nExisting expiry rules must remain.`
    }
    callbacks.onToken(response)
    callbacks.onDone()
  })
  await restoreQueue("conversation-ingest", temp.path)
})

afterEach(async () => {
  await pauseQueue()
  clearQueueState()
  await temp.cleanup()
})

async function transfer(): Promise<void> {
  await transferConversationIngests(useWikiStore.getState().project!)
}

describe("对话材料复用文件上传的入库契约", () => {
  it("自动监控关闭时仍入库，语义重复复用旧页并保留新旧事实、来源及索引", async () => {
    await transfer()
    await vi.waitFor(async () => {
      const content = await readFileRaw(`${temp.path}/${existingPath}`)
      expect(content).toContain("New cache invalidation evidence.")
      expect(getQueue()).toHaveLength(0)
    })
    const content = await readFileRaw(`${temp.path}/${existingPath}`)
    expect(content).toContain("Existing expiry rules must remain.")
    expect(content).toContain("manual.md")
    expect(content).toContain(`conversations/${"a".repeat(64)}.md`)
    expect(await fileExists(`${temp.path}/${requestedPath}`)).toBe(false)
    expect(await readFileRaw(`${temp.path}/${sourcePath}`)).toContain("New cache invalidation evidence.")
    expect(await readFileRaw(`${temp.path}/wiki/index.md`)).toContain("redis-cache")
    expect(embedPage).toHaveBeenCalled()
    expect(pending).toBe(false)
  })

  it("相似但主题不同保留独立知识页", async () => {
    verdict = "different"
    await transfer()
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(await readFileRaw(`${temp.path}/${existingPath}`)).toBe(original)
    expect(await readFileRaw(`${temp.path}/${requestedPath}`)).toContain("New cache invalidation evidence.")
  })

  it("未开启语义检索时沿用文件上传规则，不冒充已完成跨名称语义查重", async () => {
    useWikiStore.setState({ embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false } })
    await transfer()
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
    expect(await readFileRaw(`${temp.path}/${existingPath}`)).toBe(original)
    expect(await readFileRaw(`${temp.path}/${requestedPath}`)).toContain("New cache invalidation evidence.")
    expect(embedPage).not.toHaveBeenCalled()
  })

  it("未配置入库模型时留在公共队列等待，不丢材料或误报完成", async () => {
    useWikiStore.getState().setLlmConfig({ ...useWikiStore.getState().llmConfig, apiKey: "", model: "" })
    await transfer()
    await vi.waitFor(() => expect(getQueue()[0]?.error).toContain("LLM not configured"))
    expect(getQueue()).toMatchObject([{ sourcePath, status: "pending" }])
    expect(streamChat).not.toHaveBeenCalled()
    expect(await fileExists(`${temp.path}/${sourcePath}`)).toBe(true)
    expect(pending).toBe(false)
  })

  it.each(["uncertain", "merge-failed"])("%s 区分内容判断与环境故障并保留旧候选", async (mode) => {
    verdict = mode === "uncertain" ? "uncertain" : "same"
    failMerge = mode === "merge-failed"
    await transfer()
    if (mode === "merge-failed") {
      await vi.waitFor(() => expect(getQueue()[0]?.status).toBe("failed"))
      expect(await fileExists(`${temp.path}/${requestedPath}`)).toBe(false)
      expect(await fileExists(`${temp.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
    } else {
      await vi.waitFor(() => expect(getQueue()).toHaveLength(0))
      expect(await fileExists(`${temp.path}/${requestedPath}`)).toBe(true)
      const [run] = await listIngestRuns(temp.path)
      expect(run.events.some((event) => event.kind === "merge")).toBe(true)
      expect(run.reviewRequested).toBe(false)
      expect(run.review).toBeDefined()
    }
    expect(await readFileRaw(`${temp.path}/${existingPath}`)).toBe(original)
    if (mode === "uncertain") expect(useReviewStore.getState().items).toEqual([expect.objectContaining({ type: "merge", affectedPages: expect.arrayContaining([existingPath, requestedPath]) })])
    else expect(useReviewStore.getState().items).toEqual([])
  })

  it("队列落盘失败时不确认凭据，恢复后可重新交接", async () => {
    pauseProcessing()
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"))
    await expect(transfer()).rejects.toThrow("入库队列未能持久化")
    expect(pending).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith("acknowledge_conversation_ingest", expect.anything())
    await transfer()
    expect(pending).toBe(false)
    const persisted = JSON.parse(await readFileRaw(`${temp.path}/.llm-wiki/ingest-queue.json`))
    expect(persisted).toMatchObject([{ sourcePath, status: "pending" }])
  })

  it("交接后未确认就重启时不重置已有取消任务", async () => {
    const task = { id: "existing", projectId: "conversation-ingest", sourcePath, folderContext: "", status: "cancelled", addedAt: 0, retryCount: 0, error: null }
    await writeFileRaw(`${temp.path}/.llm-wiki/ingest-queue.json`, JSON.stringify([task]))
    clearQueueState()
    await restoreQueue("conversation-ingest", temp.path)
    await transfer()
    expect(pending).toBe(false)
    expect(getQueue()).toMatchObject([{ status: "cancelled" }])
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("读取凭据期间切换项目，不向其他项目交接也不确认原凭据", async () => {
    vi.mocked(invoke).mockImplementationOnce(async () => {
      useWikiStore.setState({ project: { id: "other", name: "Other", path: "/other" } })
      return [{ id: "a".repeat(64), sourcePath, requestedPath }]
    })
    await transferConversationIngests({ id: "conversation-ingest", name: "Test", path: temp.path })
    expect(pending).toBe(true)
    expect(getQueue()).toHaveLength(0)
    expect(streamChat).not.toHaveBeenCalled()
  })
})
