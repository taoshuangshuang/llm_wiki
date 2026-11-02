/** 从真实入库、缓存命中和会话写入验证：配图附到知识页，历史摘要不被改写。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./extract-source-images", async (importOriginal) => ({
  ...await importOriginal<typeof import("./extract-source-images")>(),
  extractAndSaveSourceImages: vi.fn(),
}))
vi.mock("./image-caption-pipeline", async (importOriginal) => ({
  ...await importOriginal<typeof import("./image-caption-pipeline")>(),
  captionMarkdownImages: vi.fn(async (_path, content: string) => content),
  loadCaptionCache: vi.fn(async () => new Map([["image-hash", "架构示意图"]])),
}))
vi.mock("./ingest-acceptance", () => ({
  runIngestAcceptance: vi.fn(async () => ({ report: { status: "clear", rounds: [] }, reviews: [] })),
}))

import { autoIngest, executeIngestWrites, startIngest } from "./ingest"
import { streamChat } from "./llm-client"
import { extractAndSaveSourceImages } from "./extract-source-images"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"

let project: Awaited<ReturnType<typeof createTempProject>>
let generationCalls = 0
const legacy = "---\ntype: source\nsources: [source.md]\n---\n# 已有导读\n保留人工整理的内容。"
const pagePath = "wiki/concepts/architecture.md"

beforeEach(async () => {
  vi.clearAllMocks()
  generationCalls = 0
  project = await createTempProject("ingest-images-without-summary")
  await writeFileRaw(`${project.path}/raw/sources/source.md`, "Architecture and component relationships.")
  await writeFileRaw(`${project.path}/wiki/sources/source.md`, legacy)
  useWikiStore.setState({
    project: { id: "images", name: "images", path: project.path }, outputLanguage: "English",
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: true, useMainLlm: true },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false },
  })
  vi.mocked(extractAndSaveSourceImages).mockResolvedValue([{
    index: 1, page: 2, mimeType: "image/png", width: 10, height: 10, sha256: "image-hash",
    relPath: "media/source/diagram.png", absPath: `${project.path}/wiki/media/source/diagram.png`,
  }])
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    const generation = system.includes("generate wiki files") || system.includes("wiki generation assistant")
    if (generation) generationCalls++
    callbacks.onToken(generation
      ? `---FILE: ${pagePath}---\n---\ntype: concept\ntitle: Architecture\nsources: [source.md]\n---\n# Architecture\nComponents and relationships.\n---END FILE---\n---FILE: wiki/sources/source.md---\n---\ntype: source\n---\nObsolete summary output.\n---END FILE---`
      : "Architecture analysis.")
    callbacks.onDone()
  })
})

afterEach(async () => { await project.cleanup() })

describe("移除来源摘要后的配图契约", () => {
  it("交互来源分析与会话生成也隔离旧库目录和概览", async () => {
    await writeFileRaw(`${project.path}/wiki/index.md`, "INTERACTIVE_OLD_INDEX_ONLY")
    await writeFileRaw(`${project.path}/wiki/overview.md`, "INTERACTIVE_OLD_OVERVIEW_ONLY")
    useChatStore.setState({ activeConversationId: null, conversations: [], messages: [], ingestSource: null })
    const config = { ...useWikiStore.getState().llmConfig, model: "test", apiKey: "test", maxContextSize: 128000 }
    await startIngest(project.path, `${project.path}/raw/sources/source.md`, config)
    await executeIngestWrites(project.path, config)
    for (const [, messages] of vi.mocked(streamChat).mock.calls) {
      const material = JSON.stringify(messages)
      expect(material).not.toContain("INTERACTIVE_OLD_INDEX_ONLY")
      expect(material).not.toContain("INTERACTIVE_OLD_OVERVIEW_ONLY")
    }
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("Components and relationships")
  })

  it("自动入库、缓存补图和会话写入均保留知识页配图及历史摘要", async () => {
    const config = { ...useWikiStore.getState().llmConfig, model: "test", apiKey: "test", maxContextSize: 128000 }
    const source = `${project.path}/raw/sources/source.md`
    await autoIngest(project.path, source, config)
    const first = await readFileRaw(`${project.path}/${pagePath}`)
    expect(first).toContain("../media/source/diagram.png")
    expect(first).toContain("架构示意图")
    expect(await readFileRaw(`${project.path}/wiki/sources/source.md`)).toBe(legacy)

    // 相同来源再次入库走成功缓存，补图不得重复追加，也不再生成页面。
    await autoIngest(project.path, source, config)
    expect(generationCalls).toBe(1)
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toBe(first)

    useChatStore.setState({ activeConversationId: "images", conversations: [], messages: [], ingestSource: source })
    await executeIngestWrites(project.path, config)
    const interactive = await readFileRaw(`${project.path}/${pagePath}`)
    expect(interactive).toContain("../media/source/diagram.png")
    expect(interactive).toContain('sources: ["source.md"]')
    expect(await readFileRaw(`${project.path}/wiki/sources/source.md`)).toBe(legacy)
  })
})
