import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFile, writeFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { parseFrontmatter } from "@/lib/frontmatter"
import type { LlmConfig } from "@/stores/wiki-store"
import { createModuleTagWriter, refreshCachedModuleTags } from "./classification"

vi.mock("@/commands/fs", () => ({ readFile: vi.fn(), writeFile: vi.fn() }))
vi.mock("@/lib/llm-client", () => ({ streamChat: vi.fn() }))
const schema = '## Business Modules\n```json\n{"version":1,"modules":[{"id":"query","name":"查询","description":"查询知识"}]}\n```'
const config = { provider: "openai", model: "test" } as LlmConfig
const content = "---\ntitle: A\ntags: [SQL, module/old]\n---\n旧来源保留知识\n新增来源知识"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readFile).mockResolvedValue(schema)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken('{"moduleIds":["query"]}')
    callbacks.onDone()
  })
})

describe("最终写入前的模块分类", () => {
  it("分类完整最终正文，不把历史模块标签作为分类依据", async () => {
    const classify = await createModuleTagWriter("/p", config)
    const result = await classify(content)
    const [, messages] = vi.mocked(streamChat).mock.calls[0]
    expect(messages[0].content).toContain("description")
    expect(messages[1].content).toContain("旧来源保留知识")
    expect(messages[1].content).toContain("新增来源知识")
    expect(messages[1].content).not.toContain("module/old")
    expect(parseFrontmatter(result.content).frontmatter?.tags).toEqual(["SQL", "module/query"])
  })
  it("未配置模块字典的项目完全保留原内容，不增加模型调用", async () => {
    vi.mocked(readFile).mockResolvedValue("## Page Types\n| concept | wiki/concepts |")
    const classify = await createModuleTagWriter("/p", config)
    expect(await classify(content)).toEqual({ content, warnings: [] })
    expect(streamChat).not.toHaveBeenCalled()
  })
  it("无效字典进入未分类，并报告配置错误，不丢弃正文", async () => {
    vi.mocked(readFile).mockResolvedValue("## Business Modules\n```json\n{}\n```")
    const result = await (await createModuleTagWriter("/p", config))(content)
    expect(parseFrontmatter(result.content).frontmatter?.tags).toEqual(["SQL", "module/unclassified"])
    expect(result.content).toContain("旧来源保留知识")
    expect(result.warnings[0]).toContain("配置无效")
    expect(streamChat).not.toHaveBeenCalled()
  })
  it.each(["invalid json", '{"moduleIds":["invented"]}', '{"moduleIds":[]}'])(
    "不能归类时替换旧业务标签为未分类：%s", async (response) => {
      vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
        callbacks.onToken(response); callbacks.onDone()
      })
      const result = await (await createModuleTagWriter("/p", config))(content)
      expect(parseFrontmatter(result.content).frontmatter?.tags).toEqual(["SQL", "module/unclassified"])
      expect(result.content).toContain("新增来源知识")
    },
  )
  it("取消时不转为未分类，不继续保存页面", async () => {
    const controller = new AbortController()
    vi.mocked(streamChat).mockImplementation(async () => { controller.abort() })
    const classify = await createModuleTagWriter("/p", config, controller.signal)
    await expect(classify(content)).rejects.toThrow()
    expect(writeFile).not.toHaveBeenCalled()
  })
  it("网络失败时保留正文，进入未分类并提供告警", async () => {
    vi.mocked(streamChat).mockRejectedValue(new Error("network unavailable"))
    const result = await (await createModuleTagWriter("/p", config))(content)
    expect(parseFrontmatter(result.content).frontmatter?.tags).toEqual(["SQL", "module/unclassified"])
    expect(result.content).toContain("新增来源知识")
    expect(result.warnings[0]).toContain("network unavailable")
  })
  it("未启用字典的缓存命中不读取页面或调用模型", async () => {
    vi.mocked(readFile).mockResolvedValue("# Wiki Schema")
    expect(await refreshCachedModuleTags("/p", ["wiki/concepts/a.md"], config)).toEqual({ updated: 0, warnings: [] })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(streamChat).not.toHaveBeenCalled()
  })
  it("缓存命中也重新分类最终页面，跳过系统索引且只写入合法项目路径", async () => {
    vi.mocked(readFile).mockImplementation(async (path) => path.endsWith("schema.md") ? schema : content)
    const result = await refreshCachedModuleTags("/p", ["wiki/concepts/a.md", "wiki/index.md", "wiki/../outside.md"], config)
    expect(result.updated).toBe(1)
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeFile).mock.calls[0][0]).toBe("/p/wiki/concepts/a.md")
    expect(vi.mocked(writeFile).mock.calls[0][1]).not.toContain("module/old")
  })
})
