/** 语义召回边界：真实路径过滤、页面聚合、批次补查和失败降级，不调用外部服务。 */
import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("./embedding", async (importOriginal) => ({
  ...await importOriginal<typeof import("./embedding")>(),
  fetchEmbedding: vi.fn(), vectorSearchChunks: vi.fn(), getLastEmbeddingError: () => "测试服务不可用",
}))
import { fetchEmbedding, vectorSearchChunks } from "./embedding"
import { IngestSemanticRecall } from "./ingest-semantic"
import { useWikiStore } from "@/stores/wiki-store"

const config = { ...useWikiStore.getState().embeddingConfig, enabled: true, endpoint: "http://embedding.test", model: "test" }
const content = "---\ntitle: Redis 持久化\n---\n# Redis 持久化\n\nRDB 和 AOF 的使用条件。"
const chunk = (id: string, score = 0.9) => ({
  chunk_id: `${id}:0`, page_id: id, chunk_index: 0, chunk_text: "持久化", heading_path: "", score,
})

beforeEach(() => {
  vi.mocked(fetchEmbedding).mockReset().mockResolvedValue([1, 0])
  vi.mocked(vectorSearchChunks).mockReset().mockResolvedValue([])
})

describe("入库语义候选召回", () => {
  it("同页多个块只返回一次，过滤摘要、导航、失效索引和不安全路径", async () => {
    vi.mocked(vectorSearchChunks).mockResolvedValue([
      chunk("concepts/redis"), chunk("concepts/redis", 0.8), chunk("sources/redis"),
      chunk("index"), chunk("concepts/deleted"), chunk("../secret"),
    ])
    const warn = vi.fn()
    const recall = new IngestSemanticRecall("/project", config, warn)

    expect(await recall.find("Redis 持久化", [
      "wiki/concepts/redis.md", "wiki/sources/redis.md", "wiki/index.md", "wiki/../secret.md",
    ])).toEqual(["wiki/concepts/redis.md"])
    expect(warn).not.toHaveBeenCalled()
  })

  it("兼容可唯一定位的旧 slug，但不猜测跨目录同名目标", async () => {
    vi.mocked(vectorSearchChunks).mockResolvedValue([chunk("redis"), chunk("aof")])
    const recall = new IngestSemanticRecall("/project", config, vi.fn())

    expect(await recall.find("Redis", ["wiki/a/redis.md", "wiki/b/redis.md", "wiki/custom/aof.md"]))
      .toEqual(["wiki/custom/aof.md"])
  })

  it("库中距离换算分数只作排序，不使用余弦阈值误删候选，最多取八页", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `wiki/custom/page-${index}.md`)
    vi.mocked(vectorSearchChunks).mockResolvedValue(paths.map((_, index) => chunk(`custom/page-${index}`, 0.4 - index * 0.01)))
    const recall = new IngestSemanticRecall("/project", config, vi.fn())

    expect(await recall.find("某主题", paths)).toEqual(paths.slice(0, 8))
  })

  it("库中未索引的本批次页面按余弦补查，并缓存未变化页面的查询向量", async () => {
    const recall = new IngestSemanticRecall("/project", config, vi.fn())
    recall.remember("wiki/concepts/redis.md", content)

    expect(await recall.find("RDB", ["wiki/concepts/redis.md"])).toEqual(["wiki/concepts/redis.md"])
    expect(await recall.find("AOF", ["wiki/concepts/redis.md"])).toEqual(["wiki/concepts/redis.md"])
    // 两次查询各生成一个向量；临时页面只生成一次，不随查询重复计算。
    expect(fetchEmbedding).toHaveBeenCalledTimes(3)
  })

  it("本批次页面向量不兼容或不相似时不进入候选", async () => {
    const recall = new IngestSemanticRecall("/project", config, vi.fn())
    recall.remember("wiki/concepts/redis.md", content)
    vi.mocked(fetchEmbedding).mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1])

    expect(await recall.find("缓存淘汰", ["wiki/concepts/redis.md"])).toEqual([])
  })

  it("向量库失败时仍补查本批次页面并明确记录降级", async () => {
    vi.mocked(vectorSearchChunks).mockRejectedValue(new Error("索引不可用"))
    const warn = vi.fn()
    const recall = new IngestSemanticRecall("/project", config, warn)
    recall.remember("wiki/concepts/redis.md", content)

    expect(await recall.find("RDB", ["wiki/concepts/redis.md"])).toEqual(["wiki/concepts/redis.md"])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("向量库检索降级"))
  })

  it("本批次向量生成失败不丢弃已经召回的库中候选", async () => {
    vi.mocked(vectorSearchChunks).mockResolvedValue([chunk("concepts/redis")])
    vi.mocked(fetchEmbedding).mockResolvedValueOnce([1, 0]).mockResolvedValueOnce(null)
    const warn = vi.fn()
    const recall = new IngestSemanticRecall("/project", config, warn)
    recall.remember("wiki/concepts/rdb.md", content)

    expect(await recall.find("RDB", ["wiki/concepts/redis.md", "wiki/concepts/rdb.md"]))
      .toEqual(["wiki/concepts/redis.md"])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("本批次页面语义检查降级"))
  })

  it("关闭 Embedding 时不调用向量服务；独立批次不共享临时页面", async () => {
    const disabled = new IngestSemanticRecall("/project", { ...config, enabled: false }, vi.fn())
    disabled.remember("wiki/concepts/redis.md", content)
    expect(await disabled.find("RDB", ["wiki/concepts/redis.md"])).toEqual([])
    expect(fetchEmbedding).not.toHaveBeenCalled()
    const other = new IngestSemanticRecall("/other", config, vi.fn())
    expect(await other.find("RDB", ["wiki/concepts/redis.md"])).toEqual([])
  })

  it("查询过程中取消必须中止，不能被吞成未发现重复或降级", async () => {
    const controller = new AbortController()
    vi.mocked(fetchEmbedding).mockImplementation(async () => { controller.abort(); return [1, 0] })
    const warn = vi.fn()
    const recall = new IngestSemanticRecall("/project", config, warn, controller.signal)

    await expect(recall.find("RDB", ["wiki/concepts/redis.md"])).rejects.toThrow("已取消")
    expect(warn).not.toHaveBeenCalled()
    expect(vectorSearchChunks).not.toHaveBeenCalled()
  })
})
