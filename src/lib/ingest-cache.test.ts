import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock fs so the tests don't touch real disk.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileExists: vi.fn(),
}))

import { checkIngestCache, saveIngestCache, listIngestedSourceIdentities } from "./ingest-cache"
import { readFile, writeFile, fileExists } from "@/commands/fs"

const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockFileExists = vi.mocked(fileExists)

beforeEach(() => {
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockFileExists.mockReset()
  mockWriteFile.mockResolvedValue(undefined as unknown as void)
})

describe("ingest-cache — checkIngestCache", () => {
  it.each([[], ["wiki/log.md"], ["wiki/index.md", "wiki/overview.md"], ["wiki/sources/foo.md"], ["/project/wiki/log.md"], ["/other/wiki/concepts/foo.md"]].map((paths) => ({ paths })))("不保存没有当前项目知识页的成功缓存：$paths", async ({ paths }) => {
    mockReadFile.mockResolvedValue(JSON.stringify({ entries: {} }))
    await saveIngestCache("/project", "foo.pdf", "hello", paths)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it("历史日志缓存不出现在已入库来源中，真实知识页支持项目绝对路径", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ entries: {
      "log.md": { hash: "old", timestamp: 0, filesWritten: ["wiki/log.md"] },
      "valid.md": { hash: "old", timestamp: 0, filesWritten: ["/project/wiki/concepts/valid.md", "wiki/log.md"] },
    } }))
    expect(await listIngestedSourceIdentities("/project")).toEqual(["valid.md"])
  })

  it("无知识页的结果会移除同一来源已有的错误成功缓存", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ entries: {
      "foo.pdf": { hash: "old", timestamp: 0, filesWritten: ["wiki/log.md"] },
    } }))
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/log.md"])
    expect(JSON.parse(mockWriteFile.mock.calls[0][1])).toEqual({ entries: {} })
  })
  it("returns null when no entry exists", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ entries: {} }))
    const result = await checkIngestCache("/project", "foo.pdf", "content")
    expect(result).toBeNull()
  })

  it("returns cached filesWritten when hash matches AND all files exist", async () => {
    // Pre-seed cache with a hash matching "hello".
    // We compute the expected hash by running saveIngestCache first in
    // a controlled round-trip, then feeding the same JSON back in.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])

    mockFileExists.mockResolvedValue(true)
    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toEqual(["wiki/sources/foo.md", "wiki/entities/bar.md"])
  })

  it("returns null when hash matches but a cached file no longer exists on disk", async () => {
    // Prime cache, then simulate user deleting one of the written files.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])

    // wiki/entities/bar.md has been deleted since the cache was written.
    mockFileExists.mockImplementation(async (p: string) => {
      return !p.includes("entities/bar.md")
    })

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })

  it("returns null when the content hash no longer matches (cache stale on content change)", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/concepts/foo.md"])

    const result = await checkIngestCache("/project", "foo.pdf", "different content")
    expect(result).toBeNull()
  })

  it("returns null if fileExists itself throws (safer to re-ingest than to trust)", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/concepts/foo.md"])

    mockFileExists.mockRejectedValue(new Error("stat failed"))

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })
})
