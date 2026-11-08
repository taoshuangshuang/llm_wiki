import { describe, it, expect, beforeEach, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

// Mock LLM + Tauri FS — the lint runner also touches the activity store
// (we leave that real so we can assert status transitions).
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { runSemanticLint, runStructuralLint, SemanticLintIncompleteError } from "./lint"
import { streamChat } from "./llm-client"
import { runWikiReview } from "./wiki-review"
import { readFile, listDirectory } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
vi.mock("./wiki-review", () => ({ runWikiReview: vi.fn() }))

import { useActivityStore } from "@/stores/activity-store"

const mockStreamChat = vi.mocked(streamChat)
const mockReadFile = vi.mocked(readFile)
const mockListDirectory = vi.mocked(listDirectory)

function fakeLlmConfig(): LlmConfig {
  return {
    provider: "openai",
    apiKey: "k",
    model: "m",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  }
}

function makeFileNode(name: string, content: string): { node: FileNode; content: string } {
  return {
    node: {
      name,
      path: `/project/wiki/${name}`,
      is_dir: false,
      children: [],
    } as FileNode,
    content,
  }
}

beforeEach(() => {
  mockStreamChat.mockReset()
  mockReadFile.mockReset()
  mockListDirectory.mockReset()
  useWikiStore.getState().setOutputLanguage("auto")
  useActivityStore.setState({ items: [] })
})

describe("runSemanticLint — 公共检查兼容入口", () => {
  it("公共检查中的格式和失效引用保留实际分类，内容冲突仍属于语义问题", async () => {
    const base = { title: "检查事项", description: "检查说明", options: [], resolved: false, createdAt: 0, affectedPages: ["wiki/a.md"] }
    const items = [
      { ...base, id: "format", type: "structure" as const },
      { ...base, id: "reference", type: "structure" as const, subtype: "失效引用" },
      { ...base, id: "conflict", type: "contradiction" as const },
    ]
    vi.mocked(runWikiReview).mockResolvedValue({ status: "complete", items, reasons: [] })
    const results = await runSemanticLint("/project", fakeLlmConfig())
    expect(results.map((result) => result.type)).toEqual(["structure", "broken-link", "semantic"])
    expect(results.map((result) => result.reviewItem)).toEqual(items)
  })

  it("委托公共检查并保留问题类型、证据及页面路径", async () => {
    const item = { id: "conflict", type: "contradiction" as const, title: "冲突", description: "双方说法不同", options: [], resolved: false, createdAt: 0, affectedPages: ["wiki/a.md", "wiki/b.md"] }
    vi.mocked(runWikiReview).mockResolvedValue({ status: "complete", items: [item], reasons: [] })
    expect(await runSemanticLint("/project", fakeLlmConfig())).toMatchObject([{ type: "semantic", severity: "warning", page: "a.md", affectedPages: ["a.md", "b.md"], reviewItem: item }])
    expect(vi.mocked(runWikiReview).mock.calls[0][0]).toBe("/project")
    expect(useActivityStore.getState().items[0].status).toBe("done")
  })

  it("未完成保留错误和已有结果，不返回空数组冒充正常", async () => {
    vi.mocked(runWikiReview).mockResolvedValue({ status: "incomplete", items: [], reasons: ["召回不可用"] })
    await expect(runSemanticLint("/project", fakeLlmConfig())).rejects.toBeInstanceOf(SemanticLintIncompleteError)
    expect(useActivityStore.getState().items[0]).toMatchObject({ status: "error", detail: "召回不可用" })
  })

  it("完成且没有问题时返回空数组", async () => {
    vi.mocked(runWikiReview).mockResolvedValue({ status: "complete", items: [], reasons: [] })
    expect(await runSemanticLint("/project", fakeLlmConfig())).toEqual([])
  })
})

describe("runStructuralLint — link suggestions", () => {
  it("stops before reading pages when cancellation is already requested", async () => {
    const pages = [makeFileNode("a.md", "# A")]
    mockListDirectory.mockResolvedValue(pages.map((entry) => entry.node))
    const controller = new AbortController()
    controller.abort()

    await expect(runStructuralLint("/project", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it("suggests the closest existing page for a broken wikilink", async () => {
    const pages = [
      makeFileNode("transformer.md", "---\ntitle: Transformer\n---\n# Transformer\nAttention model."),
      makeFileNode("attention.md", "# Attention\nSee [[transfomer]] for the architecture."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const broken = results.find((result) => result.type === "broken-link")

    expect(broken).toMatchObject({
      page: "attention.md",
      brokenTarget: "transfomer",
      suggestedTarget: "transformer.md",
    })
  })

  it("[[页面#锚点]] 按页面部分校验：目标存在不报失效，目标缺失只报页面部分", async () => {
    const pages = [
      makeFileNode("others/工单分析-2025.3统计与结论.md", "---\ntitle: 工单分析-2025.3 统计与结论\n---\n# 工单分析-2025.3 统计与结论\n## 主要发现\n内容。"),
      makeFileNode("others/202602-元数据工单月度汇总.md", "# 月度汇总\n见 [[工单分析-2025.3统计与结论#主要发现]] 与 [[工单分析-2025.3统计与结论#不存在的章节|别名]]，以及 [[不存在的页面#任意锚点]]。"),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => pages.find((p) => p.node.path === path)?.content ?? "")

    const results = await runStructuralLint("/project")
    const broken = results.filter((result) => result.type === "broken-link")

    expect(broken).toHaveLength(1)
    expect(broken[0]).toMatchObject({ page: "others/202602-元数据工单月度汇总.md", brokenTarget: "不存在的页面" })
    expect(broken[0].detail).toContain("[[不存在的页面]]")
    expect(broken[0].detail).not.toContain("任意锚点")
    expect(results.some((result) => result.type === "orphan" && result.page === "others/工单分析-2025.3统计与结论.md")).toBe(false)
  })

  it("suggests related pages for orphan and no-outlinks findings", async () => {
    const pages = [
      makeFileNode("rag.md", "# RAG\nRetrieval augmented generation uses vector search."),
      makeFileNode("vector-search.md", "# Vector Search\nVector search retrieval finds related chunks."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const noOutlinks = results.find((result) => result.type === "no-outlinks" && result.page === "rag.md")
    const orphan = results.find((result) => result.type === "orphan" && result.page === "rag.md")

    expect(noOutlinks?.suggestedTarget).toBe("vector-search.md")
    expect(orphan?.suggestedSource).toBe("vector-search.md")
  })

  it("does not attach self-referential suggestions when no related page exists", async () => {
    const pages = [
      makeFileNode("alpha.md", "# Alpha\nAardvark apricot."),
      makeFileNode("beta.md", "# Beta\nZeppelin zircon."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const orphan = results.find((result) => result.type === "orphan" && result.page === "alpha.md")

    expect(orphan?.suggestedSource).toBeUndefined()
    expect(orphan?.suggestedTarget).toBeUndefined()
  })

  it("does not suggest same-folder pages without shared terms", async () => {
    const pages = [
      makeFileNode("concepts/alpha.md", "# Alpha\nAardvark apricot."),
      makeFileNode("concepts/beta.md", "# Beta\nZeppelin zircon."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const orphan = results.find((result) => result.type === "orphan" && result.page === "concepts/alpha.md")

    expect(orphan?.suggestedSource).toBeUndefined()
  })

  it("does not suggest short unrelated typo targets", async () => {
    const pages = [
      makeFileNode("bat.md", "# Bat\nFlying mammal."),
      makeFileNode("note.md", "# Note\nSee [[cat]]."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const broken = results.find((result) => result.type === "broken-link" && result.brokenTarget === "cat")

    expect(broken?.suggestedTarget).toBeUndefined()
  })
})
