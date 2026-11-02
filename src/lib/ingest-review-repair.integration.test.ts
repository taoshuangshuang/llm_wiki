/** 场景化验证：从真实文件和持久任务输入，到自动处理、人工待办及恢复结果。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => ({ ...realFs, compareAndWriteFile: vi.fn(realFs.compareAndWriteFile) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string) => command === "retrieval_config" ? { effective: { keyword: true, vector: false } } : undefined) }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./embedding", () => ({ embedPage: vi.fn(async () => true) }))
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))
import { compareAndWriteFile } from "@/commands/fs"
import { embedPage } from "./embedding"
import { streamChat } from "./llm-client"
import { retrieveEvidence } from "./evidence-retrieval"
import { beginIngestRun, commitIngestPage, contentRevision, loadIngestRun, updateIngestRun } from "./ingest-run"
import { runIngestReview } from "./ingest-review"
import { retryIngestReview } from "./ingest-review-queue"
import { repairReviewIssues, recoverStageRepairs } from "./ingest-review-repair"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { needsReviewAttention } from "./review-priority"

let project: Awaited<ReturnType<typeof createTempProject>>
const path = "wiki/concepts/cache.md"
const source = "缓存上限是 10。必须保留例外条件。"
const markdown = (body: string) => `---\ntype: concept\ntitle: 缓存\nsources: [a.md]\n---\n# 缓存\n${body}`
const original = markdown("缓存上限是 10。")
const fixed = markdown(source)
const config = () => ({ ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
let planFailure: string | undefined
let planResponse: string | undefined
let verificationFailure: string | undefined
let beforePlan: (() => Promise<void>) | undefined
let changes: { path: string; content: string }[] | undefined
const repairCalls = () => vi.mocked(streamChat).mock.calls.filter(([, messages]) => String(messages[0].content).includes("自动修复器"))
const verifyCalls = () => vi.mocked(streamChat).mock.calls.filter(([, messages]) => String(messages[0].content).includes("修复独立复核器"))

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(embedPage).mockResolvedValue(true)
  planFailure = undefined; planResponse = undefined; verificationFailure = undefined; beforePlan = undefined; changes = undefined
  vi.mocked(compareAndWriteFile).mockImplementation(realFs.compareAndWriteFile)
  project = await createTempProject("one-round-repair")
  await writeFileRaw(`${project.path}/schema.md`, "# Schema")
  useWikiStore.setState({ embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false }, project: { id: "review", name: "review", path: project.path } })
  useReviewStore.setState({ items: [] })
  vi.mocked(retrieveEvidence).mockResolvedValue({ status: "completed", evidence: [], relations: [], targetResults: [], execution: {
    configVersion: "test", queries: [], channelStates: [], warnings: [], budgetReached: [], elapsedMs: 0,
    usage: { candidates: 0, queries: 1, contextChars: 0, readChars: 0 },
  } })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    const input = JSON.parse(String(messages[1].content))
    if (system.includes("自动修复器")) {
      await beforePlan?.()
      if (planFailure) { callbacks.onError(new Error(planFailure)); return }
      callbacks.onToken(planResponse ?? JSON.stringify({ reason: "依据来源补回必要例外", changes: changes ?? [{ path, content: fixed }] }))
    } else if (system.includes("修复独立复核器")) {
      callbacks.onToken(JSON.stringify({ passed: !verificationFailure, reason: verificationFailure ?? "原问题已解决，关键内容、格式、来源和链接有效" }))
    } else if (system.includes("你是知识库后台审阅器")) callbacks.onToken('{"issues":[]}')
    else {
      const covered = Object.values({ ...input.pages, ...input.relatedPages }).some((content) => String(content).includes("必须保留例外条件。"))
      callbacks.onToken(JSON.stringify({ summary: "完成关键来源核对", issues: covered ? [] : [{
        kind: "coverage", description: "遗漏例外条件", sourceEvidence: "必须保留例外条件。", pageEvidence: "", pages: [path],
      }] }))
    }
    callbacks.onDone()
  })
})
afterEach(async () => { await project.cleanup() })

async function prepare(content = original, before: string | null = null) {
  const run = await beginIngestRun(project.path, "review", "raw/sources/a.md", "a.md", source)
  if (before !== null) await writeFileRaw(`${project.path}/${path}`, before)
  await commitIngestPage(project.path, run.runId, path, before, content, "unit", before === null ? "create" : "merge")
  await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "complete" })
  vi.mocked(compareAndWriteFile).mockClear()
  return run
}
async function review(runId: string) {
  await runIngestReview(project.path, runId, config())
  return loadIngestRun(project.path, runId)
}
async function issue(): Promise<ReviewItem> {
  return { id: "coverage-fact", type: "coverage", title: "遗漏例外", description: "遗漏例外条件", affectedPages: [path], options: [], resolved: false, createdAt: 0,
    evidence: [{ path: "raw/sources/a.md", revision: await contentRevision(source), text: "必须保留例外条件。", startLine: 1, endLine: 1, snapshot: { runId: "source", side: "source" } }] }
}

describe("一轮自动处理", () => {
  it("内容遗漏补回并复查通过，保留原快照，无人工待办", async () => {
    const run = await prepare()
    const saved = await review(run.runId)
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(fixed)
    expect(saved.pages[path].after).toBe(original)
    expect(saved.review?.currentPages?.[path]).toBe(fixed)
    expect(saved.repairAttempts).toMatchObject([{ stage: "content", status: "verified", pages: { [path]: { before: original, proposed: fixed, actual: fixed } } }])
    expect(useReviewStore.getState().items.filter(needsReviewAttention)).toEqual([])
    expect(Object.keys(saved.review!.steps)).toEqual(["format", "content", "knowledge", "supplement"])
    expect(repairCalls()).toHaveLength(1)
    expect(verifyCalls()).toHaveLength(1)
  })

  it("修复正文 JSON 完整而外层围栏未闭合时，只规范化包装并提交一次", async () => {
    const run = await prepare()
    planResponse = "```json\n" + JSON.stringify({ reason: "依据来源补回必要条件", changes: [{ path, content: fixed }] })
    const saved = await review(run.runId)
    expect(saved.repairAttempts?.[0].status).toBe("verified")
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(fixed)
    expect(repairCalls()).toHaveLength(1)
  })

  it("确定性的列表格式由程序规范化，格式与内容分别记录", async () => {
    const invalid = fixed.replace("sources: [a.md]", "sources: a.md")
    const run = await prepare(invalid)
    const saved = await review(run.runId)
    expect(await readFileRaw(`${project.path}/${path}`)).toContain("- a.md")
    expect(saved.repairAttempts).toMatchObject([{ stage: "format", status: "verified" }])
    expect(saved.review?.steps.format.status).toBe("complete")
    expect(saved.review?.steps.content.status).toBe("complete")
    expect(useReviewStore.getState().items.filter(needsReviewAttention)).toEqual([])
    expect(repairCalls()).toHaveLength(0)
  })

  it.each(["生成失败", "复查失败", "写入失败"])("%s只交人工，重启与重新审阅不再生成方案", async (failure) => {
    const run = await prepare()
    if (failure === "生成失败") planFailure = "无可用材料"
    if (failure === "复查失败") verificationFailure = "例外条件仍无法核实"
    if (failure === "写入失败") vi.mocked(compareAndWriteFile).mockRejectedValue(new Error("磁盘写入失败"))
    await review(run.runId)
    expect(useReviewStore.getState().items.filter(needsReviewAttention)).toMatchObject([{ type: "coverage", repair: { status: "unresolved" }, outcome: expect.stringContaining("一轮修复") }])
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(failure === "复查失败" ? fixed : original)
    await retryIngestReview(project.path, run.runId)
    const saved = await review(run.runId)
    expect(saved.repairAttempts).toHaveLength(1)
    expect(repairCalls()).toHaveLength(1)
    expect(verifyCalls()).toHaveLength(failure === "复查失败" ? 1 : 0)
  })

  it("生成期间其他操作改变页面，不覆盖人工新版本", async () => {
    const run = await prepare()
    const manual = original + "\n人工补充。"
    beforePlan = () => writeFileRaw(`${project.path}/${path}`, manual)
    const saved = await review(run.runId)
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(manual)
    expect(saved.repairAttempts?.[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("页面已变化") })
    expect(compareAndWriteFile).not.toHaveBeenCalled()
    expect(repairCalls()).toHaveLength(1)
  })

  it("重要档案只留候选，批准后复查一次，不重放写入", async () => {
    const run = await prepare()
    vi.mocked(compareAndWriteFile).mockRejectedValue(new Error("FILE_APPROVAL_REQUIRED: pending"))
    let saved = await review(run.runId)
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(original)
    expect(saved.repairAttempts?.[0].status).toBe("approval-required")
    await review(run.runId)
    expect(repairCalls()).toHaveLength(1)
    expect(compareAndWriteFile).toHaveBeenCalledTimes(1)
    // 模拟人工审核通过的原生提交，再显式重新核查。
    await writeFileRaw(`${project.path}/${path}`, fixed)
    await retryIngestReview(project.path, run.runId)
    saved = await review(run.runId)
    expect(saved.repairAttempts?.[0].status).toBe("verified")
    expect(verifyCalls()).toHaveLength(1)
    expect(compareAndWriteFile).toHaveBeenCalledTimes(1)
    expect(saved.pages[path].after).toBe(original)
  })

  it("审批通过后普通恢复也清理当前失败卡片，保留成功日志与原快照", async () => {
    const run = await prepare()
    vi.mocked(compareAndWriteFile).mockRejectedValue(new Error("FILE_APPROVAL_REQUIRED: pending"))
    await review(run.runId)
    expect(useReviewStore.getState().items.filter(needsReviewAttention)).toHaveLength(1)
    await writeFileRaw(`${project.path}/${path}`, fixed)
    const saved = await review(run.runId)
    expect(saved.repairAttempts?.[0].status).toBe("verified")
    expect(useReviewStore.getState().items.filter(needsReviewAttention)).toEqual([])
    expect(saved.pages[path].after).toBe(original)
    expect(repairCalls()).toHaveLength(1)
    expect(verifyCalls()).toHaveLength(1)
  })

  it("中断于持久化方案之后，不重新应用候选；重命名问题不刷新额度", async () => {
    const run = await prepare()
    planFailure = "首次生成失败"
    const finding = await issue()
    await repairReviewIssues(project.path, run.runId, "content", [finding], config(), "# Schema")
    await updateIngestRun(project.path, run.runId, (state) => {
      const attempt = state.repairAttempts![0]
      attempt.status = "running"; attempt.pages = { [path]: { before: original, proposed: fixed, status: "proposed" } }
    })
    await recoverStageRepairs(project.path, run.runId, config(), "# Schema")
    await repairReviewIssues(project.path, run.runId, "content", [{ ...finding, title: "改写后的标题" }], config(), "# Schema")
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(original)
    expect(repairCalls()).toHaveLength(1)
    expect(compareAndWriteFile).not.toHaveBeenCalled()
  })

  it("提交完成但登记响应丢失时回读实际结果，失败仍保留修改", async () => {
    const run = await prepare()
    vi.mocked(compareAndWriteFile).mockImplementation(async (...args) => { await realFs.compareAndWriteFile(...args); throw new Error("提交响应丢失") })
    const saved = await review(run.runId)
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(fixed)
    expect(saved.repairAttempts?.[0]).toMatchObject({ status: "failed", pages: { [path]: { actual: fixed, status: "applied" } } })
    expect(useReviewStore.getState().items.filter(needsReviewAttention)[0].outcome).toContain("已改变页面")
  })

  it("旧自动修复候选不应用，也不能借新流程重新获得同一页修复额度", async () => {
    const run = await prepare()
    await updateIngestRun(project.path, run.runId, (state) => { state.autoRepair = { version: 2, status: "running", startedAt: 0, issues: [], verifiedIds: [], pages: { [path]: { before: original, proposed: fixed, status: "proposed" } } } })
    await review(run.runId)
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(original)
    expect(repairCalls()).toHaveLength(0)
    expect(compareAndWriteFile).not.toHaveBeenCalled()
  })

  it("已人工处理的事项保持已处理，不自动修改或撤销决定", async () => {
    const run = await prepare()
    const finding = await issue()
    useReviewStore.setState({ items: [{ ...finding, resolved: true, resolvedAction: "人工核实", resolutionUpdatedAt: Date.now() }] })
    await realFs.mergeReviewItems(project.path, useReviewStore.getState().items)
    const result = await repairReviewIssues(project.path, run.runId, "content", [finding], config(), "# Schema")
    expect(result[0]).toMatchObject({ resolved: true, resolvedAction: "人工核实" })
    expect(compareAndWriteFile).not.toHaveBeenCalled()
    expect(repairCalls()).toHaveLength(0)
  })

  it("同页修复通过后发现另一事实问题，额度不重置也不能静默隐藏新事项", async () => {
    const run = await prepare()
    await review(run.runId)
    const finding = await issue()
    const second = { ...finding, id: "different-fact", title: "重新发现其他事实失真", description: "上限语义仍需核实", evidence: [{ ...finding.evidence![0], text: "缓存上限是 10。" }] }
    const result = await repairReviewIssues(project.path, run.runId, "content", [second], config(), "# Schema")
    expect(result).toMatchObject([{ id: "different-fact", repair: { status: "unresolved" } }])
    expect(repairCalls()).toHaveLength(1)
  })

  it("修复提交后同步向量索引；索引失败保留正文与失败证据，不再生成方案", async () => {
    const run = await prepare()
    useWikiStore.setState({ embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: true } })
    vi.mocked(embedPage).mockResolvedValue(false)
    const saved = await review(run.runId)
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(fixed)
    expect(saved.repairAttempts?.[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("向量索引未完成") })
    expect(embedPage).toHaveBeenCalledTimes(1)
    expect(useReviewStore.getState().items.filter(needsReviewAttention)).toHaveLength(1)
    expect(repairCalls()).toHaveLength(1)
  })

  it("同一事实多次发现合并为一个事项和一次方案", async () => {
    const run = await prepare()
    planFailure = "材料不足"
    const finding = await issue()
    const result = await repairReviewIssues(project.path, run.runId, "content", [finding, { ...finding, id: "segment-two", title: "不同分段的标题" }], config(), "# Schema")
    expect(result).toHaveLength(1)
    expect(repairCalls()).toHaveLength(1)
  })
})


describe("重复整理及知识补充的边界", () => {
  async function duplicateSetup() {
    const run = await prepare()
    const otherPath = "wiki/concepts/other.md"
    const other = markdown("缓存上限是 10。另一来源的独有条件。")
    await writeFileRaw(`${project.path}/${otherPath}`, other)
    const finding: ReviewItem = { id: "duplicate", type: "duplicate", title: "相同缓存事实", description: "重复的缓存上限应合并，保留独有条件", affectedPages: [path, otherPath], options: [], resolved: false, createdAt: 0,
      evidence: [{ path, revision: await contentRevision(original), text: original, startLine: 1, endLine: 7 }, { path: otherPath, revision: await contentRevision(other), text: other, startLine: 1, endLine: 7 }] }
    changes = [{ path, content: markdown(source + "另一来源的独有条件。") }, { path: otherPath, content: markdown("此主题已归并，参见 [[cache]]。") }]
    return { run, finding, otherPath, other }
  }

  it("整页重复整理保留独有条件与原路径引用，一次方案允许修改多页", async () => {
    const { run, finding, otherPath } = await duplicateSetup()
    const result = await repairReviewIssues(project.path, run.runId, "knowledge", [finding], config(), "# Schema")
    expect(result).toEqual([])
    expect(await readFileRaw(`${project.path}/${path}`)).toContain("另一来源的独有条件。")
    expect(await readFileRaw(`${project.path}/${otherPath}`)).toContain("[[cache]]")
    expect(repairCalls()).toHaveLength(1)
    expect(verifyCalls()).toHaveLength(1)
    expect(compareAndWriteFile).toHaveBeenCalledTimes(2)
  })

  it("多页方案第二页提交失败时保留第一页的实际提交，不回滚或再修复", async () => {
    const { run, finding, otherPath, other } = await duplicateSetup()
    vi.mocked(compareAndWriteFile).mockImplementation(async (...args) => {
      if (args[1] === otherPath) throw new Error("第二页磁盘故障")
      await realFs.compareAndWriteFile(...args)
    })
    const result = await repairReviewIssues(project.path, run.runId, "knowledge", [finding], config(), "# Schema")
    expect(result).toMatchObject([{ type: "duplicate", outcome: expect.stringContaining("已改变页面") }])
    expect(await readFileRaw(`${project.path}/${path}`)).toBe(changes![0].content)
    expect(await readFileRaw(`${project.path}/${otherPath}`)).toBe(other)
    expect((await loadIngestRun(project.path, run.runId)).repairAttempts?.[0]).toMatchObject({ status: "failed", pages: { [path]: { status: "applied" }, [otherPath]: { status: "failed" } } })
    expect(repairCalls()).toHaveLength(1)
    expect(verifyCalls()).toHaveLength(0)
  })

  it("重复部分有事实冲突时只保留冲突，不能通过整理裁定事实", async () => {
    const { run, finding } = await duplicateSetup()
    const conflict: ReviewItem = { ...finding, id: "conflict", type: "contradiction", title: "同条件的上限不一致" }
    const result = await repairReviewIssues(project.path, run.runId, "knowledge", [finding, conflict], config(), "# Schema")
    expect(result.map((item) => item.type)).toEqual(["contradiction"])
    expect(compareAndWriteFile).not.toHaveBeenCalled()
    expect(repairCalls()).toHaveLength(0)
  })

  it("必要的同一未知跨页出现时保留一条建议并合并证据，不自动建页", async () => {
    const run = await prepare()
    const finding = await issue()
    const suggestions = [path, "wiki/concepts/other.md"].map((path, index): ReviewItem => ({ ...finding, id: `suggestion-${index}`, type: "suggestion", affectedPages: [path], evidence: [{ ...finding.evidence![0], path, text: "重要未知：缓存隔离是否影响迁移？", snapshot: undefined }] }))
    const result = await repairReviewIssues(project.path, run.runId, "knowledge", suggestions, config(), "# Schema")
    expect(result).toHaveLength(1)
    expect(result[0].evidence).toHaveLength(2)
    expect(compareAndWriteFile).not.toHaveBeenCalled()
    expect(repairCalls()).toHaveLength(0)
  })

  it("遗漏事实已在显式链接的承载页保留，定向复核后不扩写或发待办", async () => {
    const run = await prepare(original + "\n参见 [[exceptions]]。")
    await writeFileRaw(`${project.path}/wiki/concepts/exceptions.md`, markdown("必须保留例外条件。"))
    const saved = await review(run.runId)
    expect(saved.review?.steps.content.status).toBe("complete")
    expect(useReviewStore.getState().items).toEqual([])
    expect(repairCalls()).toHaveLength(0)
    const directed = vi.mocked(streamChat).mock.calls.map(([, messages]) => JSON.parse(String(messages[1].content))).find((input) => input.relatedPages)
    expect(directed.relatedPages["wiki/concepts/exceptions.md"]).toContain("必须保留例外条件。")
  })
  it("超过十个关联页仍分批核实遗漏，已有承载不因链接数量阻塞", async () => {
    const links = Array.from({ length: 12 }, (_, index) => `[[related-${index}]]`).join(" ")
    const run = await prepare(original + "\n" + links)
    for (let index = 0; index < 12; index++) await writeFileRaw(`${project.path}/wiki/concepts/related-${index}.md`, markdown(index === 11 ? "必须保留例外条件。" : "其他主题事实。"))
    const saved = await review(run.runId)
    expect(saved.review?.steps.content.status).toBe("complete")
    expect(repairCalls()).toHaveLength(0)
    expect(useReviewStore.getState().items.filter(needsReviewAttention)).toEqual([])
  })

})
