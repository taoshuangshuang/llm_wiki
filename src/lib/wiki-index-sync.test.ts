import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), sync: vi.fn(), unlisten: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))
vi.mock("@/lib/embedding", () => ({ embedAllPages: mocks.sync }))
import { startWikiIndexSync } from "./wiki-index-sync"

const cfg = { enabled: true, endpoint: "http://localhost", apiKey: "", model: "test" }
const HOUR = 60 * 60_000
let changed: (event: { payload: string }) => void
let stop: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.invoke.mockResolvedValue("watcher-1")
  mocks.sync.mockResolvedValue(0)
  mocks.listen.mockImplementation(async (_event, callback) => { changed = callback; return mocks.unlisten })
})
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers() })

describe("Wiki 文件与索引自动核对", () => {
  it("启动核对一次，文件变更等待完整的 60 秒，其他项目事件不触发", async () => {
    stop = await startWikiIndexSync("/project", cfg)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    changed({ payload: "/project" })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.sync).toHaveBeenCalledTimes(2)
    changed({ payload: "/other" })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.sync).toHaveBeenCalledTimes(2)
  })

  it("等待期间多次修改，每次重置 60 秒，以最后一次修改为准", async () => {
    stop = await startWikiIndexSync("/project", cfg)
    await vi.advanceTimersByTimeAsync(0)
    changed({ payload: "/project" })
    await vi.advanceTimersByTimeAsync(40_000)
    changed({ payload: "/project" })
    await vi.advanceTimersByTimeAsync(40_000)
    changed({ payload: "/project" })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.sync).toHaveBeenCalledTimes(2)
  })

  it("同步期间修改也等待静默窗口，当前批次先结束不会提前补跑", async () => {
    let finish!: () => void
    mocks.sync.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    stop = await startWikiIndexSync("/project", cfg)
    await vi.advanceTimersByTimeAsync(0)
    changed({ payload: "/project" })
    await vi.advanceTimersByTimeAsync(30_000)
    finish()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.sync).toHaveBeenCalledTimes(2)
  })

  it("静默窗口结束时上次同步仍在运行，等其完成再补跑且不并发", async () => {
    let finish!: () => void
    mocks.sync.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    stop = await startWikiIndexSync("/project", cfg)
    await vi.advanceTimersByTimeAsync(0)
    changed({ payload: "/project" })
    await vi.advanceTimersByTimeAsync(90_000)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.sync).toHaveBeenCalledTimes(2)
  })

  it("每小时查漏一次，等待中的文件变更不会被整点查漏提前执行或推迟", async () => {
    stop = await startWikiIndexSync("/project", cfg)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(HOUR - 30_000)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    changed({ payload: "/project" })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.sync).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(HOUR - 30_000)
    expect(mocks.sync).toHaveBeenCalledTimes(3)
  })

  it("失败或监听丢失事件后，每小时核对继续重试；停止后释放监听与定时器", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.sync.mockRejectedValueOnce(new Error("offline"))
    stop = await startWikiIndexSync("/project", cfg)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.sync).toHaveBeenCalledTimes(2)
    changed({ payload: "/project" })
    stop(); stop = undefined
    expect(mocks.unlisten).toHaveBeenCalledOnce()
    expect(mocks.invoke).toHaveBeenCalledWith("stop_wiki_index_watcher", { watcherId: "watcher-1" })
    changed({ payload: "/project" })
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(mocks.sync).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it("关闭向量功能仍启动关系索引监听，但不请求模型", async () => {
    stop = await startWikiIndexSync("/project", { ...cfg, enabled: false })
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(mocks.invoke).toHaveBeenCalledWith("start_wiki_index_watcher", { projectPath: "/project" })
    expect(mocks.listen).toHaveBeenCalledOnce()
    expect(mocks.sync).not.toHaveBeenCalled()
  })
})
