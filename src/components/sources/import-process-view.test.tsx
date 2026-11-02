/** 导入页以持久记录呈现真实状态，操作只触发对应来源的任务。 */
import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IngestRun } from "@/lib/ingest-run"

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  documents: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  queue: vi.fn(),
  update: vi.fn(),
  exportLog: vi.fn(),
  enqueue: vi.fn(),
  removeStopped: vi.fn(),
  ignoreAndArchive: vi.fn(),
}))
vi.mock("@/lib/ingest-document", () => ({ listIngestDocuments: mocks.documents }))
vi.mock("@/lib/ingest-review-archive", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ingest-review-archive")>(),
  ignoreAndArchiveIngestReview: mocks.ignoreAndArchive,
}))
vi.mock("@/lib/ingest-log-export", () => ({ exportIngestLog: mocks.exportLog }))
vi.mock("@/lib/ingest-run", () => ({
  listIngestRuns: mocks.list,
  updateIngestRun: mocks.update,
}))
vi.mock("@/lib/ingest-review-queue", () => ({
  retryIngestReview: mocks.retry,
  cancelIngestReview: vi.fn(),
}))
vi.mock("@/lib/ingest-queue", () => ({
  getQueue: mocks.queue,
  cancelTask: mocks.cancel,
  enqueueIngest: mocks.enqueue,
  removeStoppedTasks: mocks.removeStopped,
}))
vi.mock("@/commands/fs", () => ({ readFile: vi.fn() }))
vi.mock("@/components/layout/activity-panel", () => ({
  ActivityPanel: () => null,
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => createElement("button", props, children),
}))

import { ImportProcessView } from "./import-process-view"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"

let view: ReactTestRenderer | undefined
const fixture = (): IngestRun => ({
  version: 1,
  runId: "run-1",
  projectId: "project",
  sourcePath: "raw/sources/a.md",
  sourceIdentity: "a.md",
  sourceRevision: "source",
  attempt: 1,
  createdAt: 0,
  updatedAt: 0,
  writeStatus: "complete",
  reviewStatus: "pending",
  revision: 1,
  reviewRequested: true,
  pages: {
    "wiki/a.md": {
      path: "wiki/a.md",
      before: "旧正文",
      after: "新正文",
      revision: "sha256:abc",
      unitIds: ["a"],
      mode: "merge",
    },
  },
  completedUnits: { a: "wiki/a.md" },
  events: [],
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockReset()
  mocks.removeStopped.mockReset()
  mocks.ignoreAndArchive.mockReset()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  useWikiStore.setState({
    project: { id: "project", name: "project", path: "/project" },
  })
  useReviewStore.setState({ items: [] })
  mocks.documents.mockResolvedValue([])
  mocks.queue.mockReturnValue([])
})
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function render(run: IngestRun | IngestRun[], expand = true) {
  mocks.list.mockResolvedValue(Array.isArray(run) ? run : [run])
  await act(async () => {
    view = create(createElement(ImportProcessView))
    await Promise.resolve()
  })
  // 既有状态与动作场景在用户展开记录后验证；性能场景保留真实的初始折叠状态。
  if (expand) {
    for (const className of ["border-b last:border-b-0", "group/run border-b last:border-b-0 open:bg-muted/10"]) {
      await act(async () => {
        for (const row of view!.root.findAllByType("details").filter((node) => node.props.className === className)) {
          const element = { open: true }
          row.props.onToggle?.({ target: element, currentTarget: element })
        }
      })
    }
  }
  return JSON.stringify(view!.toJSON())
}

describe("导入过程按需渲染", () => {
  it("历史尚未读完时立即展示内存任务与加载提示，不误报暂无记录", async () => {
    let finish!: (runs: IngestRun[]) => void
    mocks.list.mockReturnValue(new Promise<IngestRun[]>((resolve) => { finish = resolve }))
    mocks.queue.mockReturnValue([{ id: "queued-1", sourcePath: "raw/sources/立即显示.md", status: "pending" }])
    await act(async () => { view = create(createElement(ImportProcessView)) })
    const initial = JSON.stringify(view!.toJSON())
    expect(initial).toContain("立即显示.md")
    expect(initial).toContain("正在加载导入记录")
    expect(initial).not.toContain("暂无导入记录")
    await act(async () => { finish([fixture()]) })
    expect(JSON.stringify(view!.toJSON())).toContain("a.md")
    expect(JSON.stringify(view!.toJSON())).not.toContain("正在加载导入记录")
  })

  it("65 条已完成记录初次打开不挂载正文快照，展开单行后只加载该行", async () => {
    const runs = Array.from({ length: 65 }, (_, index) => {
      const run = fixture()
      return { ...run, runId: `run-${index}`, reviewStatus: "complete" as const, reviewRequested: false,
        pages: { "wiki/a.md": { ...run.pages["wiki/a.md"], after: `长正文-${index}:` + "正文".repeat(10000) } } }
    })
    await render(runs, false)
    expect(view!.root.findAllByType("pre")).toHaveLength(0)
    const rows = view!.root.findAllByType("details").filter((node) => node.props.className?.includes("group/run"))
    expect(rows).toHaveLength(65)
    const element = { open: true }
    await act(async () => rows[0].props.onToggle({ target: element, currentTarget: element }))
    expect(JSON.stringify(view!.toJSON())).toContain("长正文-0:")
    expect(JSON.stringify(view!.toJSON())).not.toContain("长正文-1:")
    element.open = false
    await act(async () => rows[0].props.onToggle({ target: element, currentTarget: element }))
    expect(view!.root.findAllByType("pre")).toHaveLength(0)
  })

  it("已完成的分块来源折叠时不挂载子块，展开后才创建子行", async () => {
    const runs = [1, 2].map((index) => ({ ...fixture(), runId: `chunk-${index}`, documentRunId: "document-1",
      chunk: { id: `chunk-${index}`, index, total: 2, headingPath: `章节${index}`, overlapBefore: "" },
      reviewStatus: "complete" as const, reviewRequested: false }))
    await render(runs, false)
    expect(view!.root.findAllByType("details")).toHaveLength(1)
    const parent = view!.root.findByType("details")
    await act(async () => parent.props.onToggle({ target: { open: true }, currentTarget: { open: true } }))
    expect(view!.root.findAllByType("details")).toHaveLength(3)
    expect(view!.root.findAllByType("pre")).toHaveLength(0)
  })

  it("展开后轮询保留状态并更新详情，子级折叠事件不关闭整行", async () => {
    vi.useFakeTimers()
    await render(fixture(), false)
    const row = view!.root.findByType("details")
    const element = { open: true }
    await act(async () => row.props.onToggle({ target: element, currentTarget: element }))
    // 模拟快照自身的折叠事件，主行应保持展开。
    await act(async () => row.props.onToggle({ target: { open: false }, currentTarget: element }))
    expect(row.props.open).toBe(true)
    const updated = fixture()
    updated.pages["wiki/a.md"].after = "后台更新后的正文"
    mocks.list.mockResolvedValue([updated])
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(row.props.open).toBe(true)
    expect(JSON.stringify(view!.toJSON())).toContain("后台更新后的正文")
    element.open = false
    await act(async () => row.props.onToggle({ target: element, currentTarget: element }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(row.props.open).toBe(false)
    expect(view!.root.findAllByType("pre")).toHaveLength(0)
  })
})

describe("来源父行与子块", () => {
  function children(): IngestRun[] {
    return [1, 2].map((index) => ({ ...fixture(), runId: `chunk-run-${index}`, documentRunId: "document-1", chunk: { id: `chunk-${index}`, index, total: 2, headingPath: `章节${index}`, overlapBefore: "" }, reviewStatus: "complete", reviewRequested: false }))
  }

  it("两个子块只统计一个来源，共享路径与事项在父行只统计一次", async () => {
    const runs = children()
    useReviewStore.setState({ items: [{ id: "shared", type: "contradiction", title: "共享问题", description: "同一证据", options: [], createdAt: 0, resolved: false, runIds: runs.map((run) => run.runId) }] })
    const output = await render(runs)
    const visibleText = view!.root.findAllByType("p").map((node) => node.children.filter((child) => typeof child === "string").join("")).join(" ")
    expect(visibleText).toContain("2 个子块")
    expect(view!.root.findAllByType("span").some((node) => node.children.join("") === "1 页（去重）")).toBe(true)
    const all = view!.root.findAllByType("button").find((node) => node.children[0] === "全部")!
    expect(all.findByType("span").children.join("")).toBe("1")
    expect(output).toContain("子块 1")
    expect(output).toContain("子块 2")
    const input = view!.root.findByType("input")
    await act(async () => input.props.onChange({ target: { value: "章节2" } }))
    expect(JSON.stringify(view!.toJSON())).toContain("子块 1")
    expect(JSON.stringify(view!.toJSON())).toContain("子块 2")
  })

  it("父来源归档后隐藏全部子块，不改写子块的审阅结果或归档标记", async () => {
    const runs = children()
    mocks.documents.mockResolvedValue([{ documentRunId: "document-1", archived: true }])
    const output = await render(runs)
    expect(output).toContain("暂无导入记录")
    expect(output).not.toContain("子块 1")
    expect(mocks.update).not.toHaveBeenCalled()
    expect(runs.every((run) => !run.archived && run.reviewStatus === "complete")).toBe(true)
  })

  it("同一文件的当前导入只绑定对应父来源，不把历史导入误计为进行中", async () => {
    const old = children()
    const current = children().map((run) => ({ ...run, runId: `new-${run.runId}`, documentRunId: "document-new" }))
    current[0].writeStatus = "running"
    mocks.queue.mockReturnValue([{ id: "task-new", projectId: "project", sourcePath: "raw/sources/a.md", documentRunId: "document-new", status: "processing" }])
    await render([...old, ...current])
    const counts = (label: string) => view!.root.findAllByType("button").find((node) => node.children[0] === label)!.findByType("span").children.join("")
    expect(counts("全部")).toBe("2")
    expect(counts("进行中")).toBe("1")
    expect(counts("已完成")).toBe("1")
  })

  it("前块写入失败且后块尚未执行时，父行收敛为写入失败", async () => {
    const runs = children()
    runs[0].writeStatus = "failed"
    runs[1].writeStatus = "pending"
    await render(runs)
    const active = view!.root.findAllByType("button").find((node) => node.children[0] === "进行中")!
    const failed = view!.root.findAllByType("button").find((node) => node.children[0] === "写入失败")!
    expect(active.findByType("span").children.join("")).toBe("0")
    expect(failed.findByType("span").children.join("")).toBe("1")
  })

  it("轮询刷新不覆盖父行的人工折叠选择", async () => {
    vi.useFakeTimers()
    const runs = children()
    runs[0].reviewStatus = "running"
    await render(runs)
    const parent = view!.root.findAllByType("details").find((node) => node.props.onToggle)!
    expect(parent.props.open).toBe(true)
    await act(async () => parent.props.onToggle({ currentTarget: { open: false } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(view!.root.findAllByType("details").find((node) => node.props.onToggle)!.props.open).toBe(false)
  })
})

describe("导入过程状态与动作", () => {
  it("跳过记录单独计数并说明原因，不显示失败、补写或审阅动作", async () => {
    const run: IngestRun = {
      ...fixture(), pages: {}, writeStatus: "skipped", reviewStatus: "not-applicable", reviewRequested: false,
      sourceSkip: { reason: "headings-only", message: "来源仅含标题，没有正文内容" },
    }
    const text = await render(run)
    expect(text).toContain("跳过原因：")
    expect(text).toContain("来源仅含标题，没有正文内容")
    expect(text).toContain("未执行")
    expect(text).not.toContain("尚未写入页面")
    const buttons = view!.root.findAllByType("button")
    const filter = buttons.find((node) => node.children.includes("已跳过"))!
    expect(filter.findByType("span").children.join("")).toBe("1")
    const failures = buttons.find((node) => node.children.includes("写入失败"))!
    expect(failures.findByType("span").children.join("")).toBe("0")
    const completed = buttons.find((node) => node.children.includes("已完成"))!
    expect(completed.findByType("span").children.join("")).toBe("0")
    expect(buttons.some((node) => node.children.includes("继续补写"))).toBe(false)
    expect(buttons.some((node) => node.children.includes("重试审阅"))).toBe(false)
    await act(async () => filter.props.onClick())
    expect(JSON.stringify(view!.toJSON())).toContain("a.md")
    const retry = view!.root.findAllByType("button").find((node) => node.children.includes("重新导入"))!
    await act(async () => retry.props.onClick())
    expect(mocks.enqueue).toHaveBeenCalledWith("project", "raw/sources/a.md")
  })

  it("需审阅记录可忽略剩余审阅并归档，成功后从列表和计数中移除", async () => {
    const run = { ...fixture(), reviewStatus: "partial" as const, reviewRequested: false }
    mocks.ignoreAndArchive.mockImplementation(async () => { run.archived = true })
    await render(run)
    const button = view!.root.findAllByType("button").find((node) => node.children.includes("忽略剩余审阅并归档"))!
    expect(button).toBeDefined()
    await act(async () => button.props.onClick())
    expect(mocks.ignoreAndArchive).toHaveBeenCalledWith("/project", "run-1")
    expect(JSON.stringify(view!.toJSON())).not.toContain('"a.md"')
    const attention = view!.root.findAllByType("button").find((node) => node.children.includes("需审阅"))!
    expect(attention.findByType("span").children.join("")).toBe("0")
    expect(mocks.retry).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it.each<Partial<IngestRun>>([
    { reviewStatus: "running" }, { reviewStatus: "pending" }, { writeStatus: "partial", reviewStatus: "partial" },
    { reviewStatus: "incomplete", writeError: "写入后处理失败" },
    { reviewStatus: "complete", reviewRequested: false },
  ])("进行中、写入故障或无需审阅时不提供忽略入口：%j", async (state) => {
    await render({ ...fixture(), ...state })
    expect(view!.root.findAllByType("button").some((node) => node.children.includes("忽略剩余审阅并归档"))).toBe(false)
  })

  it("归档失败时显示原因，原始部分完成记录仍可操作", async () => {
    mocks.ignoreAndArchive.mockRejectedValueOnce(new Error("归档保存失败"))
    await render({ ...fixture(), reviewStatus: "incomplete", reviewRequested: false })
    const button = view!.root.findAllByType("button").find((node) => node.children.includes("忽略剩余审阅并归档"))!
    await act(async () => button.props.onClick())
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("归档保存失败")
    expect(text).toContain('"a.md"')
    expect(text).toContain("审阅未完成")
  })

  it("批量清理移除失败和已取消的队列记录，保留正在导入的任务", async () => {
    let tasks = [
      { id: "failed-a", sourcePath: "raw/sources/失败甲.md", status: "failed", error: "模板错误" },
      { id: "failed-b", sourcePath: "raw/sources/失败乙.md", status: "failed", error: "模板错误" },
      { id: "active", sourcePath: "raw/sources/运行中.md", status: "processing" },
      { id: "cancelled", sourcePath: "raw/sources/已取消.md", status: "cancelled" },
    ]
    mocks.queue.mockImplementation(() => tasks)
    mocks.removeStopped.mockImplementation(async (ids: string[]) => { tasks = tasks.filter((task) => !ids.includes(task.id)); return ids.length })
    await render([])
    const clear = view!.root.findAllByType("button").find((node) => node.children.includes("清理失败记录"))
    expect(clear).toBeDefined()
    await act(async () => clear!.props.onClick())
    expect(mocks.removeStopped).toHaveBeenCalledWith(["failed-a", "failed-b", "cancelled"])
    const text = JSON.stringify(view!.toJSON())
    expect(text).not.toContain("失败甲.md")
    expect(text).toContain("运行中.md")
    expect(text).not.toContain("已取消.md")
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it("没有运行记录的已取消任务也能单条删除", async () => {
    mocks.queue.mockReturnValue([{ id: "cancelled", sourcePath: "raw/sources/已取消.md", status: "cancelled" }])
    await render([])
    const remove = view!.root.findAllByType("button").find((node) => node.children.includes("删除记录"))
    expect(remove).toBeDefined()
    await act(async () => remove!.props.onClick())
    expect(mocks.removeStopped).toHaveBeenCalledWith(["cancelled"])
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it.each(["single", "batch"])("写入和审阅均已取消且没有页面时支持清理记录：%s", async (mode) => {
    const run: IngestRun = { ...fixture(), writeStatus: "cancelled", reviewStatus: "cancelled", pages: {}, completedUnits: {} }
    mocks.queue.mockReturnValue([{ id: "cancelled", sourcePath: "/project/raw/sources/a.md", status: "cancelled" }])
    mocks.update.mockImplementation(async (_path, _id, change) => { change(run); return run })
    await render(run)
    const label = mode === "single" ? "删除记录" : "清理失败记录"
    const remove = view!.root.findAllByType("button").find((node) => node.children.includes(label))
    expect(remove).toBeDefined()
    expect(remove!.props.disabled).toBe(false)
    if (mode === "batch") expect(remove!.findByType("span").children.join("")).toBe("1")
    await act(async () => remove!.props.onClick())
    expect(mocks.removeStopped).toHaveBeenCalledWith(["cancelled"])
    expect(run.archived).toBe(true)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("单条删除失败运行只隐藏记录并移除关联失败队列项，不删除页面快照", async () => {
    const run = { ...fixture(), writeStatus: "partial" as const, reviewStatus: "complete" as const, reviewRequested: false }
    const tasks = [{ id: "failed-task", sourcePath: "/project/raw/sources/a.md", status: "failed" }]
    mocks.queue.mockReturnValue(tasks)
    mocks.update.mockImplementation(async (_path, _id, change) => { change(run); return run })
    await render(run)
    const remove = view!.root.findAllByType("button").find((node) => node.children.includes("删除记录"))
    expect(remove).toBeDefined()
    await act(async () => remove!.props.onClick())
    expect(mocks.removeStopped).toHaveBeenCalledWith(["failed-task"])
    expect(run.archived).toBe(true)
    expect(run.pages["wiki/a.md"].before).toBe("旧正文")
    expect(run.pages["wiki/a.md"].after).toBe("新正文")
    expect(mocks.retry).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("批量清理遵守当前搜索范围，不清理未展示的失败记录", async () => {
    mocks.queue.mockReturnValue([
      { id: "a", sourcePath: "raw/sources/甲.md", status: "failed", error: "错误" },
      { id: "b", sourcePath: "raw/sources/乙.md", status: "failed", error: "错误" },
    ])
    await render([])
    await act(async () => view!.root.findByProps({ "aria-label": "搜索来源或页面" }).props.onChange({ target: { value: "甲.md" } }))
    const clear = view!.root.findAllByType("button").find((node) => node.children.includes("清理失败记录"))!
    expect(clear.findByType("span").children.join("")).toBe("1")
    await act(async () => clear.props.onClick())
    expect(mocks.removeStopped).toHaveBeenCalledWith(["a"])
  })

  it("失败来源的后台审阅仍在运行时，不能清理该运行记录", async () => {
    await render({ ...fixture(), writeStatus: "partial", reviewStatus: "running" })
    const remove = view!.root.findAllByType("button").find((node) => node.children.includes("删除记录"))!
    const clear = view!.root.findAllByType("button").find((node) => node.children.includes("清理失败记录"))!
    expect(remove.props.disabled).toBe(true)
    expect(clear.props.disabled).toBe(true)
    expect(mocks.removeStopped).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("点击后发现任务已开始审阅时，不按过期界面状态隐藏运行记录", async () => {
    const run = { ...fixture(), writeStatus: "partial" as const, reviewStatus: "complete" as const, reviewRequested: false }
    const current: IngestRun = { ...run, reviewStatus: "running" }
    mocks.update.mockImplementation(async (_path, _id, change) => { change(current); return current })
    await render(run)
    const remove = view!.root.findAllByType("button").find((node) => node.children.includes("删除记录"))!
    await act(async () => remove.props.onClick())
    expect(current.archived).not.toBe(true)
    expect(JSON.stringify(view!.toJSON())).toContain("任务状态已变化或仍在执行")
  })

  it("模板预检失败且没有运行记录时，可手动重新导入并保留原文件夹上下文", async () => {
    const task = { id: "template-failed", sourcePath: "/project/raw/sources/conversations/source.md", folderContext: "已确认的会话知识",
      status: "failed", error: "入库提示词模板缺少必要变量：{{index_context}}", retryCount: 3 }
    mocks.queue.mockReturnValue([task])
    await render([])
    const retry = view!.root.findAllByType("button").find((node) => node.children.includes("重新导入"))
    expect(retry).toBeDefined()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    await act(async () => retry!.props.onClick())
    expect(mocks.enqueue).toHaveBeenCalledWith("project", task.sourcePath, task.folderContext)
    expect(mocks.retry).not.toHaveBeenCalled()
  })

  it("重新导入排队失败时展示原因，仍保留原始失败信息", async () => {
    mocks.queue.mockReturnValue([{ id: "failed", sourcePath: "/project/raw/sources/a.md", status: "failed", error: "模板预检失败", folderContext: "" }])
    mocks.enqueue.mockRejectedValueOnce(new Error("队列未能持久化"))
    await render([])
    const button = view!.root.findAllByType("button").find((node) => node.children.includes("重新导入"))!
    await act(async () => button.props.onClick())
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("队列未能持久化")
    expect(text).toContain("模板预检失败")
    expect(mocks.retry).not.toHaveBeenCalled()
  })

  it.each(["suggestion", "missing-page", "duplicate"])("%s检查失败按实际重要程度决定是否进入需审阅", async (check) => {
    const run: IngestRun = {
      ...fixture(), reviewStatus: "incomplete", reviewRequested: false, reviewError: "检查服务不可用",
      review: {
        revision: 1, issueIds: [], stepItems: {}, updatedAt: 0,
        steps: { merge: { status: "complete" }, content: { status: "complete" }, format: { status: "complete" }, conflict: { status: "complete" }, knowledge: { status: "incomplete", reason: "检查服务不可用" } },
        knowledgeChecks: Object.fromEntries(["existing-conflict", "duplicate", "missing-page", "suggestion"].map((id) => [id, { status: id === check ? "incomplete" : "complete", items: [] }])),
        retrieval: { status: "completed", evidence: [], relations: [], targetResults: [], execution: {
          configVersion: "test", queries: [], channelStates: [], warnings: [], budgetReached: [], elapsedMs: 0,
          usage: { candidates: 0, queries: 1, contextChars: 0, readChars: 0 },
        } },
      },
    }
    const text = await render(run)
    const attention = view!.root.findAllByType("button").find((button) => button.children.includes("需审阅"))!
    expect(attention.findByType("span").children.join("")).toBe(check === "duplicate" ? "1" : "0")
    expect(text).toContain("检查服务不可用")
    if (check !== "duplicate") expect(text).toContain("重要审阅完成")
  })

  it("仅有研究和知识补充时归入已完成，需审阅数量为零且保留非重要入口", async () => {
    const run = { ...fixture(), reviewStatus: "complete" as const, reviewRequested: false }
    useReviewStore.setState({ items: (["suggestion", "missing-page"] as const).map((type) => ({
      id: type, type, title: "按需补充", description: "来源未明确", options: [], resolved: false, createdAt: 0, runIds: [run.runId],
    })) })
    await render(run)
    const tab = (name: string) => view!.root.findAllByType("button").find((button) => button.children.includes(name))!
    expect(tab("需审阅").findByType("span").children.join("")).toBe("0")
    expect(tab("已完成").findByType("span").children.join("")).toBe("1")
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("无重要待审项")
    expect(text).toContain("非重要待办")
    expect(text).toContain("查看事项")
    // 加入一个真正的内容遗漏后才需要人工审阅，非重要项不增加待处理数量。
    await act(async () => useReviewStore.setState((state) => ({ items: [...state.items, {
      id: "coverage", type: "coverage", title: "遗漏原文", description: "需要补回", options: [], resolved: false, createdAt: 0, runIds: [run.runId],
    }] })))
    expect(tab("需审阅").findByType("span").children.join("")).toBe("1")
    expect(JSON.stringify(view!.toJSON())).toContain("1 项待处理")
  })

  it.each(["complete", "failed", "partial", "cancelled", "running"] as const)("%s 写入记录均可直接导出日志", async (writeStatus) => {
    const run = { ...fixture(), writeStatus }
    await render(run)
    const button = view!.root.findAllByType("button").find((node) => node.children.includes("导出日志"))!
    mocks.exportLog.mockResolvedValue("/exports/a.jsonl")
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    await act(async () => button.props.onClick(event))
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.exportLog).toHaveBeenCalledWith("/project", "raw/sources/a.md", run, undefined)
    expect(JSON.stringify(view!.toJSON())).toContain("日志已导出")
  })

  it("读取来源失败且未建立运行记录的任务也能导出", async () => {
    const task = { id: "task-failed", sourcePath: "raw/sources/b.pdf", status: "failed", error: "读取失败" }
    mocks.queue.mockReturnValue([task])
    await render([])
    const button = view!.root.findAllByType("button").find((node) => node.children.includes("导出日志"))!
    await act(async () => button.props.onClick())
    expect(mocks.exportLog).toHaveBeenCalledWith("/project", task.sourcePath, undefined, task)
  })

  it("导出失败明确显示错误，不改变导入任务", async () => {
    await render(fixture())
    mocks.exportLog.mockRejectedValueOnce(new Error("磁盘不可写"))
    const button = view!.root.findAllByType("button").find((node) => node.children.includes("导出日志"))!
    await act(async () => button.props.onClick({ preventDefault() {}, stopPropagation() {} }))
    expect(JSON.stringify(view!.toJSON())).toContain("导出日志失败")
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.retry).not.toHaveBeenCalled()
  })
  it("等待审阅不显示未发现问题，并可查看写入前后快照", async () => {
    const text = await render(fixture())
    expect(text).toContain("等待审阅")
    expect(text).not.toContain("未发现问题")
    expect(text).toContain("旧正文")
    expect(text).toContain("新正文")
  })

  it("部分写入完成审阅时明确范围；审阅重试不重新入库", async () => {
    const text = await render({
      ...fixture(),
      writeStatus: "partial",
      reviewStatus: "complete",
    })
    expect(text).toContain("仅检查已写页面")
    expect(text).not.toContain("未发现问题")
    const button = view!.root.findAllByType("button").find((node) => node.children.includes("重新审阅"))!
    await act(async () => button.props.onClick())
    expect(mocks.retry).toHaveBeenCalledWith("/project", "run-1")
  })

  it("队列绝对路径能关联到相对路径运行记录，取消按钮只取消该导入", async () => {
    mocks.queue.mockReturnValue([
      {
        id: "task-1",
        sourcePath: "/project/raw/sources/a.md",
        status: "processing",
      },
    ])
    await render({ ...fixture(), writeStatus: "running" })
    const buttons = view!.root.findAllByType("button").filter((node) => node.children.includes("取消导入"))
    expect(buttons).toHaveLength(1)
    await act(async () => buttons[0].props.onClick())
    expect(mocks.cancel).toHaveBeenCalledWith("task-1")
  })

  it("需审阅筛选保留检查未完成的任务，搜索可以继续按目标页面缩小范围", async () => {
    // 检查尚未完成也需要关注，不能只把失败任务或人工事项当作需审阅。
    const attentionRun: IngestRun = {
      ...fixture(),
      runId: "run-2",
      sourceIdentity: "raw/待迁移.md",
      reviewStatus: "incomplete",
      review: {
        revision: 1,
        steps: { knowledge: { status: "incomplete", reason: "模板需要迁移" } },
        stepItems: {},
        issueIds: [],
        updatedAt: 0,
      },
    }
    await render([{ ...fixture(), sourceIdentity: "raw/正常任务.md" }, attentionRun])
    const filter = view!.root.findAllByType("button").find((node) => node.children.includes("需审阅"))!
    await act(async () => filter.props.onClick())
    let text = JSON.stringify(view!.toJSON())
    expect(text).toContain("待迁移.md")
    expect(text).not.toContain("正常任务.md")
    expect(text).toContain("模板需要迁移")

    // 搜索覆盖写入目标，用户只记得生成页面路径时也能定位来源任务。
    const search = view!.root.findByProps({ "aria-label": "搜索来源或页面" })
    await act(async () => search.props.onChange({ target: { value: "wiki/a.md" } }))
    expect(JSON.stringify(view!.toJSON())).toContain("待迁移.md")
    await act(async () => search.props.onChange({ target: { value: "不存在的页面" } }))
    text = JSON.stringify(view!.toJSON())
    expect(text).not.toContain("待迁移.md")
    expect(text).toContain("没有符合条件的任务")
  })

  it("进行中、需审阅、已完成互斥，待办处理后才能转入已完成", async () => {
    const finished = { ...fixture(), reviewStatus: "complete" as const, reviewRequested: false }
    const runs = [
      { ...finished, runId: "done", sourceIdentity: "已处理来源.md" },
      { ...finished, runId: "todo", sourceIdentity: "待审来源.md" },
      { ...fixture(), runId: "active", sourceIdentity: "执行中来源.md" },
    ]
    const issue = (runId: string, resolved: boolean, historical = false): ReviewItem => ({
      id: `issue-${runId}-${historical}`, type: "confirm", title: "核对内容", description: "需要人工核查",
      options: [], resolved, historical, createdAt: 0, runIds: [runId],
    })
    useReviewStore.setState({ items: [
      issue("done", true), issue("done", false, true), issue("todo", false), issue("active", false),
    ] })
    await render(runs)
    const tab = (label: string) => view!.root.findAllByType("button").find((node) => node.children.includes(label))!
    const counts = () => ["全部", "进行中", "写入失败", "需审阅", "已完成"].map((label) => tab(label).findByType("span").children.join(""))
    // 自动流程仍在执行的记录只计入进行中；历史事项和已解决事项不阻碍完成。
    expect(counts()).toEqual(["3", "1", "0", "1", "1"])
    for (const [label, visible, hidden] of [
      ["进行中", "执行中来源.md", ["已处理来源.md", "待审来源.md"]],
      ["需审阅", "待审来源.md", ["已处理来源.md", "执行中来源.md"]],
      ["已完成", "已处理来源.md", ["待审来源.md", "执行中来源.md"]],
    ] as const) {
      await act(async () => tab(label).props.onClick())
      const text = JSON.stringify(view!.toJSON())
      expect(text).toContain(visible)
      for (const name of hidden) expect(text).not.toContain(name)
    }
    // 人工处理完成后立即更新分类和计数，无需重新导入或重跑审阅。
    await act(async () => useReviewStore.getState().resolveItem("issue-todo-false", "acknowledge"))
    expect(counts()).toEqual(["3", "1", "0", "0", "2"])
    expect(JSON.stringify(view!.toJSON())).toContain("待审来源.md")
    await act(async () => tab("需审阅").props.onClick())
    expect(JSON.stringify(view!.toJSON())).not.toContain("待审来源.md")
  })

  it("失败、取消和检查未完成的记录不能计入已完成，归档也只处理已完成记录", async () => {
    const finished = { ...fixture(), reviewStatus: "complete" as const, reviewRequested: false }
    const runs: IngestRun[] = [
      { ...finished, runId: "done", sourceIdentity: "正常完成.md" },
      // 失败记录可能保留默认的等待审阅状态，但未请求审阅时没有自动任务在执行。
      { ...finished, runId: "failed", sourceIdentity: "失败来源.md", writeStatus: "failed", reviewStatus: "pending" },
      { ...finished, runId: "cancelled", sourceIdentity: "取消来源.md", reviewStatus: "cancelled" },
      { ...finished, runId: "incomplete", sourceIdentity: "检查未完成.md", reviewStatus: "incomplete" },
      { ...finished, runId: "todo", sourceIdentity: "待办来源.md" },
    ]
    useReviewStore.setState({ items: [{
      id: "todo", type: "confirm", title: "待核对", description: "仍需人工处理", options: [],
      resolved: false, createdAt: 0, runIds: ["todo"],
    }] })
    mocks.queue.mockReturnValue([
      { id: "queue-active", sourcePath: "raw/sources/排队来源.md", status: "pending" },
      { id: "queue-failed", sourcePath: "raw/sources/队列失败.md", status: "failed" },
      { id: "queue-cancelled", sourcePath: "raw/sources/队列取消.md", status: "cancelled" },
    ])
    await render(runs)
    const tab = (label: string) => view!.root.findAllByType("button").find((node) => node.children.includes(label))!
    expect(["全部", "进行中", "写入失败", "需审阅", "已完成"].map((label) => tab(label).findByType("span").children.join("")))
      .toEqual(["8", "1", "3", "3", "1"])
    const failedSources = ["失败来源.md", "队列失败.md", "队列取消.md"]
    const reviewSources = ["取消来源.md", "检查未完成.md", "待办来源.md"]
    for (const [label, visible, hidden] of [
      ["写入失败", failedSources, reviewSources],
      ["需审阅", reviewSources, failedSources],
    ] as const) {
      await act(async () => tab(label).props.onClick())
      const text = JSON.stringify(view!.toJSON())
      for (const name of visible) expect(text).toContain(name)
      for (const name of [...hidden, "正常完成.md", "排队来源.md"]) expect(text).not.toContain(name)
      if (label === "写入失败") expect(text).toContain("已取消导入")
    }
    const archive = view!.root.findAllByType("button").find((node) => node.children.includes("归档已完成记录"))!
    await act(async () => archive.props.onClick())
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith("/project", "done", expect.any(Function))
    const archived = { ...finished, archived: false }
    mocks.update.mock.calls[0][2](archived)
    expect(archived.archived).toBe(true)
  })

  it.each<{ name: string; state: Partial<IngestRun>; category: string }>([
    { name: "部分写入后后台仍在审阅", state: { writeStatus: "partial", reviewStatus: "running" }, category: "写入失败" },
    { name: "入库被取消且已有页面", state: { writeStatus: "cancelled" }, category: "写入失败" },
    { name: "页面提交需要恢复", state: { writeStatus: "recovery-required" }, category: "写入失败" },
    { name: "写入重试中仍保留旧错误", state: { writeStatus: "running", writeError: "上次写入失败" }, category: "进行中" },
    { name: "写入完成后审阅异常", state: { reviewError: "审阅服务不可用" }, category: "需审阅" },
    { name: "写入成功后缓存保存异常且仍有后台审阅", state: { reviewStatus: "pending", reviewRequested: true, error: "缓存保存异常" }, category: "需审阅" },
    { name: "写入成功但审阅被取消", state: { reviewStatus: "cancelled" }, category: "需审阅" },
  ])("$name按执行阶段归入$category，不受已写页数影响", async ({ state, category }) => {
    await render({ ...fixture(), reviewStatus: "complete", reviewRequested: false, ...state })
    const tabs = ["进行中", "写入失败", "需审阅", "已完成"]
    for (const label of tabs) {
      const tab = view!.root.findAllByType("button").find((node) => node.children.includes(label))!
      expect(tab.findByType("span").children.join("")).toBe(label === category ? "1" : "0")
      await act(async () => tab.props.onClick())
      expect(JSON.stringify(view!.toJSON()).includes('"a.md"')).toBe(label === category)
    }
  })

  it("旧写入版本的检查结果注明来源，空活动区不占据页面", async () => {
    // 当前写入版本已经变化，保留旧检查结果时必须明确它不属于当前版本。
    const text = await render({
      ...fixture(),
      revision: 2,
      review: {
        revision: 1,
        steps: { knowledge: { status: "incomplete", reason: "模板需要迁移" } },
        stepItems: {},
        issueIds: [],
        updatedAt: 0,
      },
    })
    expect(text).toContain("上次审阅记录")
    expect(text).not.toContain("队列、文件同步与其他活动")
    expect(text).toContain("合并")
    expect(text).not.toContain('"children":["merge"]')
  })
})
