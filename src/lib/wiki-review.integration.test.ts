import { referenceContextFromFiles } from "@/test-helpers/reference-context"
/** Wiki 与入库共用检查的真实临时文件契约，模型和召回只模拟边界。 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw, readFileRaw } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => ({ ...realFs, compareAndWriteFile: vi.fn(realFs.compareAndWriteFile) }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string, args) => command === "wiki_reference_context" ? referenceContextFromFiles(args) : command === "retrieval_config" ? { effective: { title: true, keyword: true, vector: false, indexPage: true, graph: false } } : undefined) }))
import { streamChat } from "./llm-client"
import { retrieveEvidence } from "./evidence-retrieval"
import { compareAndWriteFile } from "@/commands/fs"
import { runWikiReview, loadWikiReviewBatches } from "./wiki-review"
import { repairWikiReviewIssues } from "./wiki-review-repair"
import { reviewPageIntroduction } from "./review-checks"
import { loadLintRunHistory, saveLintRunHistory } from "./lint-run-history"
import { restoreLintRun, startLintRun, resetLintRun, pauseLintRun } from "./lint-runner"
import { DEFAULT_LINT_RUN, useLintRunStore } from "@/stores/lint-run-store"
import { useLintStore } from "@/stores/lint-store"
import { contentRevision } from "./content-revision"
import { loadReviewItems, saveReviewItems } from "./persist"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"

let project: Awaited<ReturnType<typeof createTempProject>>
const config = { provider: "openai" as const, model: "test", apiKey: "test", ollamaUrl: "", customEndpoint: "", maxContextSize: 128_000 }
const a = "wiki/concepts/a.md", b = "wiki/concepts/b.md"
function page(title: string, body: string, module = "leaf") { return `---\ntype: concept\ntitle: ${title}\nsources: [a.md]\ntags: [module/${module}]\n---\n# ${title}\n\n${body}` }
const checkpointFile = () => `${project.path}/.llm-wiki/wiki-review-checkpoints.json`
const recalledPaths = () => vi.mocked(retrieveEvidence).mock.calls.flatMap(([request]) => request.targets.map((target) => target.path))
async function twoModules() {
  // 同名模块不能共用检查点，身份由模块 ID 和批内路径共同确定。
  await writeFileRaw(`${project.path}/business-modules.md`, '## Business Modules\n```json\n{"version":1,"modules":[{"id":"leaf","name":"同名模块","description":"第一模块"},{"id":"other","name":"同名模块","description":"第二模块"}]}\n```')
  await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。", "leaf"))
  await writeFileRaw(`${project.path}/${b}`, page("页面B", "B的介绍。", "other"))
}

beforeEach(async () => {
  vi.clearAllMocks()
  useLintRunStore.setState({ runs: {} })
  useLintStore.setState({ items: [] })
  vi.mocked(compareAndWriteFile).mockImplementation(realFs.compareAndWriteFile)
  project = await createTempProject("wiki-common-review")
  await writeFileRaw(`${project.path}/business-modules.md`, '## Business Modules\n```json\n{"version":1,"modules":[{"id":"root","name":"父模块","description":"整体","children":[{"id":"leaf","name":"叶子模块","description":"细分"}]}]}\n```')
  await writeFileRaw(`${project.path}/schema.md`, "# Schema")
  useWikiStore.setState({ project: { id: "wiki", name: "wiki", path: project.path }, llmConfig: config, embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false } })
  useReviewStore.setState({ items: [] })
  vi.mocked(retrieveEvidence).mockImplementation(async (request) => ({ status: "completed", evidence: [], relations: [], targetResults: request.targets.map((target) => ({ targetId: target.id, status: "no_match", evidenceIds: [] })), execution: { configVersion: "test", queries: [], channelStates: [], warnings: [], budgetReached: [], elapsedMs: 0, usage: { candidates: 0, queries: 1, contextChars: 0, readChars: 0 } } }))
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    callbacks.onToken(String(messages[0].content).includes("独立复核器") ? '{"passed":true,"reason":"关键事实与来源保留"}' : '{"issues":[]}')
    callbacks.onDone()
  })
})
afterEach(async () => { await project.cleanup() })

describe("公共材料准备与 Wiki 模块调度", () => {
  it("暂停后重置并模拟重启，进度和问题不恢复，下一轮重新检查全部批次", async () => {
    await twoModules()
    const options = { project: { path: project.path, id: "wiki" }, llmConfig: config,
      runSemantic: true, config: { ignoreOrphan: false, ignoreNoOutlinks: false, ignorePages: [] },
      messages: { preparing: "准备检查", incomplete: "未完成", needsModel: "需要模型" } }
    // 完成第一批后请求暂停，模拟用户截图中的续跑状态。
    const original = vi.mocked(retrieveEvidence).getMockImplementation()!
    vi.mocked(retrieveEvidence).mockImplementation(async (request) => {
      if (request.targets.some((target) => target.path === b)) pauseLintRun(project.path)
      return original(request)
    })
    await startLintRun(options)
    expect(useLintRunStore.getState().runs[project.path].paused).toBe(true)
    const beforePage = await readFileRaw(`${project.path}/${a}`)
    const beforeReview = await loadReviewItems(project.path)
    await resetLintRun(project.path)
    expect(useLintStore.getState().items).toEqual([])
    expect(useLintRunStore.getState().runs[project.path]).toEqual({ ...DEFAULT_LINT_RUN, runSemantic: true })
    expect(JSON.parse(await readFileRaw(checkpointFile())).modules).toEqual({})
    expect(await readFileRaw(`${project.path}/${a}`)).toBe(beforePage)
    expect(await loadReviewItems(project.path)).toEqual(beforeReview)
    // 重启后依然是初始状态；重置本身不启动模型调用。
    vi.mocked(retrieveEvidence).mockClear()
    useLintRunStore.setState({ runs: {} })
    await restoreLintRun(project.path)
    expect(useLintRunStore.getState().runs[project.path]).toEqual({ ...DEFAULT_LINT_RUN, runSemantic: true })
    expect(useLintStore.getState().items).toEqual([])
    expect(retrieveEvidence).not.toHaveBeenCalled()
    vi.mocked(retrieveEvidence).mockImplementation(original)
    await startLintRun(options)
    expect(recalledPaths()).toEqual(expect.arrayContaining([a, b]))
    expect(useLintRunStore.getState().runs[project.path]).toMatchObject({ paused: false, progress: { completed: 2, total: 2 } })
  })

  it("重置非当前知识库只清除目标项目，不影响当前项目的问题和进度", async () => {
    const current = { ...DEFAULT_LINT_RUN, hasRun: true, progress: { completed: 3, total: 3 } }
    const item = { id: "current", type: "orphan" as const, severity: "info" as const, page: "B.md", detail: "当前项目问题", createdAt: 0 }
    useWikiStore.setState({ project: { id: "other", name: "other", path: "/other" } })
    useLintRunStore.getState().update("/other", current)
    useLintStore.getState().setItems([item])
    await resetLintRun(project.path)
    expect(useLintRunStore.getState().runs["/other"]).toEqual(current)
    expect(useLintStore.getState().items).toEqual([item])
  })

  it("旧快照恢复时按原始审阅类型更正结构和链接分类，保留卡片身份且不运行检查", async () => {
    const base = { title: "格式说明", description: "需要检查", affectedPages: [a], options: [], resolved: false, createdAt: 1 }
    const reviews: ReviewItem[] = [
      { ...base, id: "format", type: "structure" },
      { ...base, id: "link", type: "structure", subtype: "失效引用" },
      { ...base, id: "conflict", type: "contradiction" },
    ]
    await saveLintRunHistory(project.path, { ...DEFAULT_LINT_RUN, hasRun: true }, reviews.map((reviewItem, index) => ({
      id: `old-${index}`, type: "semantic", severity: "warning", page: "concepts/a.md", detail: "旧分类", reviewItem, createdAt: 2,
    })))
    const history = await loadLintRunHistory(project.path)
    expect(history?.items.map((item) => item.type)).toEqual(["structure", "broken-link", "semantic"])
    expect(history?.items.map((item) => [item.id, item.createdAt, item.reviewItem])).toEqual(reviews.map((review, index) => [`old-${index}`, 2, review]))
    expect(streamChat).not.toHaveBeenCalled()
    expect(retrieveEvidence).not.toHaveBeenCalled()
  })

  it("后台检查完成后自动落盘最终进度，清空内存模拟重启后可以恢复", async () => {
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。"))
    await startLintRun({ project: { path: project.path, id: "wiki" }, llmConfig: config,
      runSemantic: false, config: { ignoreOrphan: false, ignoreNoOutlinks: false, ignorePages: [] },
      messages: { preparing: "准备检查", incomplete: "未完成", needsModel: "需要模型" },
    })
    const before = useLintRunStore.getState().runs[project.path]
    const items = useLintStore.getState().items
    expect(before.running).toBe(false)
    expect(before.progress?.completed).toBe(before.progress?.total)
    expect(items.length).toBeGreaterThan(0)
    useLintRunStore.setState({ runs: {} })
    useLintStore.setState({ items: [] })
    await restoreLintRun(project.path)
    expect(useLintRunStore.getState().runs[project.path]).toMatchObject({ running: false, paused: false, hasRun: true, progress: before.progress })
    expect(useLintStore.getState().items.map((item) => item.detail)).toEqual(items.map((item) => item.detail))
  })

  it("旧检查点在启动时直接恢复历史进度，不需要先运行检查", async () => {
    await twoModules()
    const controller = new AbortController()
    await runWikiReview(project.path, config, controller.signal, (progress) => { if (progress.completed === 1) controller.abort() })
    vi.mocked(streamChat).mockClear(); vi.mocked(retrieveEvidence).mockClear()
    await restoreLintRun(project.path)
    expect(useLintRunStore.getState().runs[project.path]).toMatchObject({ running: false, paused: true, runSemantic: true, progress: { completed: 1, total: 2 } })
    expect(streamChat).not.toHaveBeenCalled()
    expect(retrieveEvidence).not.toHaveBeenCalled()
  })

  it("重启恢复正在运行的快照为待继续状态，保留进度与问题且不保存模型凭据", async () => {
    const item = { id: "history-item", type: "orphan" as const, severity: "info" as const, page: "A.md", detail: "历史问题", createdAt: 0 }
    await saveLintRunHistory(project.path, { ...DEFAULT_LINT_RUN, running: true, runSemantic: true, phase: "semantic", progress: { completed: 12, total: 58 }, detail: "正在检查：当前模块" }, [item])
    await restoreLintRun(project.path)
    expect(useLintRunStore.getState().runs[project.path]).toMatchObject({ running: false, paused: true, hasRun: true, progress: { completed: 12, total: 58 } })
    expect(useLintStore.getState().items).toEqual([item])
    const disk = await readFileRaw(`${project.path}/.llm-wiki/lint-run.json`)
    expect(disk).not.toContain("apiKey")
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("已结束任务重启后保留最终进度，不显示为运行中或待继续", async () => {
    await saveLintRunHistory(project.path, { ...DEFAULT_LINT_RUN, hasRun: true, progress: { completed: 4, total: 4 } }, [])
    const history = await loadLintRunHistory(project.path)
    expect(history?.run).toMatchObject({ running: false, paused: false, hasRun: true, progress: { completed: 4, total: 4 } })
  })

  it("第一批语义事项在下一批开始前发布，恢复检查点时也立即发布", async () => {
    await twoModules()
    const snapshots: ReviewItem[][] = []
    let publishedBeforeNextBatch = false
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      const target = input.materials.find((entry: { role: string }) => entry.role === "page")
      if (target.path === b) publishedBeforeNextBatch = snapshots.some((items) => items.some((item) => item.title === "补充页面A适用条件"))
      callbacks.onToken(target.path === a && String(messages[0].content).includes("type=suggestion")
        ? JSON.stringify({ issues: [{ type: "suggestion", title: "补充页面A适用条件", description: "适用条件待补充", evidence: [{ id: target.id, quote: "A的介绍。" }] }] })
        : '{"issues":[]}')
      callbacks.onDone()
    })
    const report = await runWikiReview(project.path, config, undefined, undefined, (items) => snapshots.push(items))
    expect(report.status).toBe("complete")
    expect(publishedBeforeNextBatch).toBe(true)
    expect(snapshots[snapshots.length - 1]).toEqual(report.items)
    snapshots.length = 0
    vi.mocked(streamChat).mockClear()
    await runWikiReview(project.path, config, undefined, undefined, (items) => snapshots.push(items))
    expect(snapshots[0]).toMatchObject([{ title: "补充页面A适用条件" }])
    expect(streamChat).not.toHaveBeenCalled()
    // 人工处理的事项不能被增量发布重新带回列表。
    await saveReviewItems(project.path, report.items.map((item) => ({ ...item, resolved: true })))
    snapshots.length = 0
    await runWikiReview(project.path, config, undefined, undefined, (items) => snapshots.push(items))
    expect(snapshots.every((items) => items.length === 0)).toBe(true)
  })

  it("按上次进度续跑，忽略全库版本变化并读取未完成批次的最新文件", async () => {
    await twoModules()
    const controller = new AbortController()
    await runWikiReview(project.path, config, controller.signal, (progress) => {
      if (progress.completed === 1) controller.abort()
    })
    // 兼容旧检查点；继续只看完成状态，不再受全库或配置指纹约束。
    const saved = JSON.parse(await readFileRaw(checkpointFile()))
    for (const entry of Object.values(saved.modules)) Object.assign(entry as object, { corpusRevision: "old-corpus", rulesRevision: "old-rules" })
    await writeFileRaw(checkpointFile(), JSON.stringify(saved))
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "已完成页面后来被整理。", "leaf"))
    await writeFileRaw(`${project.path}/${b}`, page("页面B", "当前实际文件中的新事实。", "other"))
    await writeFileRaw(`${project.path}/wiki/index.md`, "导航发生变化。")
    vi.mocked(retrieveEvidence).mockClear(); vi.mocked(streamChat).mockClear()
    const progress: { completed: number; total: number; detail: string }[] = []
    const resumed = await runWikiReview(project.path, config, undefined, (value) => progress.push(value))
    expect(resumed.status).toBe("complete")
    expect(recalledPaths()).toEqual([b])
    expect(progress[0].completed).toBe(1)
    expect(progress[progress.length - 1]?.completed).toBe(2)
    const request = vi.mocked(retrieveEvidence).mock.calls[0][0]
    expect(request.targets[0].text).toContain("当前实际文件中的新事实。")
  })

  it("批次内立即中断后重跑当前批次，已完成批次保持复用", async () => {
    await twoModules()
    const controller = new AbortController()
    let calls = 0
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      // 每批包含关系与补充两次调用；第三次表示已进入第二批的关系检查。
      calls++
      if (calls === 3) controller.abort()
      callbacks.onToken('{"issues":[]}')
      callbacks.onDone()
    })
    const interrupted = await runWikiReview(project.path, config, controller.signal)
    expect(interrupted.status).toBe("cancelled")
    expect(recalledPaths()).toEqual([a, b])
    const checkpoints = JSON.parse(await readFileRaw(checkpointFile()))
    expect(Object.values(checkpoints.modules).map((entry) => (entry as { status: string }).status)).toEqual(["complete", "incomplete"])
    vi.mocked(retrieveEvidence).mockClear()
    vi.mocked(streamChat).mockClear()
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    expect(recalledPaths()).toEqual([b])
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it("中断后从未完成模块续跑，不重新召回已完成模块", async () => {
    await writeFileRaw(`${project.path}/business-modules.md`, '## Business Modules\n```json\n{"version":1,"modules":[{"id":"leaf","name":"模块A","description":"第一模块"},{"id":"other","name":"模块B","description":"第二模块"}]}\n```')
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。", "leaf"))
    await writeFileRaw(`${project.path}/${b}`, page("页面B", "B的介绍。", "other"))
    const controller = new AbortController()
    const first = await runWikiReview(project.path, config, controller.signal, (progress) => { if (progress.completed === 1) controller.abort() })
    expect(first.status).toBe("cancelled")
    expect(vi.mocked(retrieveEvidence).mock.calls.flatMap(([request]) => request.targets.map((target) => target.path))).toEqual([a])
    vi.mocked(retrieveEvidence).mockClear(); vi.mocked(streamChat).mockClear()
    useReviewStore.setState({ items: [] })
    const resumed = await runWikiReview(project.path, config)
    expect(resumed.status).toBe("complete")
    expect(vi.mocked(retrieveEvidence).mock.calls.flatMap(([request]) => request.targets.map((target) => target.path))).toEqual([b])
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it("缓存恢复人工事项，人工已处理的事项不会因续跑重新出现", async () => {
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。"))
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      callbacks.onToken(String(messages[0].content).includes("type=suggestion") ? JSON.stringify({ issues: [{ type: "suggestion", title: "适用条件待补充", description: "需要补充适用条件", evidence: [{ id: input.materials[0].id, quote: "A的介绍。" }] }] }) : '{"issues":[]}')
      callbacks.onDone()
    })
    const initial = await runWikiReview(project.path, config)
    expect(initial.items).toHaveLength(1)
    vi.mocked(streamChat).mockClear(); vi.mocked(retrieveEvidence).mockClear()
    useReviewStore.setState({ items: [] })
    const restored = await runWikiReview(project.path, config)
    expect(restored.items.map((item) => item.id)).toEqual(initial.items.map((item) => item.id))
    expect(streamChat).not.toHaveBeenCalled()
    expect(retrieveEvidence).not.toHaveBeenCalled()
    await saveReviewItems(project.path, initial.items.map((item) => ({ ...item, resolved: true })))
    expect((await runWikiReview(project.path, config)).items).toEqual([])
    expect((await loadReviewItems(project.path))[0].resolved).toBe(true)
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("完成批次的旧事项在正文变化后标记历史，不因续跑重查或丢失", async () => {
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。"))
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      callbacks.onToken(String(messages[0].content).includes("type=suggestion")
        ? JSON.stringify({ issues: [{ type: "suggestion", title: "补充适用条件", description: "需要说明适用条件", evidence: [{ id: input.materials[0].id, quote: "A的介绍。" }] }] })
        : '{"issues":[]}')
      callbacks.onDone()
    })
    const initial = await runWikiReview(project.path, config)
    expect(initial.items).toHaveLength(1)
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "整理后的实际正文。"))
    vi.mocked(streamChat).mockClear(); vi.mocked(retrieveEvidence).mockClear()
    const resumed = await runWikiReview(project.path, config)
    expect(resumed.status).toBe("complete")
    expect(resumed.reasons).toEqual([])
    expect(resumed.items).toMatchObject([{ id: initial.items[0].id, historical: true }])
    expect(streamChat).not.toHaveBeenCalled()
    expect(retrieveEvidence).not.toHaveBeenCalled()
  })

  it("正在执行的模块被取消后重查，已完成的同名模块继续复用", async () => {
    await twoModules()
    const originalRecall = vi.mocked(retrieveEvidence).getMockImplementation()!
    const controller = new AbortController()
    vi.mocked(retrieveEvidence).mockImplementation(async (request) => {
      if (request.targets.some((target) => target.path === b)) controller.abort()
      return originalRecall(request)
    })
    expect((await runWikiReview(project.path, config, controller.signal)).status).toBe("cancelled")
    const stored = JSON.parse(await readFileRaw(checkpointFile())).modules
    expect(Object.values(stored).map((entry) => (entry as { status: string }).status).sort()).toEqual(["complete", "incomplete"])
    vi.mocked(retrieveEvidence).mockImplementation(originalRecall).mockClear(); vi.mocked(streamChat).mockClear()
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    expect(recalledPaths()).toEqual([b])
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it("召回未完成的模块会重试，其余模块的空结果检查点仍可复用", async () => {
    await twoModules()
    const originalRecall = vi.mocked(retrieveEvidence).getMockImplementation()!
    vi.mocked(retrieveEvidence).mockImplementation(async (request) => {
      if (request.targets.some((target) => target.path === a)) throw new Error("暂时不可用")
      return originalRecall(request)
    })
    expect((await runWikiReview(project.path, config)).status).toBe("incomplete")
    vi.mocked(retrieveEvidence).mockImplementation(originalRecall).mockClear(); vi.mocked(streamChat).mockClear()
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    expect(recalledPaths()).toEqual([a])
  })

  it.each(["修改目标页", "修改规则", "更换模型", "修改请求路由"])("%s后仍按上次进度跳过完成批次", async (change) => {
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。"))
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    vi.mocked(retrieveEvidence).mockClear(); vi.mocked(streamChat).mockClear()
    let nextConfig: typeof config & { customHeaders?: Record<string, string> } = config
    if (change === "修改目标页") await writeFileRaw(`${project.path}/${a}`, page("页面A", "新增事实。"))
    if (change === "修改规则") await writeFileRaw(`${project.path}/purpose.md`, "新增项目用途约束。")
    if (change === "更换模型") nextConfig = { ...config, model: "another-model" }
    if (change === "修改请求路由") nextConfig = { ...config, customHeaders: { "x-model-route": "another" } }
    expect((await runWikiReview(project.path, nextConfig)).status).toBe("complete")
    expect(recalledPaths()).toEqual([])
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("新增其他模块的页面只增加待执行批次，不重查已有完成批次", async () => {
    await twoModules()
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    const c = "wiki/concepts/c.md"
    await writeFileRaw(`${project.path}/${c}`, page("页面C", "新加入的实际文件。", "unclassified"))
    vi.mocked(retrieveEvidence).mockClear(); vi.mocked(streamChat).mockClear()
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    expect(recalledPaths()).toEqual([c])
  })

  it("检查点仅保存批次进度与事项，不写入模型配置或密钥", async () => {
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。"))
    const secretConfig = { ...config, apiKey: "private-model-key", customHeaders: { Authorization: "private-header-token" } }
    expect((await runWikiReview(project.path, secretConfig)).status).toBe("complete")
    const persisted = await readFileRaw(checkpointFile())
    expect(persisted).not.toContain("private-model-key")
    expect(persisted).not.toContain("private-header-token")
    expect(Object.values(JSON.parse(persisted).modules)).toMatchObject([{ status: "complete", members: [{ path: a }] }])
  })

  it("检查期间正文变化不能保存为已完成，重试按新正文检查", async () => {
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。"))
    vi.mocked(streamChat).mockImplementationOnce(async (_config, _messages, callbacks) => {
      await writeFileRaw(`${project.path}/${a}`, page("页面A", "人工新增事实。"))
      callbacks.onToken('{"issues":[]}'); callbacks.onDone()
    })
    const initial = await runWikiReview(project.path, config)
    expect(initial.status).toBe("incomplete")
    expect(initial.reasons.join("；")).toContain("检查材料已变化")
    expect(Object.values(JSON.parse(await readFileRaw(checkpointFile())).modules)).toMatchObject([{ status: "incomplete" }])
    vi.mocked(streamChat).mockClear(); vi.mocked(retrieveEvidence).mockClear()
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    expect(recalledPaths()).toEqual([a])
  })

  it("同一路径召回到不同正文版本时，不因最后一个版本仍有效而缓存完成", async () => {
    await twoModules()
    const originalRecall = vi.mocked(retrieveEvidence).getMockImplementation()!
    const latest = await readFileRaw(`${project.path}/${b}`)
    vi.mocked(retrieveEvidence).mockImplementation(async (request) => {
      const result = await originalRecall(request)
      if (request.targets.some((target) => target.path === a)) result.evidence = await Promise.all(["旧版本事实。", latest].map(async (text, index) => ({
        id: `ref-${index}`, targetIds: request.targets.map((target) => target.id), path: b, title: "页面B", revision: await contentRevision(text), text,
        headingPath: [], range: { startLine: 1, endLine: text.split("\n").length }, ranks: {}, retrievalSources: [], relationIds: [],
      })))
      return result
    })
    const report = await runWikiReview(project.path, config)
    expect(report.status).toBe("incomplete")
    expect(report.reasons.join("；")).toContain("检查材料已变化")
    const checkpoints = Object.values(JSON.parse(await readFileRaw(checkpointFile())).modules) as { members: { path: string }[]; status: string }[]
    expect(checkpoints.find((entry) => entry.members.some((member) => member.path === a))?.status).toBe("incomplete")
    vi.mocked(retrieveEvidence).mockImplementation(originalRecall).mockClear()
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    expect(recalledPaths()).toEqual([a])
  })

  it("损坏的持久化记录明确报错，不当成已完成或重写旧文件", async () => {
    await writeFileRaw(`${project.path}/${a}`, page("页面A", "A的介绍。"))
    const corrupt = '{"version":1,"modules":[]}'
    await writeFileRaw(checkpointFile(), corrupt)
    const report = await runWikiReview(project.path, config)
    expect(report.status).toBe("incomplete")
    expect(report.reasons.join("；")).toContain("检查点格式无效")
    expect(await readFileRaw(checkpointFile())).toBe(corrupt)
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("介绍提取优先完整本文概括，忽略代码中的伪标题，不按字符数截断", () => {
    const intro = "关键概括。".repeat(120)
    expect(reviewPageIntroduction(`---\ntitle: 长标题\n---\n# 标题\n\n旧简介\n\`\`\`md\n## 本文概括\n错误内容\n\`\`\`\n## 本文概括\n${intro}\n## 详细设计\n后续正文`)).toBe(`## 本文概括\n${intro}`)
    expect(reviewPageIntroduction("# 标题\n\n**本文概括**：这是介绍。\n\n## 章节\n详细说明")).toBe("**本文概括**：这是介绍。")
    expect(reviewPageIntroduction("# 标题\n## 首个介绍\n内容。\n### 细节\n细节。\n## 下一章\n后续")).toBe("## 首个介绍\n内容。\n### 细节\n细节。")
  })

  it("最细归属分批最多50篇，父模块直属和未分类不遗漏，不聚合祖先", async () => {
    for (let index = 0; index < 51; index++) await writeFileRaw(`${project.path}/wiki/deep/level/page-${index}.md`, page(`页面${index}`, "本文介绍。"))
    await writeFileRaw(`${project.path}/${a}`, page("直属", "介绍。", "root"))
    await writeFileRaw(`${project.path}/${b}`, page("未分类", "介绍。", "unknown"))
    const result = await loadWikiReviewBatches(project.path)
    expect(result.pages).toHaveLength(53)
    expect(result.batches.filter((batch) => batch.name === "叶子模块").map((batch) => batch.pages.length)).toEqual([50, 1])
    expect(result.batches.find((batch) => batch.name === "父模块")?.pages.map((entry) => entry.path)).toEqual([a])
    expect(result.batches.find((batch) => batch.name === "未分类")?.pages.map((entry) => entry.path)).toEqual([b])
  })

  it("Wiki独立召回并共用三项检查，不执行内容覆盖或创建入库记录", async () => {
    const text = page("缓存", "本文介绍缓存。\n## 实现\n后续完整事实。")
    await writeFileRaw(`${project.path}/${a}`, text)
    const report = await runWikiReview(project.path, config)
    expect(report).toMatchObject({ status: "complete", items: [], reasons: [] })
    const request = vi.mocked(retrieveEvidence).mock.calls[0][0]
    expect(request.targets[0]).toMatchObject({ title: "缓存", text: "本文介绍缓存。", path: a })
    expect(request.scope).toEqual({ corpus: "wiki", excludePaths: [a] }) // 只排除已持有完整正文的目标页，仍可跨模块召回。
    const calls = vi.mocked(streamChat).mock.calls.map(([, messages]) => JSON.parse(String(messages[1].content)))
    expect(calls).toHaveLength(2)
    expect(calls[0].materials[0].text).toBe(text)
    expect(calls[0].targetPaths).toEqual([a])
    expect(calls.every((input) => input.source === undefined && input.beforePages === undefined)).toBe(true)
    expect(await realFs.fileExists(`${project.path}/.llm-wiki/ingest-runs`)).toBe(false)
  })

  it("召回失败仍保留检查结果，报告不得是正常通过", async () => {
    await writeFileRaw(`${project.path}/${a}`, page("缓存", "介绍。"))
    vi.mocked(retrieveEvidence).mockRejectedValue(new Error("召回服务不可用"))
    const report = await runWikiReview(project.path, config)
    expect(report.status).toBe("incomplete")
    expect(report.reasons.join("；")).toContain("召回服务不可用")
    expect(vi.mocked(compareAndWriteFile)).not.toHaveBeenCalled()
  })

  it("同批重复自动整理保留独有事实和原路径，补充检查使用修改后正文", async () => {
    const originalA = page("缓存", "共同事实。\n独有事实A。")
    const originalB = page("缓存说明", "共同事实。\n独有事实B。")
    const merged = page("缓存", "共同事实。\n独有事实A。\n独有事实B。")
    const stub = page("缓存说明", "内容已归并，参见 [[concepts/a]]。")
    await writeFileRaw(`${project.path}/${a}`, originalA); await writeFileRaw(`${project.path}/${b}`, originalB)
    await saveReviewItems(project.path, [{ id: "old-duplicate", type: "duplicate", title: "旧的重复事项", description: "旧证据", options: [], resolved: false, createdAt: 0,
      affectedPages: [a, b], evidence: [{ path: a, revision: await contentRevision(originalA), text: "共同事实。", startLine: 9, endLine: 9 }] }])
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const system = String(messages[0].content), input = JSON.parse(String(messages[1].content))
      if (system.includes("自动修复器")) callbacks.onToken(JSON.stringify({ reason: "合并重复，保留独有事实", changes: [{ path: a, content: merged }, { path: b, content: stub }] }))
      else if (system.includes("独立复核器")) callbacks.onToken('{"passed":true,"reason":"两页独有事实保留，旧路径可用"}')
      else if (system.includes("type=contradiction|duplicate")) {
        callbacks.onToken(JSON.stringify({ issues: [{ type: "duplicate", title: "共同事实重复", description: "保留各自独有事实", evidence: input.materials.filter((entry: { path: string }) => [a, b].includes(entry.path)).map((entry: { id: string }) => ({ id: entry.id, quote: "共同事实。" })) }] }))
      } else { expect(input.materials.map((entry: { text: string }) => entry.text)).toEqual(expect.arrayContaining([merged, stub])); callbacks.onToken('{"issues":[]}') }
      callbacks.onDone()
    })
    const report = await runWikiReview(project.path, config)
    expect(report).toMatchObject({ status: "complete", items: [] })
    expect(await readFileRaw(`${project.path}/${a}`)).toBe(merged)
    expect(await readFileRaw(`${project.path}/${b}`)).toBe(stub)
    expect(report.changedPages).toEqual(expect.arrayContaining([a, b]))
    expect(useReviewStore.getState().items.find((item) => item.title === "旧的重复事项")?.historical).toBe(true)
    expect(JSON.parse(await readFileRaw(`${project.path}/.llm-wiki/wiki-review-repairs.json`)).attempts[0].status).toBe("verified")
    // 自动整理后的版本是模块完成版本，重新启动不应再调用模型或重复提交。
    vi.mocked(streamChat).mockClear(); vi.mocked(retrieveEvidence).mockClear(); vi.mocked(compareAndWriteFile).mockClear()
    expect((await runWikiReview(project.path, config)).status).toBe("complete")
    expect(streamChat).not.toHaveBeenCalled()
    expect(retrieveEvidence).not.toHaveBeenCalled()
    expect(compareAndWriteFile).not.toHaveBeenCalled()
  })

  it("生成合并方案期间人工修改，保留人工版本并返回待核查事项", async () => {
    const original = page("缓存", "共同事实。")
    await writeFileRaw(`${project.path}/${a}`, original); await writeFileRaw(`${project.path}/${b}`, original)
    const item: ReviewItem = { id: "dup", type: "duplicate", title: "重复", description: "重复事实", options: [], resolved: false, createdAt: 0, affectedPages: [a, b], evidence: await Promise.all([a, b].map(async (path) => ({ path, text: "共同事实。", revision: await contentRevision(original), startLine: 9, endLine: 9 }))) }
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      await writeFileRaw(`${project.path}/${a}`, `${original}\n人工修改。`)
      callbacks.onToken(JSON.stringify({ reason: "合并", changes: [{ path: a, content: `${original}\n候选稿。` }] })); callbacks.onDone()
    })
    const result = await repairWikiReviewIssues(project.path, "knowledge", [item], config, "", [a, b])
    expect(result[0].repair).toMatchObject({ status: "unresolved", reason: expect.stringContaining("已变化") })
    expect(await readFileRaw(`${project.path}/${a}`)).toContain("人工修改。")
    expect(compareAndWriteFile).not.toHaveBeenCalled()
    const calls = vi.mocked(streamChat).mock.calls.length
    await repairWikiReviewIssues(project.path, "knowledge", [item], config, "", [a, b])
    expect(streamChat).toHaveBeenCalledTimes(calls)
  })

  it("适用条件无法判断时保留双方证据为人工确认事项，不自动合并", async () => {
    await writeFileRaw(`${project.path}/${a}`, page("缓存", "允许缓存。"))
    await writeFileRaw(`${project.path}/${b}`, page("缓存说明", "禁止缓存。"))
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const system = String(messages[0].content), input = JSON.parse(String(messages[1].content))
      if (system.includes("事实适用范围复核器")) callbacks.onToken('{"incomplete":true,"reason":"缺少版本条件","missingContext":["适用版本"]}')
      else if (system.includes("type=contradiction|duplicate")) callbacks.onToken(JSON.stringify({ issues: [{ type: "contradiction", title: "缓存规则不同", description: "需要核实适用条件", evidence: input.materials.map((entry: { id: string; path: string }) => ({ id: entry.id, quote: entry.path === a ? "允许缓存。" : "禁止缓存。" })) }] }))
      else callbacks.onToken('{"issues":[]}')
      callbacks.onDone()
    })
    const report = await runWikiReview(project.path, config)
    expect(report.status).toBe("complete")
    expect(report.items).toMatchObject([{ type: "confirm", description: expect.stringContaining("适用版本"), evidence: [expect.anything(), expect.anything()] }])
    expect(compareAndWriteFile).not.toHaveBeenCalled()
  })

  it("多页合并部分提交失败时保留实际结果，重试不因自动产生的新版本刷新额度", async () => {
    const original = page("缓存", "共同事实。")
    const merged = page("缓存", "共同事实。\n保留所有事实。")
    await writeFileRaw(`${project.path}/${a}`, original); await writeFileRaw(`${project.path}/${b}`, original)
    const item: ReviewItem = { id: "partial", type: "duplicate", title: "重复", description: "需要归并", options: [], resolved: false, createdAt: 0, affectedPages: [a, b], evidence: await Promise.all([a, b].map(async (path) => ({ path, text: "共同事实。", revision: await contentRevision(original), startLine: 9, endLine: 9 }))) }
    vi.mocked(compareAndWriteFile).mockImplementation(async (...args) => { if (args[1] === b) throw new Error("第二页写入失败"); await realFs.compareAndWriteFile(...args) })
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ reason: "合并", changes: [{ path: a, content: merged }, { path: b, content: page("缓存", "参见 [[concepts/a]]。") }] })); callbacks.onDone()
    })
    const result = await repairWikiReviewIssues(project.path, "knowledge", [item], config, "", [a, b])
    expect(await readFileRaw(`${project.path}/${a}`)).toBe(merged)
    expect(await readFileRaw(`${project.path}/${b}`)).toBe(original)
    expect(result[0].repair?.reason).toContain("第二页写入失败")
    expect(result[0].evidence?.[0].revision).toBe(await contentRevision(merged))
    const calls = vi.mocked(streamChat).mock.calls.length
    await repairWikiReviewIssues(project.path, "knowledge", result, config, "", [a, b])
    expect(streamChat).toHaveBeenCalledTimes(calls)
    expect(compareAndWriteFile).toHaveBeenCalledTimes(2)
  })
})
