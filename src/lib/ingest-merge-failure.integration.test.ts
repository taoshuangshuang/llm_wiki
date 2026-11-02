import { retrieveEvidence } from "./evidence-retrieval"
/** 从真实入库及队列入口验证合并失败保护；仅模拟模型与向量服务，文件读写使用临时目录。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
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
  vectorSearchChunks: vi.fn(async () => [{ page_id: "concepts/shared", score: 0.9 }]),
  embedPage: vi.fn(async () => true),
}))

import { listIngestRuns } from "./ingest-run"
import { autoIngest } from "./ingest"
import { streamChat } from "./llm-client"
import { clearQueueState, enqueueIngest, getQueue, pauseQueue, restoreQueue } from "./ingest-queue"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

type TargetKind = "同路径" | "跨目录同名" | "语义复用"
type FailureKind = "模型报错" | "输出截断" | "格式错误" | "正文过短"
const original = '---\ntype: concept\ntitle: Shared\nsources: [other.md]\ntags: [manual]\n---\n# Shared\nOld evidence must survive a failed merge.'
const incoming = '---\ntype: concept\ntitle: Shared\nsources: [incoming.md]\n---\n# Shared\nNew evidence from the incoming source.'
const merged = `${incoming}\nOld evidence must survive a failed merge.`
let project: Awaited<ReturnType<typeof createTempProject>>
let requestedPath: string
let targetPath: string
let failure: FailureKind
let failuresRemaining: number
let mergeCalls: number

beforeEach(async () => {
  clearQueueState()
  vi.clearAllMocks()
  vi.mocked(retrieveEvidence).mockImplementation(async (request) => ({
    status: "completed", evidence: useWikiStore.getState().embeddingConfig.enabled && request.scope?.includePaths?.includes(targetPath) ? [{ path: targetPath }] : [],
    relations: [], targetResults: [], execution: { warnings: [] },
  } as unknown as Awaited<ReturnType<typeof retrieveEvidence>>))
  project = await createTempProject("ingest-merge-failure")
  requestedPath = targetPath = "wiki/concepts/shared.md"
  failure = "模型报错"
  failuresRemaining = Infinity
  mergeCalls = 0
  await writeFileRaw(`${project.path}/schema.md`, "# Schema\nContent pages preserve their sources.")
  await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "New evidence from the incoming source.")
  useWikiStore.setState({
    project: { id: "merge-failure", name: "merge-failure", path: project.path },
    outputLanguage: "auto",
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false, model: "test", endpoint: "http://embedding.invalid" },
  })
  useWikiStore.getState().setLlmConfig({
    ...useWikiStore.getState().llmConfig, provider: "openai", apiKey: "test", model: "test", maxContextSize: 128000,
  })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    if (system.startsWith("You are merging ")) {
      mergeCalls++
      if (failuresRemaining-- > 0) {
        if (failure === "模型报错") {
          callbacks.onError(new Error("Model unavailable"))
          return
        }
        if (failure === "输出截断") {
          // 即使正文够长，截断标记也必须拒绝，不能将半截结果写入旧页。
          callbacks.onToken(merged)
          callbacks.onDone({ finishReason: "length", truncated: true })
          return
        }
        callbacks.onToken(failure === "格式错误" ? "No frontmatter returned." : "---\ntitle: Shared\n---\nx")
        callbacks.onDone()
        return
      }
      callbacks.onToken(merged)
    } else if (system.startsWith("核对新知识页和候选页")) {
      callbacks.onToken(JSON.stringify({ decisions: [{ path: targetPath, verdict: "same" }] }))
    } else if (system.includes("generate wiki files")) {
      callbacks.onToken(`---FILE: ${requestedPath}---\n${incoming}\n---END FILE---`)
    } else {
      callbacks.onToken("Analysis of the incoming source.")
    }
    callbacks.onDone()
  })
})

afterEach(async () => {
  await pauseQueue()
  clearQueueState()
  await project.cleanup()
})

/** 仅改变既有页的位置或名称，三种路径共用真实查重、模型合并及磁盘提交链路。 */
async function prepareTarget(kind: TargetKind): Promise<void> {
  if (kind === "跨目录同名") targetPath = "wiki/entities/shared.md"
  if (kind === "语义复用") {
    requestedPath = "wiki/concepts/new-topic.md"
    useWikiStore.setState({ embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: true } })
  }
  await writeFileRaw(`${project.path}/${targetPath}`, original)
}

const targetKinds: TargetKind[] = ["同路径", "跨目录同名", "语义复用"]
const failureKinds: FailureKind[] = ["模型报错", "输出截断", "格式错误", "正文过短"]

it("旧模板返回完整正文时只记录协议兼容事件，不虚构合并问题", async () => {
  await prepareTarget("同路径")
  failuresRemaining = 0
  await autoIngest(project.path, `${project.path}/raw/sources/incoming.md`, useWikiStore.getState().llmConfig)
  const [run] = await listIngestRuns(project.path)
  expect(run.events.filter((event) => event.reason === "旧合并返回未明确内容歧义，需后台复核")).toMatchObject([{ kind: "execution", path: targetPath }])
  expect(run.events.filter((event) => event.kind === "merge")).toEqual([])
  expect(await readFileRaw(`${project.path}/${targetPath}`)).toContain("Old evidence must survive")
})

describe.each(targetKinds)("%s合并失败的磁盘契约", (kind) => {
  it.each(failureKinds)("%s一轮修复仍失败后保留旧页与完整新稿", async (mode) => {
    await prepareTarget(kind)
    failure = mode
    const written = await autoIngest(project.path, `${project.path}/raw/sources/incoming.md`, useWikiStore.getState().llmConfig)
    expect(await readFileRaw(`${project.path}/${targetPath}`)).toBe(original)
    const [run] = await listIngestRuns(project.path)
    const independent = Object.values(run.pages).find((page) => page.mode === "independent")!
    expect(independent).toBeDefined()
    expect(written).toContain(independent.path)
    expect(independent.before).toBeNull()
    expect(independent.after).toContain("New evidence from the incoming source")
    expect(run.repairAttempts).toMatchObject([{ stage: "merge", status: "failed" }])
    expect(run.events.filter((event) => event.reviewRequired)).toMatchObject([{ kind: "merge", outcome: expect.stringContaining("保留旧页与完整新稿") }])
    expect(mergeCalls).toBe(2)
  })
})

describe.each(targetKinds.slice(0, 3))("%s合并失败的队列恢复", (kind) => {
  it("队列不因合并失败反复重新入库，保留失败账本及独立新稿", async () => {
    await prepareTarget(kind)
    await restoreQueue("merge-failure", project.path)
    await enqueueIngest("merge-failure", "raw/sources/incoming.md")
    await vi.waitFor(() => { expect(mergeCalls).toBe(2); expect(getQueue()).toHaveLength(0) })
    await pauseQueue()
    const [run] = await listIngestRuns(project.path)
    expect(run.repairAttempts?.[0].status).toBe("failed")
    expect(Object.values(run.pages).some((page) => page.mode === "independent")).toBe(true)
    expect(await readFileRaw(`${project.path}/${targetPath}`)).toBe(original)
  })

  it("首次失败后重新入库成功，保留新旧事实并移除队列任务", async () => {
    await prepareTarget(kind)
    failuresRemaining = 1
    await restoreQueue("merge-failure", project.path)
    await enqueueIngest("merge-failure", "raw/sources/incoming.md")
    await vi.waitFor(() => {
      expect(mergeCalls).toBe(2)
      expect(getQueue()).toHaveLength(0)
    })
    const content = await readFileRaw(`${project.path}/${targetPath}`)
    expect(content).toContain("Old evidence must survive")
    expect(content).toContain("New evidence from the incoming source")
    expect(content).toContain("other.md")
    expect(content).toContain("incoming.md")
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(true)
  })
})
