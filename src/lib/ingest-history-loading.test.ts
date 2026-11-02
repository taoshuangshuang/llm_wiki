/** 模拟桌面文件调用耗时，验证导入列表的首批数据不会逐条串行等待。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { listIngestRuns } from "./ingest-run"
import { listIngestDocuments } from "./ingest-document"

const fs = vi.hoisted(() => ({ exists: vi.fn(), list: vi.fn(), read: vi.fn() }))
vi.mock("@/commands/fs", () => ({ fileExists: fs.exists, listDirectory: fs.list, readFile: fs.read }))

beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks() })
afterEach(() => { vi.useRealTimers() })

describe.each([
  { kind: "ingest-runs", list: listIngestRuns },
  { kind: "ingest-documents", list: listIngestDocuments },
])("导入历史首批加载 $kind", ({ kind, list }) => {
  it("65 条记录以有限并发读取，保持时间排序并跳过没有清单的目录", async () => {
    const root = `/project/.llm-wiki/${kind}`
    let active = 0
    let peak = 0
    async function io<T>(value: T): Promise<T> {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return value
    }
    fs.exists.mockImplementation((path: string) => io(!path.includes("missing")))
    fs.list.mockResolvedValue([
      ...Array.from({ length: 65 }, (_, index) => ({ name: `run-${index}`, path: `${root}/run-${index}`, is_dir: true })),
      { name: "missing", path: `${root}/missing`, is_dir: true },
      { name: "note.txt", path: `${root}/note.txt`, is_dir: false },
    ])
    fs.read.mockImplementation((path: string) => {
      const parts = path.split("/")
      const id = parts[parts.length - 2]
      return io(JSON.stringify({ version: 1, runId: id, documentRunId: id,
        createdAt: Number(id.split("-")[1]), pages: {}, completedUnits: {}, chunks: [{ id: "chunk-1" }] }))
    })
    const start = Date.now()
    const pending = list("/project")
    await vi.runAllTimersAsync()
    const records = await pending
    const elapsed = Date.now() - start
    expect(records).toHaveLength(65)
    expect(records.map((record) => record.createdAt)).toEqual(Array.from({ length: 65 }, (_, index) => 64 - index))
    // 10ms 的单次文件调用下，串行实现需 1320ms；有限并发应在 250ms 内完成。
    expect(elapsed).toBeLessThan(250)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
    expect(fs.read).toHaveBeenCalledTimes(65)
  })

  it("不存在历史目录时不扫描和读取清单", async () => {
    fs.exists.mockResolvedValue(false)
    await expect(list("/project")).resolves.toEqual([])
    expect(fs.list).not.toHaveBeenCalled()
    expect(fs.read).not.toHaveBeenCalled()
  })

  it("清单损坏时继续报错，不把读取失败伪装为空历史", async () => {
    fs.exists.mockResolvedValue(true)
    fs.list.mockResolvedValue([{ name: "broken", path: `/project/.llm-wiki/${kind}/broken`, is_dir: true }])
    fs.read.mockResolvedValue(JSON.stringify({ version: 0 }))
    await expect(list("/project")).rejects.toThrow(/损坏/)
  })
})
