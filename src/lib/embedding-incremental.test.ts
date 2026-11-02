import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig } from "@/stores/wiki-store"

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  pages: new Map<string, { fingerprint: string | null; chunks: number; backendRevision?: string }>(),
  invoke: vi.fn(),
  unreadable: new Set<string>(),
}))
vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => [...state.files.keys()].map((id) => ({
    name: `${id.split("/").pop()}.md`, path: `/project/wiki/${id}.md`, is_dir: false,
  }))),
  readFile: vi.fn(async (path: string) => {
    const id = path.slice("/project/wiki/".length, -3)
    if (state.unreadable.has(id)) throw new Error("permission denied")
    return state.files.get(id) ?? ""
  }),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }))
import { embedAllPages, embedPage, getEmbeddingReindexState } from "./embedding"
import { listDirectory } from "@/commands/fs"

const cfg: EmbeddingConfig = {
  enabled: true, endpoint: "http://localhost/embeddings", model: "test", apiKey: "",
}

beforeEach(() => {
  state.files.clear()
  state.pages.clear()
  state.unreadable.clear()
  state.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "embedding_fetch") return [0.1, 0.2]
    if (command === "vector_indexed_pages") {
      return [...state.pages].map(([pageId, value]) => ({ pageId, ...value }))
    }
    if (command === "vector_upsert_indexed_chunks" || command === "vector_upsert_chunks") {
      state.pages.set(args.pageId, { fingerprint: args.fingerprint ?? null, chunks: args.chunks.length })
    }
    if (command === "vector_delete_page") state.pages.delete(args.pageId)
    if (command === "vector_prune_missing_pages") {
      const removed = args.pageIds.filter((id: string) => !state.files.has(id))
      for (const id of removed) state.pages.delete(id)
      return removed.length
    }
  })
})
const embeddingRequests = () => state.invoke.mock.calls.filter(([command]) => command === "embedding_fetch")

describe("增量索引完整同步契约", () => {
  it("正文未修改也替换旧切片算法索引，写入的片段必须能在正文中定位", async () => {
    const content = "# 缓存\n\n" + Array.from({ length: 20 }, (_, index) =>
      `第${index}段：` + "缓存更新需要保留段落间的空行。".repeat(8),
    ).join("\n\n")
    const hash = async (text: string) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
      return `sha256:${Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("")}`
    }
    // 模拟已经持久化的 v1 指纹；页面和模型完全相同，只改变切片算法版本。
    const oldConfig = `ts-v1:${await hash(JSON.stringify({
      pipeline: "wiki-ts-chunks-v1", endpoint: cfg.endpoint, model: cfg.model,
      outputDimensionality: null, maxChunkChars: 1000, overlapChunkChars: 200, extraHeaders: [],
    }))}`
    const oldFingerprint = `${oldConfig}:${await hash(JSON.stringify({ title: "page", content }))}`
    state.files.set("page", content)
    state.pages.set("page", { fingerprint: oldFingerprint, chunks: 4 })
    await expect(embedAllPages("/project", cfg)).resolves.toBe(1)
    expect(state.pages.get("page")?.fingerprint).not.toBe(oldFingerprint)
    const writes = state.invoke.mock.calls.filter(([command]) => command === "vector_upsert_indexed_chunks")
    expect(writes).toHaveLength(1)
    for (const chunk of writes[0][1].chunks) expect(content.includes(chunk.chunk_text)).toBe(true)
    state.invoke.mockClear()
    await expect(embedAllPages("/project", cfg)).resolves.toBe(0)
    expect(embeddingRequests()).toHaveLength(0)
  })

  it("首次索引后再次执行跳过未变页面，只处理新增、修改、删除", async () => {
    state.files.set("unchanged", "不变正文")
    state.files.set("changed", "旧正文")
    state.files.set("deleted", "待删除正文")
    await expect(embedAllPages("/project", cfg)).resolves.toBe(3)
    state.invoke.mockClear()
    // 第二次同步必须复用已落盘的指纹，不能依赖进程内缓存。
    await expect(embedAllPages("/project", cfg)).resolves.toBe(0)
    expect(embeddingRequests()).toHaveLength(0)
    state.files.set("changed", "新正文")
    state.files.set("new", "新增正文")
    state.files.delete("deleted")
    state.invoke.mockClear()
    const progress: number[][] = []
    await expect(embedAllPages("/project", cfg, (done, total) => progress.push([done, total])))
      .resolves.toBe(2)
    expect(embeddingRequests()).toHaveLength(2)
    expect([...state.pages.keys()].sort()).toEqual(["changed", "new", "unchanged"])
    expect(progress[progress.length - 1]).toEqual([3, 3])
    expect(getEmbeddingReindexState()).toMatchObject({ kind: "done", count: 2, removed: 1, skipped: 1 })
  })

  it("模型、维度、分块参数改变需要重建，密钥和并发数改变不重复嵌入", async () => {
    state.files.set("page", "正文")
    await embedAllPages("/project", cfg)
    state.invoke.mockClear()
    await embedAllPages("/project", { ...cfg, apiKey: "rotated", concurrency: 3, batchSize: 2 })
    expect(embeddingRequests()).toHaveLength(0)
    for (const config of [
      { ...cfg, model: "other" }, { ...cfg, outputDimensionality: 128 },
      { ...cfg, maxChunkChars: 500 }, { ...cfg, overlapChunkChars: 0 },
    ]) {
      state.invoke.mockClear()
      await expect(embedAllPages("/project", config)).resolves.toBe(1)
      expect(embeddingRequests()).toHaveLength(1)
    }
  })

  it("已有向量缺少指纹时补建一次，单页入库更新后批量同步可以跳过", async () => {
    state.files.set("page", "正文")
    state.pages.set("page", { fingerprint: null, chunks: 1 })
    await expect(embedAllPages("/project", cfg)).resolves.toBe(1)
    await embedPage("/project", "page", "page", "更新正文", cfg)
    state.files.set("page", "更新正文")
    state.invoke.mockClear()
    await expect(embedAllPages("/project", cfg)).resolves.toBe(0)
    expect(embeddingRequests()).toHaveLength(0)
  })

  it("页面变空或全部删除时清理旧向量", async () => {
    state.files.set("page", "正文")
    await embedAllPages("/project", cfg)
    state.files.set("page", "   ")
    state.invoke.mockClear()
    await expect(embedAllPages("/project", { ...cfg, model: "new-model" })).resolves.toBe(0)
    expect(state.pages.size).toBe(0)
    expect(embeddingRequests()).toHaveLength(0)
    state.files.set("page", "恢复正文")
    await embedAllPages("/project", cfg)
    state.files.clear()
    await expect(embedAllPages("/project", cfg)).resolves.toBe(0)
    expect(state.pages.size).toBe(0)
  })

  it("复用 HTTP/MCP 已索引的相同正文，后端核对后再次修改也不会误跳过", async () => {
    state.files.set("page", "正文")
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("正文"))
    const revision = `sha256:${Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, "0")).join("")}`
    state.pages.set("page", { fingerprint: "backend-fingerprint", chunks: 1, backendRevision: revision })
    await expect(embedAllPages("/project", cfg)).resolves.toBe(0)
    expect(embeddingRequests()).toHaveLength(0)
    state.files.set("page", "新正文")
    await expect(embedAllPages("/project", cfg)).resolves.toBe(1)
  })

  it("整个 wiki 目录被删除时也会清理遗留索引", async () => {
    state.files.set("page", "正文")
    await embedAllPages("/project", cfg)
    state.files.clear()
    vi.mocked(listDirectory).mockRejectedValueOnce(new Error("ENOENT"))
    await expect(embedAllPages("/project", cfg)).resolves.toBe(0)
    expect(state.pages.size).toBe(0)
  })

  it("模型失败保留旧向量且不记录新指纹，下次执行可以重试", async () => {
    state.files.set("page", "旧正文")
    await embedAllPages("/project", cfg)
    const previous = state.pages.get("page")
    state.files.set("page", "新正文")
    const implementation = state.invoke.getMockImplementation()!
    state.invoke.mockImplementation(async (command, args) => {
      if (command === "embedding_fetch") throw new Error("provider unavailable")
      return implementation(command, args)
    })
    await expect(embedAllPages("/project", cfg)).rejects.toThrow("provider unavailable")
    expect(state.pages.get("page")).toEqual(previous)
    state.invoke.mockImplementation(implementation)
    await expect(embedAllPages("/project", cfg)).resolves.toBe(1)
    expect(state.pages.get("page")?.fingerprint).not.toBe(previous?.fingerprint)
  })
})
