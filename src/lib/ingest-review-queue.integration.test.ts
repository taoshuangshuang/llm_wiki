/** 用真实运行记录验证调度生命周期；网络故意忽略取消，模拟晚到响应。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string) => command === "retrieval_config" ? { effective: { keyword: true, vector: true, indexPage: true, graph: false } } : undefined) }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))
vi.mock("./llm-task-routing", () => ({ getTaskLlmConfig: () => ({ provider: "custom", model: "test", apiKey: "", maxContextSize: 128000 }) }))

import { streamChat } from "./llm-client"
import { retrieveEvidence } from "./evidence-retrieval"
import { beginIngestRun, commitIngestPage, listIngestRuns, loadIngestRun, updateIngestRun } from "./ingest-run"
import { cancelIngestReview, pauseIngestReviewQueue, restoreIngestReviewQueue, retryIngestReview, wakeIngestReviewQueue } from "./ingest-review-queue"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { ignoreAndArchiveIngestReview } from "./ingest-review-archive"

let project: Awaited<ReturnType<typeof createTempProject>>
let release: (() => void) | undefined
beforeEach(async () => {
  vi.clearAllMocks()
  project = await createTempProject("review-queue")
  await writeFileRaw(`${project.path}/schema.md`, "# 页面规则")
  useWikiStore.setState({ project: { id: "test", name: "test", path: project.path } })
  useReviewStore.setState({ items: [] })
  vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => { callbacks.onToken('{"summary":"核对完成","issues":[]}'); callbacks.onDone() })
  vi.mocked(retrieveEvidence).mockResolvedValue({ status: "completed", evidence: [], relations: [], targetResults: [], execution: { configVersion: "test", queries: [], channelStates: [], warnings: [], budgetReached: [], elapsedMs: 0, usage: { candidates: 0, queries: 1, contextChars: 0, readChars: 0 } } })
})
afterEach(async () => { release?.(); release = undefined; await pauseIngestReviewQueue(); await project.cleanup() })

async function prepared(name: string) {
  const run = await beginIngestRun(project.path, "test", `raw/sources/${name}.md`, `${name}.md`, "事实。")
  await commitIngestPage(project.path, run.runId, `wiki/concepts/${name}.md`, null, `---\ntype: concept\ntitle: ${name}\nsources: [${name}.md]\n---\n# ${name}\n事实。`, name, "create")
  await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "complete" })
  return run
}

/** 等待磁盘可观察状态，不依赖实现中的定时器或私有队列字段。 */
async function eventually(check: () => Promise<boolean>) {
  await vi.waitFor(async () => expect(await check(), JSON.stringify((await listIngestRuns(project.path)).map(({ sourceIdentity, reviewStatus, review, error }) => ({ sourceIdentity, reviewStatus, steps: review?.steps, error })))).toBe(true), { interval: 10, timeout: 4000 })
}

function holdFirstRequest() {
  vi.mocked(streamChat).mockImplementationOnce(async (_config, _messages, callbacks) => {
    await new Promise<void>((resolve) => { release = resolve })
    callbacks.onToken('{"summary":"核对完成","issues":[]}'); callbacks.onDone()
  })
}

describe("后台审阅调度恢复", () => {
  it("关联知识页变化后重试会重新检索，不沿用失效的已完成检查", async () => {
    // 首次审阅消费关联页的旧版本，随后关联页被其他导入任务更新。
    const run = await prepared("stale-evidence")
    const target = "wiki/concepts/related.md"
    await writeFileRaw(`${project.path}/${target}`, "旧知识。")
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => (await loadIngestRun(project.path, run.runId)).reviewStatus === "complete")
    await pauseIngestReviewQueue()
    const retrieval = await vi.mocked(retrieveEvidence).mock.results[0].value
    await updateIngestRun(project.path, run.runId, (state) => {
      state.review!.retrieval = { ...retrieval, evidence: [{ path: target, revision: "old", text: "旧知识。", startLine: 1, endLine: 1 }] } as NonNullable<typeof state.review>["retrieval"]
      state.reviewStatus = "partial"
    })
    await writeFileRaw(`${project.path}/${target}`, "新知识。")
    const calls = vi.mocked(retrieveEvidence).mock.calls.length
    await retryIngestReview(project.path, run.runId)
    expect((await loadIngestRun(project.path, run.runId)).review?.steps).toEqual({})
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => (await loadIngestRun(project.path, run.runId)).reviewStatus === "complete")
    expect(vi.mocked(retrieveEvidence).mock.calls.length).toBeGreaterThan(calls)
  })

  it("人工忽略并归档后，重新打开项目及唤醒队列均不再执行该记录", async () => {
    const archived = await prepared("archived")
    await updateIngestRun(project.path, archived.runId, (state) => {
      state.reviewStatus = "incomplete"
      state.reviewRequested = false
      state.reviewError = "全库检索未完成"
    })
    await ignoreAndArchiveIngestReview(project.path, archived.runId)
    const next = await prepared("next")
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => (await loadIngestRun(project.path, next.runId)).reviewStatus === "complete")
    const calls = vi.mocked(streamChat).mock.calls.length
    wakeIngestReviewQueue(project.path)
    await restoreIngestReviewQueue(project.path)
    await pauseIngestReviewQueue()
    expect(await loadIngestRun(project.path, archived.runId)).toMatchObject({
      archived: true, reviewStatus: "incomplete", reviewRequested: false, reviewError: "全库检索未完成",
    })
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(calls)
  })

  it("已归档的历史排队标记不会恢复为后台审阅任务", async () => {
    const archived = await prepared("legacy-archived")
    await updateIngestRun(project.path, archived.runId, (state) => { state.archived = true })
    const next = await prepared("visible")
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => (await loadIngestRun(project.path, next.runId)).reviewStatus === "complete")
    expect(await loadIngestRun(project.path, archived.runId)).toMatchObject({ archived: true, reviewStatus: "pending" })
  })

  it("用户明确重新核查归档事项时重新打开记录，仍可完成审阅", async () => {
    const run = await prepared("explicit-recheck")
    await updateIngestRun(project.path, run.runId, (state) => { state.reviewStatus = "incomplete"; state.reviewRequested = false })
    await ignoreAndArchiveIngestReview(project.path, run.runId)
    await retryIngestReview(project.path, run.runId)
    expect(await loadIngestRun(project.path, run.runId)).toMatchObject({ archived: false, reviewStatus: "pending", reviewRequested: true })
    expect((await loadIngestRun(project.path, run.runId)).reviewDismissal).toBeUndefined()
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => (await loadIngestRun(project.path, run.runId)).reviewStatus === "complete")
  })

  it("重查旧合并记录时读取其关联页的当前正文，原运行未提交过该页也能核查", async () => {
    const run = await prepared("scope")
    const target = "wiki/concepts/legacy-target.md"
    const content = "---\ntype: concept\ntitle: 待核查页\nsources: [scope.md]\n---\n# 待核查页\n尚缺少压力测试。"
    await writeFileRaw(`${project.path}/${target}`, content)
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      const material = input.materials?.find((entry: { path: string }) => entry.path === target)
      callbacks.onToken(input.task?.includes("只允许 type=suggestion") && material
        ? JSON.stringify({ issues: [{ type: "suggestion", title: "补充实验", description: "需要验证压力场景", evidence: [{ id: material.id, quote: "尚缺少压力测试。" }] }] })
        : '{"summary":"完成","issues":[]}')
      callbacks.onDone()
    })
    await retryIngestReview(project.path, run.runId, [target])
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => (await loadIngestRun(project.path, run.runId)).reviewStatus === "complete")
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.pages[target]).toBeUndefined()
    expect(saved.review?.currentPages?.[target]).toBe(content)
    expect(useReviewStore.getState().items).toMatchObject([{ type: "suggestion", affectedPages: [target], evidence: [{ path: target, text: "尚缺少压力测试。" }] }])
  })

  it.each(["../outside.md", "wiki/../outside.md", "/outside.md", "wiki/.llm-wiki/secret.md"])("重新核查拒绝不安全的关联路径：%s", async (target) => {
    const run = await prepared("unsafe")
    await expect(retryIngestReview(project.path, run.runId, [target])).rejects.toThrow("核查页面路径无效")
  })

  it("正常缓存命中没有重新生成或登记页面时，不误改为历史失败任务", async () => {
    const run = await beginIngestRun(project.path, "test", "raw/sources/cached.md", "cached.md", "已入库事实。")
    await updateIngestRun(project.path, run.runId, (state) => {
      state.writeStatus = "complete"
      state.reviewStatus = "complete"
    })
    await restoreIngestReviewQueue(project.path)
    expect(await loadIngestRun(project.path, run.runId)).toMatchObject({ writeStatus: "complete", reviewStatus: "complete", pages: {} })
    expect(vi.mocked(streamChat)).not.toHaveBeenCalled()
  })

  it("恢复不凭历史零页记录推断失败，保留原始状态与生成证据", async () => {
    const run = await beginIngestRun(project.path, "test", "raw/sources/log-only.md", "log-only.md", "待合并事实。")
    const raw = "---FILE: wiki/log.md---\n建议合并。\n---END FILE---"
    await updateIngestRun(project.path, run.runId, (state) => {
      state.writeStatus = "complete"
      state.generation = { raw, analysis: "合并已有页，不独立成页。", sourceContext: "待合并事实。", incomplete: false }
    })
    await restoreIngestReviewQueue(project.path)
    const recovered = await loadIngestRun(project.path, run.runId)
    expect(recovered).toMatchObject({ writeStatus: "complete", reviewStatus: "pending", reviewRequested: false })
    expect(recovered.writeError).toBeUndefined()
    expect(recovered.generation).toMatchObject({ raw, incomplete: false })
    expect(vi.mocked(streamChat)).not.toHaveBeenCalled()
  })

  it("写入已完成时后台请求可独立等待；取消立即释放审阅名额，晚到响应不恢复取消任务", async () => {
    const first = await prepared("first")
    await restoreIngestReviewQueue(project.path)
    // 第一轮完成后再建立受控阻塞任务，排除文件时间顺序的干扰。
    await eventually(async () => (await loadIngestRun(project.path, first.runId)).reviewStatus === "complete")
    const held = await prepared("held")
    await updateIngestRun(project.path, held.runId, (state) => { state.events.push({ id: "merge-event", at: 0, kind: "merge", path: "wiki/concepts/held.md", reason: "合并稿质量不通过", outcome: "已采用完整新稿，旧快照已保留" }) })
    holdFirstRequest()
    wakeIngestReviewQueue(project.path)
    await eventually(async () => Boolean(release))
    expect((await loadIngestRun(project.path, held.runId)).writeStatus).toBe("complete")
    const next = await prepared("next")
    await cancelIngestReview(project.path, held.runId)
    expect(useReviewStore.getState().items.some((item) => item.type === "merge" && item.runIds?.includes(held.runId))).toBe(false)
    await eventually(async () => (await loadIngestRun(project.path, next.runId)).reviewStatus === "complete")
    release!()
    await eventually(async () => (await loadIngestRun(project.path, held.runId)).reviewStatus === "cancelled")
  })

  it("切换项目不等待忽略取消的网络；返回后续跑，旧响应不能覆盖新执行", async () => {
    const run = await prepared("switch")
    holdFirstRequest()
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => Boolean(release))
    await pauseIngestReviewQueue()
    expect((await loadIngestRun(project.path, run.runId)).reviewStatus).toBe("pending")
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => (await loadIngestRun(project.path, run.runId)).reviewStatus === "complete")
    release!()
    await eventually(async () => (await loadIngestRun(project.path, run.runId)).reviewStatus === "complete")
  })

  it("重启恢复中断写入和审阅；只重试未完成检查，不重新提交页面", async () => {
    const run = await prepared("restart")
    await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "running"; state.reviewStatus = "running" })
    await restoreIngestReviewQueue(project.path)
    await eventually(async () => (await loadIngestRun(project.path, run.runId)).reviewStatus === "complete")
    expect((await loadIngestRun(project.path, run.runId)).writeStatus).toBe("partial")
    expect((await loadIngestRun(project.path, run.runId)).writeError).toBe("应用中断，可继续补写")
    const commit = vi.spyOn(realFs, "compareAndWriteFile")
    const calls = vi.mocked(streamChat).mock.calls.length
    await updateIngestRun(project.path, run.runId, (state) => { state.reviewStatus = "incomplete" })
    await retryIngestReview(project.path, run.runId)
    await eventually(async () => (await loadIngestRun(project.path, run.runId)).reviewStatus === "complete")
    expect(commit).not.toHaveBeenCalled()
    expect((await loadIngestRun(project.path, run.runId)).writeError).toBe("应用中断，可继续补写")
    expect(vi.mocked(streamChat).mock.calls.length).toBe(calls)
    commit.mockRestore()
  })
})
