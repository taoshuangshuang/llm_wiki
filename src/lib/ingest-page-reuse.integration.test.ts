vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string, args) => command === "wiki_reference_context" ? referenceContextFromFiles(args) : undefined) }))
import { referenceContextFromFiles } from "@/test-helpers/reference-context"
import { retrieveEvidence } from "./evidence-retrieval"
/** 从自动入库入口验证三种候选来源的统一契约，使用真实临时文件系统，仅模拟模型和向量服务。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./ingest-acceptance", () => ({
  runIngestAcceptance: vi.fn(async () => ({ report: { status: "clear", rounds: [] }, reviews: [] })),
}))
vi.mock("./embedding", async (original) => ({
  ...await original<typeof import("./embedding")>(),
  fetchEmbedding: vi.fn(async () => [1, 0]),
  vectorSearchChunks: vi.fn(async () => []),
  embedPage: vi.fn(async () => true),
}))

import { listIngestRuns } from "./ingest-run"
import { autoIngest } from "./ingest"
import { streamChat } from "./llm-client"
import { vectorSearchChunks } from "./embedding"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"

type Origin = "同路径" | "跨目录同名" | "语义召回"
type Verdict = "same" | "different" | "uncertain"
const origins: Origin[] = ["同路径", "跨目录同名", "语义召回"]
const requested = "wiki/concepts/cache.md"
const original = '---\ntype: concept\ntitle: Cache\ncreated: 2020-01-01\nsources: [other.md]\n---\n# Cache\nOld cache evidence. [[cache|旧主题]]'
const incoming = '---\ntype: concept\ntitle: Cache\nsources: [incoming.md]\nrelated: [cache]\n---\n# Cache\nNew cache evidence. [[cache#Details|本页]]\n```text\n[[cache]]\n```'
let project: Awaited<ReturnType<typeof createTempProject>>
let target: string
let verdict: Verdict
let responseOverride: string | undefined
let truncated: boolean
let modelError: boolean
let rewriteSource: boolean
let generation: string
let decisionsByPath: Record<string, Verdict>
let compareInputs: Array<{ incoming: string; candidates: Array<{ path: string; content: string }> }>
let mergeCalls: number

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(retrieveEvidence).mockImplementation(async (request) => ({
    status: "completed", evidence: useWikiStore.getState().embeddingConfig.enabled && request.scope?.includePaths?.includes(target) ? [{ path: target }] : [],
    relations: [], targetResults: [], execution: { warnings: [] },
  } as unknown as Awaited<ReturnType<typeof retrieveEvidence>>))
  project = await createTempProject("unified-page-reuse")
  target = requested
  verdict = "same"
  responseOverride = undefined
  truncated = modelError = rewriteSource = false
  generation = `---FILE: ${requested}---\n${incoming}\n---END FILE---`
  decisionsByPath = {}
  compareInputs = []
  mergeCalls = 0
  await writeFileRaw(`${project.path}/schema.md`, "# Schema\nPreserve independent topics and source evidence.")
  await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "New cache evidence.")
  useWikiStore.setState({
    project: { id: "unified-page-reuse", name: "Test", path: project.path }, outputLanguage: "auto",
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false, model: "test", endpoint: "http://embedding.invalid" },
  })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  vi.mocked(vectorSearchChunks).mockResolvedValue([])
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    let response = "Source analysis."
    if (system.includes("generate wiki files")) response = generation
    else if (system.startsWith("核对新知识页和候选页")) {
      const input = JSON.parse(String(messages[1].content))
      compareInputs.push(input)
      if (rewriteSource) await writeFileRaw(`${project.path}/${target}`, `${original}\nConcurrent edit.`)
      if (modelError) { callbacks.onError(new Error("comparison unavailable")); return }
      response = responseOverride ?? JSON.stringify({ decisions: input.candidates.map((page: { path: string }) => ({
        path: page.path, verdict: decisionsByPath[page.path] ?? verdict,
      })) })
    } else if (system.startsWith("You are merging ")) {
      mergeCalls++
      // 合并 Mock 保留双方完整正文，使测试只判断目标选择、来源和写入契约。
      const input = JSON.parse(String(messages[1].content))
      response = `${input.previously_collected_material.content}\n${input.additional_material.content}`
    }
    callbacks.onToken(response)
    callbacks.onDone({ truncated: truncated && system.startsWith("核对新知识页和候选页") })
  })
})

afterEach(async () => { await project.cleanup() })

/** 只改变旧页的召回渠道，其余入库材料与断言相同。 */
async function prepare(origin: Origin, content = original): Promise<void> {
  if (origin === "跨目录同名") target = "wiki/references/cache.md"
  if (origin === "语义召回") {
    target = "wiki/concepts/expiry.md"
    useWikiStore.setState({ embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: true } })
    vi.mocked(vectorSearchChunks).mockResolvedValue([{ page_id: "concepts/expiry", score: 0.95, chunk_id: "expiry-0", chunk_index: 0, chunk_text: "Old cache evidence.", heading_path: "Cache" }])
  }
  await writeFileRaw(`${project.path}/${target}`, content)
}

function ingest(): Promise<string[]> {
  return autoIngest(project.path, `${project.path}/raw/sources/incoming.md`, {
    ...useWikiStore.getState().llmConfig, apiKey: "test", model: "test", maxContextSize: 128000,
  })
}

it("异名归并后统一维护历史入链，按最终正文保留章节或退回页面，持久化目标映射", async () => {
  await prepare("语义召回", `${original}\n## 保留章节\n说明。`)
  const history = "wiki/concepts/history.md"
  await writeFileRaw(`${project.path}/${history}`, '---\ntype: concept\ntitle: 历史\nsources: [history.md]\nrelated: [cache]\n---\n# 历史\n[[cache#保留章节|说明]] [[cache#Details]] [[未知页面]]')
  const written = await ingest()
  expect(written).toContain(history)
  const after = await readFileRaw(`${project.path}/${history}`)
  expect(after).toContain("[[expiry#保留章节|说明]] [[expiry]] [[未知页面]]")
  expect(await readFileRaw(`${project.path}/${target}`)).toContain("[[expiry|本页]]")
  const runs = await listIngestRuns(project.path)
  expect(runs[0].linkRedirects).toMatchObject({ cache: target, "concepts/cache": target })
  expect(runs[0].pages[history]?.mode).toBe("maintenance")
})

describe.each(origins)("%s候选使用相同核对和写入规则", (origin) => {
  it("唯一同主题目标被复用，完整材料送入核对并保留双方事实和来源", async () => {
    await prepare(origin)
    const written = await ingest()
    expect(compareInputs).toHaveLength(1)
    expect(compareInputs[0].candidates).toEqual([{ path: target, content: original }])
    expect(compareInputs[0].incoming).toContain("New cache evidence.")
    // 异名旧页走共享召回时，页面标题与正文分别传递；同名唯一候选不需要额外检索。
    if (origin === "语义召回") expect(vi.mocked(retrieveEvidence).mock.calls.some(([request]) => request.scene === "ingest" && request.targets[0]?.title === "Cache")).toBe(true)
    expect(written).toContain(target)
    const saved = await readFileRaw(`${project.path}/${target}`)
    expect(saved).toContain("Old cache evidence.")
    expect(saved).toContain("New cache evidence.")
    expect(saved).toContain("other.md")
    expect(saved).toContain("incoming.md")
    expect(saved).toContain("2020-01-01")
    if (target !== requested) expect(await fileExists(`${project.path}/${requested}`)).toBe(false)
  })

  it("全部不同则独立建页，名称冲突分配唯一文件名并保持旧页及代码示例不变", async () => {
    await prepare(origin)
    verdict = "different"
    const written = await ingest()
    const newPath = origin === "语义召回" ? requested : "wiki/concepts/cache-2.md"
    expect(written).toContain(newPath)
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(original)
    const saved = await readFileRaw(`${project.path}/${newPath}`)
    expect(saved).toContain("New cache evidence.")
    expect(saved).not.toContain("Old cache evidence.")
    if (newPath !== requested) expect(saved).toContain("[[cache-2#Details|本页]]")
    expect(saved).toContain("```text\n[[cache]]\n```")
    expect(mergeCalls).toBe(0)
  })

  it("来源独占的旧页也合并保留双方说法，不因召回渠道改为覆盖", async () => {
    await prepare(origin, original.replace("other.md", "incoming.md"))
    await ingest()
    const saved = await readFileRaw(`${project.path}/${target}`)
    expect(saved).toContain("New cache evidence.")
    expect(saved).toContain("Old cache evidence.")
    expect(mergeCalls).toBe(1)
  })

  it.each(["uncertain", "模型失败", "输出截断", "旧布尔协议", "遗漏候选", "未知候选", "重复候选"])("%s按环境故障或另存策略处理，保留候选旧页", async (mode) => {
    await prepare(origin)
    if (mode === "uncertain") verdict = "uncertain"
    if (mode === "模型失败") modelError = true
    if (mode === "输出截断") truncated = true
    if (mode === "旧布尔协议") responseOverride = '{"sameTopic":true}'
    if (mode === "遗漏候选") responseOverride = '{"decisions":[]}'
    if (mode === "未知候选") responseOverride = '{"decisions":[{"path":"wiki/concepts/unknown.md","verdict":"same"}]}'
    if (mode === "重复候选") responseOverride = JSON.stringify({ decisions: [{ path: target, verdict: "same" }, { path: target, verdict: "same" }] })
    if (mode === "模型失败") {
      await expect(ingest()).rejects.toThrow("Ingest incomplete")
      expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
      expect(useReviewStore.getState().items).toEqual([])
    } else {
      const written = await ingest()
      const newPath = written.find((path) => path !== target && !["wiki/log.md", "wiki/index.md"].includes(path))!
      expect(await readFileRaw(`${project.path}/${newPath}`)).toContain("New cache evidence.")
      const [run] = await listIngestRuns(project.path)
      expect(run.events.some((event) => event.kind === "merge" && event.outcome.includes("另存"))).toBe(true)
      expect(run.events).toContainEqual(expect.objectContaining({
        kind: "merge", path: newPath, candidates: [target], candidateSnapshots: { [target]: original },
        details: expect.stringContaining(target),
      }))
      expect(run.reviewRequested).toBe(false)
      expect(run.review).toBeDefined()
      expect(run.writeStatus).toBe("complete")
    }
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(original)
  })
})

describe("三种渠道合并候选后统一决策", () => {
  async function prepareMixed(): Promise<void> {
    await prepare("语义召回")
    await writeFileRaw(`${project.path}/${requested}`, original)
    await writeFileRaw(`${project.path}/wiki/references/cache.md`, original)
  }

  it.each(["唯一目标", "多个同主题", "存在不确定"])("%s时不优先信任同路径或同名候选", async (mode) => {
    await prepareMixed()
    decisionsByPath = { [requested]: "different", "wiki/references/cache.md": "different", [target]: "same" }
    if (mode === "多个同主题") decisionsByPath[requested] = "same"
    if (mode === "存在不确定") decisionsByPath[requested] = "uncertain"
    if (mode !== "多个同主题") {
      expect(await ingest()).toContain(target)
      expect(await readFileRaw(`${project.path}/${requested}`)).toBe(original)
    } else {
      const written = await ingest()
      expect(written).toContain("wiki/concepts/cache-2.md")
      expect(await readFileRaw(`${project.path}/${target}`)).toBe(original)
    }
    expect(compareInputs).toHaveLength(1)
    expect(compareInputs[0].candidates.map((page) => page.path).sort())
      .toEqual([requested, "wiki/references/cache.md", target].sort())
  })

  it("全部不同分配的后缀不与其他目录已有文件名冲突", async () => {
    await prepare("同路径")
    await writeFileRaw(`${project.path}/wiki/references/cache-2.md`, original)
    verdict = "different"
    expect(await ingest()).toContain("wiki/concepts/cache-3.md")
  })

  it("长路径分配后缀时仍满足包含目录在内的 256 字符页面 ID 限制", async () => {
    const path = `wiki/${"deep/".repeat(40)}${"x".repeat(56)}.md`
    await writeFileRaw(`${project.path}/${path}`, original)
    generation = `---FILE: ${path}---\n${incoming}\n---END FILE---`
    verdict = "different"
    const written = await ingest()
    const allocated = written.find((page) => page.startsWith("wiki/deep/"))!
    expect(allocated).not.toBe(path)
    expect(allocated).toMatch(/-2\.md$/)
    expect(Array.from(allocated.slice("wiki/".length, -3))).toHaveLength(256)
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(original)
    // 后缀占用长度导致原名称被截短，仍须按同一命名规则找回，而非再建一页。
    await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "Corrected long-path source.")
    decisionsByPath = { [path]: "different", [allocated]: "same" }
    expect(await ingest()).toContain(allocated)
    expect(compareInputs[compareInputs.length - 1].candidates.map((page) => page.path)).toContain(allocated)
  })

  it("同一批次同来源的两个同主题片段合并，不把前一片段误作待替换旧版本", async () => {
    generation += `\n---FILE: ${requested}---\n${incoming.replace("New cache evidence.", "Second fragment evidence.")}\n---END FILE---`
    await ingest()
    const saved = await readFileRaw(`${project.path}/${requested}`)
    expect(saved).toContain("New cache evidence.")
    expect(saved).toContain("Second fragment evidence.")
    expect(mergeCalls).toBe(1)
  })

  it("关闭向量检索时能找回因重名分配的新页，同一批次片段合并且重新入库复用该页", async () => {
    await prepare("同路径")
    decisionsByPath = { [requested]: "different", "wiki/concepts/cache-2.md": "same" }
    generation += `\n---FILE: ${requested}---\n${incoming.replace("New cache evidence.", "Second fragment evidence.")}\n---END FILE---`
    await ingest()
    const allocated = `${project.path}/wiki/concepts/cache-2.md`
    const saved = await readFileRaw(allocated)
    expect(saved).toContain("New cache evidence.")
    expect(saved).toContain("Second fragment evidence.")
    expect(await fileExists(`${project.path}/wiki/concepts/cache-3.md`)).toBe(false)
    await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "Corrected source evidence.")
    generation = `---FILE: ${requested}---\n${incoming.replace("New cache evidence.", "Corrected source evidence.")}\n---END FILE---`
    await ingest()
    expect(await readFileRaw(allocated)).toContain("Corrected source evidence.")
    expect(await readFileRaw(allocated)).toContain("Second fragment evidence.")
    expect(await readFileRaw(`${project.path}/${requested}`)).toBe(original)
    expect(await fileExists(`${project.path}/wiki/concepts/cache-3.md`)).toBe(false)
  })

  it("主题核对等待期间旧页被编辑，拒绝按过期正文合并覆盖", async () => {
    await prepare("同路径")
    rewriteSource = true
    await expect(ingest()).rejects.toThrow("Ingest incomplete")
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(`${original}\nConcurrent edit.`)
  })
})
