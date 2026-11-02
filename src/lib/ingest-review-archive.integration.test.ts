/** 以真实磁盘验证人工归档契约，不依赖页面仍然存在或模型服务可用。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { ignoreAndArchiveIngestReview } from "./ingest-review-archive"
import { beginIngestRun, commitIngestPage, loadIngestRun, readIngestRunSource, updateIngestRun, type IngestRun } from "./ingest-run"
import { loadReviewItems, saveReviewItems } from "./persist"
import { normalizeReviewItems, useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

let project: Awaited<ReturnType<typeof createTempProject>>
beforeEach(async () => {
  project = await createTempProject("review-archive")
  useWikiStore.setState({ project: { id: "test", name: "test", path: project.path } })
  useReviewStore.setState({ items: [] })
})
afterEach(async () => { vi.restoreAllMocks(); await project.cleanup() })

async function prepared(): Promise<IngestRun> {
  const run = await beginIngestRun(project.path, "test", "raw/sources/a.md", "a.md", "来源事实")
  await commitIngestPage(project.path, run.runId, "wiki/a.md", null, "已写入事实", "a", "create")
  await writeFileRaw(`${project.path}/.llm-wiki/test-log.jsonl`, '{"event":"review-failed"}\n')
  return updateIngestRun(project.path, run.runId, (state) => {
    state.writeStatus = "complete"
    state.reviewStatus = "partial"
    state.reviewRequested = false
    state.reviewError = "全库检索partial：reviewRelationPages"
    state.review = { revision: state.revision, steps: { knowledge: { status: "incomplete", reason: state.reviewError } },
      stepItems: {}, issueIds: [], updatedAt: 0 }
  })
}

const issue = (title: string, runIds: string[]): ReviewItem => ({
  id: title, type: "suggestion", title, description: title, runIds, resolved: false, options: [], createdAt: 0,
})

describe("忽略剩余审阅并归档", () => {
  it("保留写入快照、来源、日志和失败原因，仅忽略本次独有待办并记录人工决定", async () => {
    const run = await prepared()
    const items = normalizeReviewItems([
      issue("本次待办", [run.runId]), issue("共享待办", [run.runId, "another-run"]), issue("其他来源", ["another-run"]),
      { ...issue("已处理", [run.runId]), resolved: true, resolvedAction: "acknowledge" },
    ])
    await saveReviewItems(project.path, items)
    useReviewStore.getState().setItems(items)
    await ignoreAndArchiveIngestReview(project.path, run.runId)

    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved).toMatchObject({ archived: true, reviewRequested: false, writeStatus: "complete", reviewStatus: "partial",
      reviewError: run.reviewError, reviewDismissal: { at: expect.any(Number), revision: run.revision } })
    expect(saved.review).toEqual(run.review)
    expect(saved.pages).toEqual(run.pages)
    expect(saved.events[saved.events.length - 1]).toMatchObject({ kind: "execution", reason: "用户忽略剩余审阅并归档" })
    expect(saved.reviewExecutionId).toBeUndefined()
    expect(await readFileRaw(`${project.path}/wiki/a.md`)).toBe("已写入事实")
    expect(await readIngestRunSource(project.path, run.runId)).toBe("来源事实")
    expect(await readFileRaw(`${project.path}/.llm-wiki/test-log.jsonl`)).toBe('{"event":"review-failed"}\n')
    for (const results of [await loadReviewItems(project.path), useReviewStore.getState().items]) {
      expect(results.find((item) => item.title === "本次待办")).toMatchObject({ resolved: true, dismissed: true, resolvedAction: "dismiss" })
      expect(results.find((item) => item.title === "共享待办")).toMatchObject({ resolved: false })
      expect(results.find((item) => item.title === "其他来源")).toMatchObject({ resolved: false })
      expect(results.find((item) => item.title === "已处理")).toMatchObject({ resolved: true, resolvedAction: "acknowledge" })
    }
  })

  it("历史页面已删除时仍可归档，不通过重试审阅读取缺失页面", async () => {
    const run = await prepared()
    await updateIngestRun(project.path, run.runId, (state) => {
      state.pages["wiki/missing.md"] = { ...state.pages["wiki/a.md"], path: "wiki/missing.md" }
    })
    await ignoreAndArchiveIngestReview(project.path, run.runId)
    expect((await loadIngestRun(project.path, run.runId)).archived).toBe(true)
    expect(await realFs.fileExists(`${project.path}/wiki/missing.md`)).toBe(false)
  })

  it.each<Partial<IngestRun>>([
    { reviewStatus: "pending", reviewRequested: true }, { reviewStatus: "running" },
    { writeStatus: "running" }, { writeStatus: "partial" }, { writeStatus: "failed" },
    { writeStatus: "cancelled" }, { writeStatus: "recovery-required" },
    { writeError: "写入后处理失败" }, { error: "旧写入错误" },
  ])("落盘状态已变化时拒绝归档且不忽略事项：%j", async (state) => {
    const run = await prepared()
    const items = normalizeReviewItems([issue("需要保留", [run.runId])])
    await saveReviewItems(project.path, items)
    await updateIngestRun(project.path, run.runId, (current) => { Object.assign(current, state) })
    await expect(ignoreAndArchiveIngestReview(project.path, run.runId)).rejects.toThrow("任务状态已变化")
    expect((await loadIngestRun(project.path, run.runId)).archived).not.toBe(true)
    expect((await loadReviewItems(project.path))[0].resolved).toBe(false)
  })

  it("忽略状态保存失败时不归档，保留原记录和待办供再次操作", async () => {
    const run = await prepared()
    const items = normalizeReviewItems([issue("需要保留", [run.runId])])
    await saveReviewItems(project.path, items)
    useReviewStore.getState().setItems(items)
    vi.spyOn(realFs, "mergeReviewItems").mockRejectedValueOnce(new Error("磁盘不可写"))
    await expect(ignoreAndArchiveIngestReview(project.path, run.runId)).rejects.toThrow("磁盘不可写")
    expect((await loadIngestRun(project.path, run.runId)).archived).not.toBe(true)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
    expect((await loadReviewItems(project.path))[0].resolved).toBe(false)
  })
})
