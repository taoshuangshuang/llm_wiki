/** 主题核对失败必须交付可审阅的原因，不能只留下通用错误标题。 */
import { beforeEach, expect, it, vi } from "vitest"
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
import { streamChat } from "./llm-client"
import { selectIngestPageTarget } from "./ingest-page-reuse"
import { useWikiStore } from "@/stores/wiki-store"

const candidates = [{ path: "wiki/concepts/a.md", content: "# 既有主题" }]
let output: string
beforeEach(() => {
  output = ""
  vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken(output)
    callbacks.onDone()
  })
})

it.each([
  ["非 JSON", "模型未按约定输出", "原始响应：\n模型未按约定输出"],
  ["空响应", "", "（空响应）"],
  ["缺少数组", '{"sameTopic":true}', "缺少 decisions 数组"],
  ["无效判断", '{"decisions":[{"path":"wiki/concepts/a.md","verdict":"yes"}]}', "无效判断：wiki/concepts/a.md = yes"],
  ["重复候选", '{"decisions":[{"path":"wiki/concepts/a.md","verdict":"same"},{"path":"wiki/concepts/a.md","verdict":"same"}]}', "重复候选：wiki/concepts/a.md"],
  ["未知候选", '{"decisions":[{"path":"wiki/concepts/unknown.md","verdict":"same"}]}', "未知候选：wiki/concepts/unknown.md"],
  ["遗漏候选", '{"decisions":[]}', "遗漏候选：wiki/concepts/a.md"],
  ["不确定主题", '{"decisions":[{"path":"wiki/concepts/a.md","verdict":"uncertain","reason":"新页讲持久化，旧页讲缓存，适用边界未明确"}]}', "新页讲持久化，旧页讲缓存，适用边界未明确"],
])("%s时保留具体诊断与候选路径", async (_mode, response, expected) => {
  output = response
  const error = await selectIngestPageTarget(
    { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }, "# 新主题", candidates, "核对主题",
  ).catch((failure: Error & { details?: string }) => failure)
  expect(error).toBeInstanceOf(Error)
  expect(error).toHaveProperty("details", expect.stringContaining(expected))
  expect(error).toHaveProperty("details", expect.stringContaining(candidates[0].path))
})

it("旧模板多个同主题目标缺少优选时正常选择独立建页", async () => {
  const pages = [...candidates, { path: "wiki/concepts/b.md", content: "# 另一候选" }]
  output = JSON.stringify({ decisions: pages.map(({ path }) => ({ path, verdict: "same", reason: "主题与主要用途一致" })) })
  await expect(selectIngestPageTarget(
    { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }, "# 新主题", pages, "核对主题",
  )).rejects.toMatchObject({ details: expect.stringContaining("wiki/concepts/b.md：same") })
})


it("多个同主题候选由模型选择主要用途最匹配的一页", async () => {
  const pages = [...candidates, { path: "wiki/concepts/b.md", content: "# 缓存清理步骤" }]
  output = JSON.stringify({ selectedPath: pages[1].path, reason: "主要用途都是操作步骤", decisions: pages.map(({ path }) => ({ path, verdict: "same", reason: "同一主题" })) })
  await expect(selectIngestPageTarget({ ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }, "# 缓存清理补充", pages, "核对主题")).resolves.toBe(pages[1].path)
})

it("选中的目标不能越过逐一同主题判断", async () => {
  output = JSON.stringify({ selectedPath: candidates[0].path, decisions: [{ path: candidates[0].path, verdict: "different" }] })
  await expect(selectIngestPageTarget(useWikiStore.getState().llmConfig, "不同用途", candidates, "核对主题")).rejects.toThrow("未通过同主题判断")
})
