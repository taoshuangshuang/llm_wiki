/** 用可控模型等待验证项目锁释放和并发编辑保护，不依赖真实模型耗时。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createDeferred, flushIO } from "@/test-helpers/deferred"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./ingest-acceptance", () => ({ runIngestAcceptance: vi.fn() }))
vi.mock("./embedding", async (importOriginal) => ({
  ...await importOriginal<typeof import("./embedding")>(),
  embedPage: vi.fn(async () => true),
}))

import { retrieveEvidence } from "./evidence-retrieval"
import { autoIngest } from "./ingest"
import { streamChat } from "./llm-client"
import { runIngestAcceptance } from "./ingest-acceptance"
import { embedPage } from "./embedding"
import { withProjectLock } from "./project-mutex"
import { IngestCommitCoordinator } from "./ingest-commit-coordinator"
import { DEFAULT_INGEST_PROMPTS } from "./ingest-prompts"
import { IngestSemanticRecall } from "./ingest-semantic"
import * as ingestCache from "./ingest-cache"
import { listIngestRuns } from "./ingest-run"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

type Stage = "merge" | "classification" | "acceptance" | "embedding"
const target = "wiki/concepts/shared.md"
const original = '---\ntype: concept\ntitle: Shared\nsources: [other.md]\n---\n# Shared\nOld evidence.'
const incoming = '---\ntype: concept\ntitle: Shared\nsources: [incoming.md]\n---\n# Shared\nIncoming evidence.'
let project: Awaited<ReturnType<typeof createTempProject>>
let stage: Stage
let entered: ReturnType<typeof createDeferred<void>>
let release: ReturnType<typeof createDeferred<void>>
let running: Promise<unknown>[]

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(retrieveEvidence).mockResolvedValue({ status: "completed", evidence: [], relations: [], targetResults: [], execution: { warnings: [] } } as unknown as Awaited<ReturnType<typeof retrieveEvidence>>)
  project = await createTempProject("ingest-lock")
  stage = "merge"
  entered = createDeferred()
  release = createDeferred()
  running = []
  await writeFileRaw(`${project.path}/schema.md`, "# Schema")
  await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "Incoming evidence.")
  await writeFileRaw(`${project.path}/${target}`, original)
  useWikiStore.setState({
    project: { id: "ingest-lock", name: "ingest-lock", path: project.path },
    outputLanguage: "auto",
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false, model: "test" },
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
  })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    let response = "Source analysis."
    if (system.startsWith("核对新知识页和候选页")) {
      const input = JSON.parse(String(messages[1].content))
      callbacks.onToken(JSON.stringify({ decisions: input.candidates.map((page: { path: string }) => ({ path: page.path, verdict: "same" })) }))
      callbacks.onDone()
      return
    }
    if (system.startsWith("You are merging ")) {
      await waitAt("merge")
      response = `${incoming}\nOld evidence.`
    } else if (system.includes("业务模块分类器")) {
      await waitAt("classification")
      response = '{"moduleIds":["query"]}'
    } else if (system.includes("generate wiki files")) {
      response = `---FILE: ${target}---\n${incoming}\n---END FILE---`
    }
    callbacks.onToken(response)
    callbacks.onDone()
  })
  vi.mocked(runIngestAcceptance).mockImplementation(async () => {
    await waitAt("acceptance")
    return { report: { sourceIdentity: "incoming.md", status: "clear", rounds: [], updatedAt: 0 }, reviews: [] }
  })
  vi.mocked(embedPage).mockImplementation(async () => { await waitAt("embedding"); return true })
})

afterEach(async () => {
  release.resolve()
  await Promise.allSettled(running)
  await project.cleanup()
})

async function waitAt(current: Stage): Promise<void> {
  if (stage !== current) return
  entered.resolve()
  await release.promise
}

function ingest(signal?: AbortSignal): Promise<string[]> {
  const config = { ...useWikiStore.getState().llmConfig, apiKey: "test", model: "test", maxContextSize: 128000 }
  const operation = autoIngest(project.path, `${project.path}/raw/sources/incoming.md`, config, signal)
  running.push(operation)
  return operation
}

describe("自动入库的项目锁", () => {
  it("全部页面提交后保存缓存失败，保留写入成功状态并登记后续异常", async () => {
    // 缓存保存发生在全部知识页提交之后，失败不能将已经完成的写入降级为部分写入。
    stage = "acceptance"
    const save = vi.spyOn(ingestCache, "saveIngestCache").mockRejectedValueOnce(new Error("cache storage unavailable"))
    try {
      await expect(ingest()).rejects.toThrow("cache storage unavailable")
      const [run] = await listIngestRuns(project.path)
      expect(run.writeStatus).toBe("complete")
      expect(run.error).toBe("cache storage unavailable")
      expect(run.writeError).toBeUndefined()
      expect(await readFileRaw(`${project.path}/${target}`)).toContain("Incoming evidence.")
    } finally { save.mockRestore() }
  })

  it.each<Stage>(["merge", "classification", "embedding"])("等待 %s 时其他操作可以取得项目锁", async (current) => {
    stage = current
    if (stage === "classification") await writeFileRaw(`${project.path}/schema.md`, '## Business Modules\n```json\n{"version":1,"modules":[{"id":"query","name":"Query","description":"Query knowledge"}]}\n```')
    if (stage === "embedding") useWikiStore.setState({ embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: true } })
    const operation = ingest()
    await entered.promise
    let acquired = false
    const other = withProjectLock(project.path, async () => { acquired = true })
    running.push(other)
    await flushIO(10)
    expect(acquired).toBe(true)
    release.resolve()
    await operation
  })

  it.each<Stage>(["merge", "classification"])("等待 %s 期间旧页被编辑，拒绝覆盖并保留用户版本", async (current) => {
    stage = current
    if (stage === "classification") await writeFileRaw(`${project.path}/schema.md`, '## Business Modules\n```json\n{"version":1,"modules":[{"id":"query","name":"Query","description":"Query knowledge"}]}\n```')
    const operation = ingest()
    await entered.promise
    const edited = `${original}\nUser edit while waiting.`
    await writeFileRaw(`${project.path}/${target}`, edited)
    const rejected = expect(operation).rejects.toThrow("Ingest incomplete")
    release.resolve()
    await rejected
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(edited)
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
  })

  it("首个来源等待合并时，后续来源等待当前来源结束后再执行", async () => {
    const coordinator = new IngestCommitCoordinator()
    const first = coordinator.reserve()
    const second = coordinator.reserve()
    const config = { ...useWikiStore.getState().llmConfig, apiKey: "test", model: "test", maxContextSize: 128000 }
    const firstRun = autoIngest(project.path, `${project.path}/raw/sources/incoming.md`, config,
      undefined, undefined, undefined, { runCommit: first.runCommit })
    running.push(firstRun)
    await entered.promise
    const secondPath = "wiki/concepts/second.md"
    await writeFileRaw(`${project.path}/raw/sources/second.md`, "Independent source evidence.")
    const originalMock = vi.mocked(streamChat).getMockImplementation()!
    vi.mocked(streamChat).mockImplementation(async (config, messages, callbacks, signal, overrides) => {
      if (String(messages[0].content).includes("generate wiki files") && JSON.parse(String(messages[1].content)).source_identity === "second.md") {
        callbacks.onToken(`---FILE: ${secondPath}---\n${incoming.replace(/incoming\.md/g, "second.md")}\n---END FILE---`)
        callbacks.onDone()
      } else await originalMock(config, messages, callbacks, signal, overrides)
    })
    const secondRun = autoIngest(project.path, `${project.path}/raw/sources/second.md`, config,
      undefined, undefined, undefined, { runCommit: second.runCommit })
    running.push(secondRun)
    expect(await fileExists(`${project.path}/${secondPath}`)).toBe(false)
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(original)
    release.resolve()
    await firstRun
    await secondRun
    expect(await fileExists(`${project.path}/${secondPath}`)).toBe(true)
    const cache = JSON.parse(await readFileRaw(`${project.path}/.llm-wiki/ingest-cache.json`))
    expect(Object.keys(cache.entries).sort()).toEqual(["incoming.md", "second.md"])
    const log = await readFileRaw(`${project.path}/wiki/log.md`)
    expect(log).toContain("incoming.md")
    expect(log).toContain("second.md")
  })

  it("等待模型期间来源被修改时，停止提交旧版本来源的结果", async () => {
    const operation = ingest()
    await entered.promise
    await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "Changed source with additional facts.")
    const rejected = expect(operation).rejects.toThrow("来源在处理期间已变化")
    release.resolve()
    await rejected
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(original)
  })

  it.each(["跨目录同名", "相似主题", "无关主题"])("模型等待期间新增%s页，按原决策完成写入并交后台审阅", async (mode) => {
    useWikiStore.setState({ embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: true } })
    const addedPath = mode === "跨目录同名" ? "wiki/entities/shared.md" : `wiki/concepts/${mode === "相似主题" ? "related" : "unrelated"}.md`
    const addedContent = '---\ntype: concept\ntitle: Added\nsources: [second.md]\n---\n# Added\nSecond source evidence.'
    const operation = ingest()
    await entered.promise
    await withProjectLock(project.path, () => writeFileRaw(`${project.path}/${addedPath}`, addedContent))
    release.resolve()
    await expect(operation).resolves.toContain(target)
    expect(await readFileRaw(`${project.path}/${target}`)).toContain("Incoming evidence.")
    expect(await readFileRaw(`${project.path}/${target}`)).toContain("Old evidence.")
    expect(await readFileRaw(`${project.path}/${addedPath}`)).toBe(addedContent)
    // 新增页的重复检查交后台审阅；提交前不再检索或调用模型复核新增候选。
    expect(vi.mocked(retrieveEvidence).mock.calls.some(([request]) => request.scope?.includePaths?.includes(addedPath))).toBe(false)
    const comparisons = vi.mocked(streamChat).mock.calls.filter(([, messages]) => String(messages[0].content).startsWith("核对新知识页和候选页"))
    expect(comparisons).toHaveLength(1)
    expect(JSON.parse(String(comparisons[0][1][1].content)).candidates).toEqual([{ path: target, content: original }])
    expect(vi.mocked(streamChat).mock.calls.filter(([, messages]) => String(messages[0].content).startsWith("You are merging "))).toHaveLength(1)
    const [run] = await listIngestRuns(project.path)
    expect(run.writeStatus).toBe("complete")
    expect(run.writeError).toBeUndefined()
    expect(run.reviewRequested).toBe(false)
      expect(run.review).toBeDefined()
  })

  it("模型等待期间新建路径被占用，保留占用者内容并拒绝覆盖", async () => {
    stage = "classification"
    await realFs.deleteFile(`${project.path}/${target}`)
    await writeFileRaw(`${project.path}/schema.md`, '## Business Modules\n```json\n{"version":1,"modules":[{"id":"query","name":"Query","description":"Query knowledge"}]}\n```')
    const operation = ingest()
    await entered.promise
    const occupied = "# 并发写入\n其他来源已经使用该路径。"
    await withProjectLock(project.path, () => writeFileRaw(`${project.path}/${target}`, occupied))
    const rejected = expect(operation).rejects.toThrow("页面在模型处理期间已变化")
    release.resolve()
    await rejected
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(occupied)
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
  })

  it("等待模型期间取消，不再写入页面或成功缓存", async () => {
    const controller = new AbortController()
    const operation = ingest(controller.signal)
    await entered.promise
    controller.abort()
    const rejected = expect(operation).rejects.toThrow("cancelled")
    release.resolve()
    await rejected
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(original)
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
  })

  it("缓存命中的重分类不持有项目锁，并保留分类期间的人工修改", async () => {
    const schema = '## Business Modules\n```json\n{"version":1,"modules":[{"id":"query","name":"Query","description":"Query knowledge"}]}\n```'
    await writeFileRaw(`${project.path}/schema.md`, schema)
    stage = "embedding" // 未启用 embedding，首次入库正常完成。
    await ingest()
    stage = "classification"
    const operation = ingest()
    await entered.promise
    const edited = `${original}\nUser edited the cached page.`
    await withProjectLock(project.path, () => writeFileRaw(`${project.path}/${target}`, edited))
    release.resolve()
    await operation
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(edited)
    expect(vi.mocked(streamChat).mock.calls.filter(([, messages]) => String(messages[0].content).includes("generate wiki files"))).toHaveLength(1)
  })

  it("审阅基于提交快照，页面变化后结果保留为待核对", async () => {
    const { runIngestAcceptance: inspect } = await vi.importActual<typeof import("./ingest-acceptance")>("./ingest-acceptance")
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      expect(JSON.parse(String(messages[1].content)).pages[target]).toBe(original)
      entered.resolve()
      await release.promise
      callbacks.onToken('{"summary":"已核对提交版本","issues":[]}')
      callbacks.onDone()
    })
    const operation = inspect({
      projectPath: project.path, sourceIdentity: "incoming.md", sourcePath: `${project.path}/raw/sources/incoming.md`,
      sourceContent: "Old evidence.", schema: "# Schema", purpose: "", writtenPaths: [target],
      llmConfig: { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }, prompts: DEFAULT_INGEST_PROMPTS,
      pageSnapshot: { pages: { [target]: original }, knownPagePaths: [target] },
    })
    running.push(operation)
    await entered.promise
    const edited = `${original}\nNewer page version.`
    await withProjectLock(project.path, () => writeFileRaw(`${project.path}/${target}`, edited))
    release.resolve()
    const result = await operation
    expect(result.report.status).toBe("pending-review")
    expect(result.report.error).toContain("审阅期间页面已变化")
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(edited)
  })

  it("其他来源可召回已落盘但尚未完成向量索引的页面", async () => {
    vi.mocked(retrieveEvidence).mockResolvedValue({ status: "completed", evidence: [{ path: target }], relations: [], targetResults: [], execution: { warnings: [] } } as unknown as Awaited<ReturnType<typeof retrieveEvidence>>)
    const config = { ...useWikiStore.getState().embeddingConfig, enabled: true, model: "test", endpoint: "http://embedding.invalid" }
    const first = new IngestSemanticRecall(project.path, config, () => {})
    first.remember(target, original)
    const second = new IngestSemanticRecall(project.path, config, () => {})
    expect(await second.find("Related evidence", [target])).toEqual([target])
    expect(vi.mocked(retrieveEvidence).mock.calls[0][0]).toEqual(expect.objectContaining({ projectPath: project.path, scene: "ingest" }))
  })
})
