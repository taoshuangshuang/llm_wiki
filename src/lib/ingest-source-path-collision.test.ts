import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { listIngestDocuments, updateIngestDocument } from "./ingest-document"
import { listIngestRuns, updateIngestRun } from "./ingest-run"
import { parseFrontmatter } from "./frontmatter"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import { migrateSourcePath } from "./source-lifecycle"

vi.mock("@/commands/fs", () => realFs)
// 本组验证生成和写入协议；统一审阅入口及串行交接由专门场景集成测试覆盖。
vi.mock("./ingest-review", () => ({ runIngestReview: vi.fn(async (path: string, runId: string) => { await updateIngestRun(path, runId, (run) => { run.reviewRequested = false; run.reviewStatus = "complete" }) }) }))
// 本组聚焦来源路径与断点恢复；最终验收另有完整输入输出集成测试。
vi.mock("./ingest-acceptance", () => ({
  runIngestAcceptance: vi.fn(async () => ({ report: { status: "passed", rounds: [] }, reviews: [] })),
}))

let sourceMarkers: string[] = []
let failLongChunksOnce = new Set<number>()
let truncateLongChunksOnce = new Set<number>()
let truncateLongAboveChars = 0
let extraReviewResponse = ""
let generationSuffix = ""
let truncatedRepairResponse = ""
let abortDuringReview: AbortController | null = null
let interactiveGenerationOverride = ""
let mergeRequestCount = 0
let truncateGenerationOnce = false
let truncateAnalysisOnce = false
let emptyGenerationOnce = false
let confirmResumeCompleteOnce = false
let truncatedMergeResponse = ""

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")
    const userPrompt = String(messages?.[1]?.content ?? "")

    if (systemPrompt.startsWith("核对新知识页和候选页")) {
      const input = JSON.parse(userPrompt)
      cb.onToken(JSON.stringify({ decisions: input.candidates.map((page: { path: string; content: string }) => ({ path: page.path, verdict: parseFrontmatter(page.content).frontmatter?.title === parseFrontmatter(input.incoming).frontmatter?.title ? "same" : "different" })) }))
      cb.onDone()
      return
    }
    if (systemPrompt.startsWith("You are merging ")) {
      mergeRequestCount++
      if (truncatedMergeResponse) {
        cb.onToken(truncatedMergeResponse)
        cb.onDone({ finishReason: "length", truncated: true })
        return
      }
      const incoming = userPrompt.split("## Newly generated version")[1]?.split("---")[2]
      cb.onToken(incoming?.trim() || "---\ntitle: merged\n---\n\n# merged")
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a wiki generation assistant")) {
      if (interactiveGenerationOverride) {
        cb.onToken(interactiveGenerationOverride)
        cb.onDone()
        return
      }
      cb.onToken([
        "---FILE: wiki/concepts/config.md---",
        "---",
        'type: "concept"',
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Source: config.yaml",
        "",
        "Configuration source generated from the chat handoff.",
        "---END FILE---",
      ].join("\n"))
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are analyzing a long source document")) {
      const chunkInput = JSON.parse(userPrompt)
      const chunkIndex = String(chunkInput.chunk.index)
      const numericChunkIndex = Number(chunkIndex)
      if (failLongChunksOnce.has(numericChunkIndex)) {
        failLongChunksOnce.delete(numericChunkIndex)
        cb.onError(new Error(`chunk ${chunkIndex} failed once`))
        return
      }
      const main = chunkInput.chunk.main
      if (truncateLongChunksOnce.delete(numericChunkIndex) || truncateLongAboveChars > 0 && main.length > truncateLongAboveChars) {
        cb.onToken("INCOMPLETE_CHUNK_ANALYSIS")
        cb.onDone({ finishReason: "length", truncated: true })
        return
      }
      cb.onToken([
        "## Chunk Analysis",
        `Chunk ${chunkIndex} introduced topic ${chunkIndex}.`,
        "",
        "## Updated Global Digest",
        `Digest after chunk ${chunkIndex}: stable context ${chunkIndex}.`,
      ].join("\n"))
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are identifying high-value follow-up research items")) {
      if (abortDuringReview) {
        abortDuringReview.abort()
        throw new Error("AbortError")
      }
      cb.onToken(extraReviewResponse)
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are repairing truncated wiki FILE blocks")) {
      cb.onToken(truncatedRepairResponse)
      cb.onDone()
      return
    }

    if (!systemPrompt.includes("generate wiki files")) {
      cb.onToken("## Analysis\nConfiguration source.")
      if (truncateAnalysisOnce) {
        truncateAnalysisOnce = false
        cb.onDone({ finishReason: "length", truncated: true })
      } else cb.onDone()
      return
    }

    if (emptyGenerationOnce) {
      emptyGenerationOnce = false
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }
    if (confirmResumeCompleteOnce) {
      confirmResumeCompleteOnce = false
      cb.onToken("---RESUME COMPLETE---")
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }

    const marker = (sourceMarkers.length > 1 ? sourceMarkers.shift() : sourceMarkers[0]) ?? "unknown project"
    const sourceIdentity =
      systemPrompt.match(/original source file is:\s*\*\*([^*]+)\*\*/i)?.[1] ?? "config.yaml"
    const targetPath = `wiki/concepts/${sourceSummarySlugFromIdentity(sourceIdentity)}.md`
    cb.onToken([
      `---FILE: ${targetPath}---`,
      "---",
      "type: concept",
      `title: "Configuration"`,
      `sources: ["${sourceIdentity}"]`,
      "---",
      "",
      `# ${marker}`,
      "",
      `Configuration details for ${marker}.`,
      "---END FILE---",
      generationSuffix,
    ].join("\n"))
    if (truncateGenerationOnce) {
      truncateGenerationOnce = false
      cb.onDone({ finishReason: "length", truncated: true })
    } else {
      cb.onDone({ finishReason: "stop", truncated: false })
    }
  }),
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import {
  autoIngest,
  executeIngestWrites,
  hasMineruImageRefs,
} from "./ingest"
import { streamChat } from "./llm-client"
import { parseWithMineruResult } from "./mineru"

const mockStreamChat = vi.mocked(streamChat)
const mockParseWithMineru = vi.mocked(parseWithMineruResult)

describe("autoIngest 来源身份、知识页与断点恢复", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    sourceMarkers = []
    failLongChunksOnce = new Set()
    truncateLongChunksOnce = new Set()
    truncateLongAboveChars = 0
    extraReviewResponse = ""
    generationSuffix = ""
    truncatedRepairResponse = ""
    abortDuringReview = null
    interactiveGenerationOverride = ""
    mergeRequestCount = 0
    truncateGenerationOnce = false
    truncateAnalysisOnce = false
    emptyGenerationOnce = false
    confirmResumeCompleteOnce = false
    truncatedMergeResponse = ""
    mockStreamChat.mockClear()
    mockParseWithMineru.mockReset()
    tmp = await createTempProject("same-basename-sources")

    await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nTrack project config files.\n")
    await writeFileRaw(
      `${tmp.path}/schema.md`,
      "# Schema\n\nKnowledge pages cite original source identities.\n\n## Page Types\n| concept | wiki/concepts/ | Knowledge |\n| goal | wiki/goals/ | Outcomes |\n| habit | wiki/habits/ | Behaviours |",
    )
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.yaml`, "name: alpha\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-b/config.yaml`, "name: beta\n")

    useReviewStore.setState({ items: [] })
    useActivityStore.setState({ items: [] })
    useChatStore.setState({
      conversations: [],
      messages: [],
      activeConversationId: null,
      mode: "chat",
      ingestSource: null,
      isStreaming: false,
      streamingContent: "",
    })
    useWikiStore.setState({
      project: {
        id: "same-basename-sources",
        name: "same-basename-sources",
        path: tmp.path,
      },
      fileTree: [],
      outputLanguage: "auto",
      multimodalConfig: {
        enabled: false,
        useMainLlm: true,
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "",
        customEndpoint: "",
        concurrency: 1,
      },
      embeddingConfig: {
        enabled: false,
        endpoint: "",
        apiKey: "",
        model: "",
      },
      mineruConfig: {
        enabled: false,
        backend: "cloud",
        token: "",
        modelVersion: "vlm",
      },
    })
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("detects MinerU image refs with URL-encoded source summary slugs", () => {
    expect(hasMineruImageRefs(
      "![chart](media/%E6%B1%A1%E6%B0%B4%20paper/mineru/images/chart%281%29.png)",
      "污水 paper",
    )).toBe(true)
    expect(hasMineruImageRefs(
      "![chart](media/污水 paper/mineru/images/chart.png)",
      "污水 paper",
    )).toBe(true)
    expect(hasMineruImageRefs(
      "![chart](media/other/mineru/images/chart.png)",
      "污水 paper",
    )).toBe(false)
  })

  it("忽略模型输出的摘要，保留历史摘要且不补建新摘要", async () => {
    if (!tmp) throw new Error("missing temp project")
    const legacyPath = `${tmp.path}/wiki/sources/config.md`
    const legacy = "---\ntype: source\nsources: [project-a/config.yaml]\n---\n# 历史导读\n人工整理内容。"
    await writeFileRaw(legacyPath, legacy)
    generationSuffix = [
      "---FILE: wiki/sources/config.md---\n---\ntype: source\n---\n模型改写旧摘要\n---END FILE---",
      "---FILE: wiki/concepts/hidden-summary.md---\n---\ntype: source\n---\n换目录的摘要\n---END FILE---",
      "---FILE: wiki/sources/new-summary.md---\n---\ntype: concept\n---\n换类型的摘要\n---END FILE---",
      "---FILE: wiki/Sources/config.md---\n---\ntype: concept\n---\n大小写变体摘要\n---END FILE---",
    ].join("\n")
    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, useWikiStore.getState().llmConfig)
    expect(await fs.readFile(legacyPath, "utf8")).toBe(legacy)
    expect(written.some((path) => path.startsWith("wiki/concepts/"))).toBe(true)
    expect(written.some((path) => path.startsWith("wiki/sources/"))).toBe(false)
    expect(await fs.readdir(`${tmp.path}/wiki/sources`)).toEqual(["config.md"])
    expect(written.some((path) => path.toLowerCase().startsWith("wiki/sources/"))).toBe(false)
    await expect(fs.access(`${tmp.path}/wiki/concepts/hidden-summary.md`)).rejects.toThrow()
  })

  it("keeps original source references on distinct knowledge pages for same-basename files in different source subdirectories", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config", "project-b config"]

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )
    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-b/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-b",
    )

    const sourcesDir = path.join(tmp.path, "wiki", "concepts")
    const knowledgeFiles = (await fs.readdir(sourcesDir))
      .filter((name) => name.endsWith(".md"))
      .sort()
    const knowledgeContents = await Promise.all(
      knowledgeFiles.map((name) => fs.readFile(path.join(sourcesDir, name), "utf8")),
    )
    const allKnowledge = knowledgeContents.join("\n\n--- page boundary ---\n\n")

    expect(knowledgeFiles).toHaveLength(2)
    expect(allKnowledge).toContain("project-a/config.yaml")
    expect(allKnowledge).toContain("project-b/config.yaml")
  })

  it("replaces stale content when a corrected source solely owns the page", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    sourceMarkers = ["obsolete wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    await writeFileRaw(sourcePath, "name: corrected\n")
    sourceMarkers = ["corrected wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    const pagePath = `${tmp.path}/wiki/concepts/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const content = await fs.readFile(pagePath, "utf8")
    expect(content).toContain("corrected wording")
    expect(content).not.toContain("obsolete wording")
    expect(mergeRequestCount).toBe(0)
  })

  it("多来源页面合并遵守入库思考设置，不接受达到输出上限的半截合并正文", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    const sharedPath = `${tmp.path}/wiki/concepts/shared.md`
    const original = '---\ntitle: Shared\ntype: concept\nsources: [other.md]\n---\n# Shared\nOld evidence.'
    await writeFileRaw(sharedPath, original)
    generationSuffix = '\n---FILE: wiki/concepts/shared.md---\n---\ntitle: Shared\ntype: concept\nsources: [project-a/config.yaml]\n---\n# Shared\nNew evidence.\n---END FILE---'
    // 半截响应长度充足，不能仅靠正文长度保护识别；必须遵守模型的截断标记。
    truncatedMergeResponse = '---\ntitle: Shared\ntype: concept\n---\n# Shared\nINCOMPLETE_MERGE '.repeat(5)
    await autoIngest(tmp.path, sourcePath, {
      ...useWikiStore.getState().llmConfig, maxContextSize: 1_000_000,
      reasoning: { mode: "max" }, ingestReasoning: { mode: "off" },
    })
    const call = mockStreamChat.mock.calls.find(([, messages]) => String(messages[0].content).startsWith("You are merging "))
    expect(call?.[4]).toMatchObject({ reasoning: { mode: "off" }, max_tokens: 32_768 })
    const saved = await fs.readFile(sharedPath, "utf8")
    // 截断合并稿被拒绝；完整新稿按约定写入，旧证据保存在可靠快照。
    expect(saved).toContain("New evidence.")
    expect(saved).not.toContain("INCOMPLETE_MERGE")
    expect((await listIngestRuns(tmp.path))[0].pages["wiki/concepts/shared.md"].before).toBe(original)
  })

  it("moves the canonical source summary and its source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    const oldIdentity = "project-a/config.yaml"
    const newIdentity = "archive/config.yaml"
    const oldSummary = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity(oldIdentity)}.md`
    const newSummary = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity(newIdentity)}.md`
    await writeFileRaw(oldSummary, '---\ntype: source\nsources: ["project-a/config.yaml"]\n---\n# Historical summary\nExisting notes.')
    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    await expect(fs.access(oldSummary)).rejects.toThrow()
    const content = await fs.readFile(newSummary, "utf8")
    expect(content).toContain('sources: ["archive/config.yaml"]')
  })

  it("migrates source references for a case-only rename", async () => {
    if (!tmp) throw new Error("missing temp project")
    const pagePath = `${tmp.path}/wiki/entities/case.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["project-a/config.yaml"]',
      "---",
      "# Case",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/Project-A/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["Project-A/config.yaml"]',
    )
  })

  it("migrates a unique legacy basename source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    // Remove the second same-basename source so the legacy shorthand is
    // unambiguous after the move.
    await fs.rm(`${tmp.path}/raw/sources/project-b/config.yaml`)
    const pagePath = `${tmp.path}/wiki/entities/legacy.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["config.yaml"]',
      "---",
      "# Legacy",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["archive/config.yaml"]',
    )
  })

  it("does not rewrite an ambiguous legacy basename source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    const pagePath = `${tmp.path}/wiki/entities/ambiguous.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["config.yaml"]',
      "---",
      "# Ambiguous",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["config.yaml"]',
    )
  })

  it("重新入库保留唯一旧摘要，不再迁移到新路径", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    await fs.rm(path.join(tmp.path, "raw", "sources", "project-b", "config.yaml"))

    const legacySummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    await writeFileRaw(
      legacySummaryPath,
      [
        "---",
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "---",
        "",
        "# Legacy config",
        "",
        "Legacy source summary body.",
      ].join("\n"),
    )

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    const canonicalSummary = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary)
    await expect(fs.access(canonicalSummaryPath)).rejects.toThrow()
    expect(await fs.readFile(legacySummaryPath, "utf8")).toContain("Legacy source summary body.")
    expect(await fs.readFile(legacySummaryPath, "utf8")).toContain('sources: ["config.yaml"]')
  })

  it("does not migrate a legacy basename source summary when the basename is ambiguous", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]

    const legacySummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    const legacyContent = [
      "---",
      'title: "Source: config.yaml"',
      'sources: ["config.yaml"]',
      "---",
      "",
      "# Legacy config",
      "",
      "Ambiguous legacy source summary body.",
    ].join("\n")
    await writeFileRaw(legacySummaryPath, legacyContent)

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    const canonicalSummary = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary)

    expect(await fs.readFile(legacySummaryPath, "utf8")).toBe(legacyContent)
    await expect(fs.access(canonicalSummaryPath)).rejects.toThrow()
  })

  it("analyzes oversized sources in chunks before final wiki generation", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["long source"]
    const longSourcePath = `${tmp.path}/raw/sources/project-a/long-report.md`
    await writeFileRaw(
      longSourcePath,
      [
        "# Chapter One",
        "",
        "A".repeat(9000),
        "",
        "## Chapter Two",
        "",
        "B".repeat(9000),
        "",
        "## Chapter Three",
        "",
        "C".repeat(9000),
      ].join("\n"),
    )

    await autoIngest(
      tmp.path,
      longSourcePath,
      { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 },
      undefined,
      "project-a",
    )

    const chunkCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith("You are analyzing a long source document"),
    )
    expect(chunkCalls.length).toBeGreaterThan(1)
    const chunkSystemPrompt = String(chunkCalls[0][1]?.[0]?.content ?? "")
    expect(chunkSystemPrompt).toContain("wiki/goals/")
    expect(chunkSystemPrompt).toContain("Schema-Typed Candidates")
    expect(chunkSystemPrompt).toContain("never invent goals")
    expect(JSON.parse(String(chunkCalls[0][1]?.[1]?.content)).chunk.main).not.toBe("")
    expect(String(chunkCalls[1][1]?.[1]?.content ?? "")).toContain(
      "Digest after chunk 1: stable context 1.",
    )
    expect(String(chunkCalls[1][1]?.[1]?.content ?? "")).not.toContain(
      "introduced topic 1",
    )

    const generationCall = mockStreamChat.mock.calls.find(([, messages]) =>
      String(messages?.[0]?.content ?? "").includes("Based on the analysis provided, generate wiki files"),
    )
    expect(generationCall).toBeTruthy()
    const generationCalls = mockStreamChat.mock.calls.filter(([, messages]) => String(messages[0].content).includes("generate wiki files"))
    expect(generationCalls).toHaveLength(chunkCalls.length)
    for (const [index, call] of generationCalls.entries()) {
      const input = JSON.parse(JSON.parse(String(call[1][1].content)).source)
      expect(input.chunk_index).toBe(index + 1)
      expect(input.chunk_total).toBe(chunkCalls.length)
      expect(input.main).toBe(JSON.parse(String(chunkCalls[index][1][1].content)).chunk.main)
      if (index > 0) expect(input.auxiliary_context.global_digest).toContain(`Digest after chunk ${index}: stable context ${index}.`)
    }
  })

  it("来源能放入上下文但分析输出截断时，自动分块恢复而不直接终止入库", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["recovered analysis"]
    truncateAnalysisOnce = true
    const sourcePath = `${tmp.path}/raw/sources/project-a/dense-report.md`
    await writeFileRaw(sourcePath, [
      "# 第一节", "甲".repeat(4500), "## 第二节", "乙".repeat(4500), "## 第三节", "丙".repeat(4500), "尾部关键映射 TAIL_EVIDENCE",
    ].join("\n\n"))
    await autoIngest(tmp.path, sourcePath, { ...useWikiStore.getState().llmConfig, maxContextSize: 1_000_000, ingestReasoning: { mode: "max" } }, undefined, "project-a")
    const chunkCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith("You are analyzing a long source document"),
    )
    expect(chunkCalls.length).toBeGreaterThan(1)
    expect(chunkCalls.map(([, messages]) => String(messages?.[1]?.content)).join("\n")).toContain("TAIL_EVIDENCE")
    const generationCalls = mockStreamChat.mock.calls.filter(([, messages]) => String(messages[0].content).includes("generate wiki files"))
    const generatedSubjects = generationCalls.map((call) => JSON.parse(JSON.parse(String(call[1][1].content)).source).main).join("\n")
    expect(generatedSubjects).toContain("丙".repeat(4500))
    expect(generatedSubjects).toContain("TAIL_EVIDENCE")
    const summary = `wiki/concepts/${sourceSummarySlugFromIdentity("project-a/dense-report.md")}.md`
    expect(await fs.readFile(path.join(tmp.path, summary), "utf8")).toContain("recovered analysis")
  })

  it("分块输出截断时只细分当前片段，完整分析成功后才生成页面", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["subdivided source"]
    truncateLongChunksOnce = new Set([1])
    const sourcePath = `${tmp.path}/raw/sources/project-a/subdivide-report.md`
    await writeFileRaw(sourcePath, `# First\n${"甲".repeat(9000)}\n\n## Last\n${"乙".repeat(9000)}\nTAIL_EVIDENCE`)
    await autoIngest(tmp.path, sourcePath, { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 }, undefined, "project-a")
    const chunkCalls = mockStreamChat.mock.calls.filter(([, messages]) => String(messages[0].content).startsWith("You are analyzing a long source document"))
    expect(chunkCalls.length).toBeGreaterThan(2)
    const generationCall = mockStreamChat.mock.calls.find(([, messages]) => String(messages[0].content).includes("generate wiki files"))
    expect(generationCall).toBeTruthy()
    expect(String(generationCall?.[1]?.[1]?.content)).not.toContain("INCOMPLETE_CHUNK_ANALYSIS")
    const summary = `wiki/concepts/${sourceSummarySlugFromIdentity("project-a/subdivide-report.md")}.md`
    expect(await fs.readFile(path.join(tmp.path, summary), "utf8")).toContain("subdivided source")
  })

  it("目录点线导致分析截断时，无损细分后仍能完成页面生成", async () => {
    if (!tmp) throw new Error("missing temp project")
    // 整篇分析和首个分块均触发截断；恢复后的子块应能通过长度阈值。
    sourceMarkers = ["directory recovery"]
    truncateAnalysisOnce = true
    truncateLongAboveChars = 2000
    const sourcePath = `${tmp.path}/raw/sources/project-a/directory-report.md`
    const content = [`查询方案${".".repeat(2100)}45`, `接口定义${".".repeat(2100)}46`].join("\n\n")
    await writeFileRaw(sourcePath, content)

    await autoIngest(tmp.path, sourcePath, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 }, undefined, "project-a")

    // 每个完整子块都必须参与分析，截断响应不得进入页面生成上下文。
    const chunkCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages[0].content).startsWith("You are analyzing a long source document"),
    )
    expect(chunkCalls.length).toBeGreaterThan(2)
    const generationCall = mockStreamChat.mock.calls.find(([, messages]) => String(messages[0].content).includes("generate wiki files"))
    expect(generationCall).toBeTruthy()
    expect(String(generationCall?.[1]?.[1]?.content)).not.toContain("INCOMPLETE_CHUNK_ANALYSIS")
    const summary = `wiki/concepts/${sourceSummarySlugFromIdentity("project-a/directory-report.md")}.md`
    expect(await fs.readFile(path.join(tmp.path, summary), "utf8")).toContain("directory recovery")
  })

  it.each([
    { reasoning: { mode: "off" as const }, expectedMaxTokens: 32_768 },
    { reasoning: { mode: "max" as const }, expectedMaxTokens: 32_768 },
    { reasoning: { mode: "custom" as const, budgetTokens: 32_768 }, expectedMaxTokens: 32_768 },
  ])("大上下文的整篇分析与分块恢复使用扩大的输出预算（$reasoning.mode）", async ({ reasoning, expectedMaxTokens }) => {
    if (!tmp) throw new Error("missing temp project")
    // 从公开入库入口触发整篇截断及分块恢复，验证预算实际传给两类 LLM 请求。
    // 自定义思考预算仍限制在 8K，避免提高正文上限时连带放大思考开销。
    sourceMarkers = ["expanded analysis budget"]
    truncateAnalysisOnce = true
    const sourcePath = `${tmp.path}/raw/sources/project-a/output-budget-report.md`
    await writeFileRaw(sourcePath, `# One\n${"甲".repeat(4500)}\n\n## Two\n${"乙".repeat(4500)}\n\n## Three\n${"丙".repeat(4500)}`)

    await autoIngest(tmp.path, sourcePath, {
      ...useWikiStore.getState().llmConfig,
      maxContextSize: 1_000_000,
      ingestReasoning: reasoning,
    }, undefined, "project-a")

    const chunkCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages[0].content).startsWith("You are analyzing a long source document"),
    )
    expect(chunkCalls.length).toBeGreaterThan(1)
    for (const call of [mockStreamChat.mock.calls[0], ...chunkCalls]) {
      expect(call[4]?.max_tokens).toBe(expectedMaxTokens)
    }
    const summary = `wiki/concepts/${sourceSummarySlugFromIdentity("project-a/output-budget-report.md")}.md`
    expect(await fs.readFile(path.join(tmp.path, summary), "utf8")).toContain("expanded analysis budget")
  })

  it("持续截断时限制细分次数，不使用不完整分析生成或缓存页面", async () => {
    if (!tmp) throw new Error("missing temp project")
    truncateAnalysisOnce = true
    truncateLongAboveChars = 1
    const sourcePath = `${tmp.path}/raw/sources/project-a/always-truncated.md`
    await writeFileRaw(sourcePath, `# Dense\n${"甲".repeat(13000)}`)
    const result = await autoIngest(tmp.path, sourcePath, { ...useWikiStore.getState().llmConfig, maxContextSize: 1_000_000, ingestReasoning: { mode: "max" } }, undefined, "project-a").catch((error) => error)
    expect(result).toMatchObject({ nonRetryable: true })
    expect(result.message).toContain("自动细分后仍达到 32,768 token")
    expect(mockStreamChat.mock.calls.length).toBeLessThanOrEqual(7)
    expect(mockStreamChat.mock.calls.some(([, messages]) => String(messages[0].content).includes("generate wiki files"))).toBe(false)
    await expect(fs.access(`${tmp.path}/.llm-wiki/ingest-cache.json`)).rejects.toThrow()
  })

  it("输出截断后的分块断点可以直接恢复，不重复已完成片段和整篇分析", async () => {
    if (!tmp) throw new Error("missing temp project")
    truncateAnalysisOnce = true
    failLongChunksOnce = new Set([2])
    sourceMarkers = ["resumed recovery"]
    const sourcePath = `${tmp.path}/raw/sources/project-a/recovery-resume.md`
    await writeFileRaw(sourcePath, `# One\n${"甲".repeat(4500)}\n\n## Two\n${"乙".repeat(4500)}\n\n## Three\n${"丙".repeat(4500)}`)
    const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 1_000_000 }
    await expect(autoIngest(tmp.path, sourcePath, config, undefined, "project-a")).rejects.toThrow("Chunk analysis stream failed")
    mockStreamChat.mockClear()
    await autoIngest(tmp.path, sourcePath, config, undefined, "project-a")
    expect(String(mockStreamChat.mock.calls[0]?.[1]?.[0]?.content)).toContain("You are analyzing a long source document")
    expect(JSON.parse(String(mockStreamChat.mock.calls[0]?.[1]?.[1]?.content)).chunk.index).toBe(2)
    expect((await listIngestDocuments(tmp.path))[0].chunks.every((chunk) => chunk.analysis)).toBe(true)
  })

  it("旧整文分析断点不能转换成新子块任务或进入生成上下文", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/legacy-checkpoint.md`
    await writeFileRaw(sourcePath, `# One\n${"甲".repeat(4500)}\n\n## Two\n${"乙".repeat(4500)}\n\n## Three\n${"丙".repeat(4500)}`)
    await writeFileRaw(`${tmp.path}/.llm-wiki/ingest-progress/legacy.json`, JSON.stringify({ version: 1, completedThrough: 1, analyses: ["LEGACY_INCOMPLETE_ANALYSIS"] }))
    await autoIngest(tmp.path, sourcePath, { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 }, undefined, "project-a")
    const first = mockStreamChat.mock.calls.find(([, messages]) => String(messages[0].content).startsWith("You are analyzing a long source document"))!
    expect(JSON.parse(String(first[1][1].content)).chunk.index).toBe(1)
    for (const call of mockStreamChat.mock.calls.filter(([, messages]) => String(messages[0].content).includes("generate wiki files"))) expect(String(call[1][1].content)).not.toContain("LEGACY_INCOMPLETE_ANALYSIS")
  })

  it("resumes oversized source analysis from the persisted chunk checkpoint", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["long source"]
    failLongChunksOnce = new Set([2])
    const longSourcePath = `${tmp.path}/raw/sources/project-a/resume-report.md`
    const llmConfig = { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 }
    await writeFileRaw(
      longSourcePath,
      [
        "# Chapter One",
        "",
        "A".repeat(9000),
        "",
        "## Chapter Two",
        "",
        "B".repeat(9000),
        "",
        "## Chapter Three",
        "",
        "C".repeat(9000),
      ].join("\n"),
    )

    await expect(
      autoIngest(tmp.path, longSourcePath, llmConfig, undefined, "project-a"),
    ).rejects.toThrow("Chunk analysis stream failed")

    const [beforeResume] = await listIngestDocuments(tmp.path)
    expect(beforeResume.chunks[0].analysis).toContain("introduced topic 1")
    expect((await listIngestRuns(tmp.path)).find((run) => run.chunk?.index === 1)?.writeStatus).toBe("complete")

    mockStreamChat.mockClear()
    await autoIngest(tmp.path, longSourcePath, llmConfig, undefined, "project-a")

    const resumedChunkCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith("You are analyzing a long source document"),
    )
    expect(resumedChunkCalls.length).toBeGreaterThan(0)
    expect(JSON.parse(String(resumedChunkCalls[0][1]?.[1]?.content)).chunk).toMatchObject({ index: 2, total: 3 })
    expect(String(resumedChunkCalls[0][1]?.[1]?.content ?? "")).toContain(
      "Digest after chunk 1: stable context 1.",
    )
    expect(String(resumedChunkCalls[0][1]?.[1]?.content ?? "")).not.toContain(
      "introduced topic 1",
    )
    expect((await listIngestDocuments(tmp.path))[0].documentRunId).toBe(beforeResume.documentRunId)
    expect((await listIngestRuns(tmp.path)).every((run) => run.writeStatus === "complete")).toBe(true)
  })

  it("写入阶段只交接后台审阅，不发布合并前建议", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/nitrification-inhibition.md---",
      "---",
      'title: "Nitrification inhibition"',
      "---",
      "",
      "# Nitrification inhibition",
      "",
      "X".repeat(10_500),
      "---END FILE---",
    ].join("\n")
    extraReviewResponse = [
      "---REVIEW: suggestion | Research nitrification inhibition signals---",
      "Add follow-up research on early-warning indicators for nitrification inhibition.",
      "OPTIONS: Create Page | Skip",
      "SEARCH: nitrification inhibition early warning wastewater | ammonia oxidation inhibition signals | wastewater nitrification process upset indicators",
      "---END REVIEW---",
    ].join("\n")

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(useReviewStore.getState().items).toEqual([])
    expect((await listIngestRuns(tmp.path))[0].reviewRequested).toBe(false)
    expect(mockStreamChat.mock.calls.some(([, messages]) => String(messages[0].content).startsWith("You are identifying high-value follow-up research items"))).toBe(false)
  })

  it("生成稿中的历史 REVIEW 块只作为现场保留", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---REVIEW: missing-page | Truncated Orphan---",
      "Partial description that got cut off",
    ].join("\n")
    extraReviewResponse = [
      "---REVIEW: suggestion | Real Follow-up---",
      "Real description that should not be swallowed by the generation orphan.",
      "OPTIONS: Create Page | Skip",
      "SEARCH: real follow up query | second query",
      "---END REVIEW---",
    ].join("\n")

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 },
      undefined,
      "project-a",
    )

    expect(useReviewStore.getState().items).toEqual([])
    const [run] = await listIngestRuns(tmp.path)
    expect(run.reviewRequested).toBe(false)
    expect(run.generation?.raw).toContain("Truncated Orphan")
  })

  it("retries a truncated FILE block with a targeted generation request", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/recovered.md---",
      "---",
      'title: "Recovered concept"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "",
      "# Recovered concept",
      "",
      "This response was cut off",
    ].join("\n")
    truncatedRepairResponse = [
      "---FILE: wiki/concepts/recovered.md---",
      "---",
      'title: "Recovered concept"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "",
      "# Recovered concept",
      "",
      "This block was regenerated completely.",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/stray.md---",
      "# Stray concept",
      "---END FILE---",
    ].join("\n")

    const written = await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(written).toContain("wiki/concepts/recovered.md")
    await expect(
      fs.readFile(`${tmp.path}/wiki/concepts/recovered.md`, "utf8"),
    ).resolves.toContain("This block was regenerated completely.")
    expect(written).not.toContain("wiki/concepts/stray.md")
    await expect(
      fs.readFile(`${tmp.path}/wiki/concepts/stray.md`, "utf8"),
    ).rejects.toThrow()
    expect(
      mockStreamChat.mock.calls.some(([, messages]) =>
        String(messages[0]?.content ?? "").startsWith(
          "You are repairing truncated wiki FILE blocks",
        ),
      ),
    ).toBe(true)
  })

  it("auto-routes a generated typed page into its schema directory", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/outcome.md---",
      "---",
      "type: goal",
      'title: "Outcome"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "# Outcome",
      "---END FILE---",
    ].join("\n")

    const written = await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
    )

    expect(written).toContain("wiki/goals/outcome.md")
    expect(written).not.toContain("wiki/concepts/outcome.md")
    await expect(fs.readFile(`${tmp.path}/wiki/goals/outcome.md`, "utf8"))
      .resolves.toContain("# Outcome")
  })

  it("persists completed files and resumes after a truncated generation", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    sourceMarkers = ["first attempt", "resumed attempt"]
    generationSuffix = [
      "",
      "---FILE: wiki/goals/preserved.md---",
      "---",
      "type: goal",
      'title: "Preserved"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "# Preserved",
      "---END FILE---",
    ].join("\n")
    truncateGenerationOnce = true

    await expect(autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)).rejects.toThrow("Ingest incomplete")
    expect((await listIngestRuns(tmp.path))[0].writeStatus).toBe("partial")
    await expect(fs.readFile(`${tmp.path}/wiki/goals/preserved.md`, "utf8"))
      .resolves.toContain("# Preserved")

    emptyGenerationOnce = true
    await expect(autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig))
      .rejects.toThrow("resume returned no complete wiki file")
    await expect(fs.readdir(`${tmp.path}/.llm-wiki/ingest-generation`))
      .resolves.toHaveLength(1)

    confirmResumeCompleteOnce = true
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    const generationCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages[0]?.content ?? "").includes("## What to generate"),
    )
    const resumedPrompt = String(generationCalls[generationCalls.length - 1]?.[1]?.[0]?.content ?? "")
    expect(resumedPrompt)
      .toContain("## Resume checkpoint")
    expect(resumedPrompt).toContain("wiki/goals/preserved.md")
    const checkpointFiles = await fs.readdir(`${tmp.path}/.llm-wiki/ingest-generation`)
    expect(checkpointFiles).toHaveLength(0)
    // 三次生成尝试共享同一份来源分析，避免每次续跑都支付完整分析延迟。
    const analysisCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages[0]?.content ?? "").startsWith("You are an expert research analyst"),
    )
    expect(analysisCalls).toHaveLength(1)
    for (const call of generationCalls) {
      expect(JSON.parse(String(call[1][1].content)).analysis).toContain("## Analysis\nConfiguration source.")
    }
  })

  it.each(["source", "schema", "purpose", "index", "prompt", "model", "language", "corrupt"])("生成重试时 %s 变化会重新分析，不复用过期或损坏结果", async (change) => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    const config = { ...useWikiStore.getState().llmConfig }
    sourceMarkers = ["before change", "after change"]
    truncateGenerationOnce = true
    await expect(autoIngest(tmp.path, sourcePath, config)).rejects.toThrow("Ingest incomplete")
    expect((await listIngestRuns(tmp.path))[0].writeStatus).toBe("partial")

    // 只改变一个输入条件，确认复用严格受来源、项目规则和模型约束。
    if (change === "source") await writeFileRaw(sourcePath, "name: beta\n")
    if (change === "schema") await writeFileRaw(`${tmp.path}/schema.md`, "# Schema\nChanged page rules.")
    if (change === "purpose") await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\nChanged purpose.")
    if (change === "index") await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n- [[external-new-topic]]")
    if (change === "prompt") await writeFileRaw(`${tmp.path}/prompts/01-03-独立成页与名称复用规则.md`, "Changed significance rules.")
    if (change === "model") config.model = "changed-model"
    if (change === "language") useWikiStore.getState().setOutputLanguage("French")
    if (change === "corrupt") {
      const [document] = await listIngestDocuments(tmp.path)
      await updateIngestDocument(tmp.path, document.documentRunId, (state) => { state.chunks[0].analysis = "损坏的分析正文" })
    }
    mockStreamChat.mockClear()
    await autoIngest(tmp.path, sourcePath, config)
    const analysisCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages[0]?.content ?? "").startsWith("You are an expert research analyst"),
    )
    expect(analysisCalls).toHaveLength(change === "index" ? 0 : 1)
    // 来源变化新建 run；其他规则变化重新分析，但不默认覆盖已完成工作。
    const generationCall = mockStreamChat.mock.calls.find(([, messages]) =>
      String(messages[0]?.content ?? "").includes("## What to generate"),
    )
    if (change === "source") expect(String(generationCall?.[1]?.[0]?.content)).not.toContain("## Resume checkpoint")
    else expect(String(generationCall?.[1]?.[0]?.content)).toContain("## Resume checkpoint")
    expect((await listIngestDocuments(tmp.path)).every((document) => document.splitVersion === "semantic-v2")).toBe(true)
  })

  it("长文重试只对尚未写入的子块使用新分析策略，保留已完成块", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/changed-policy.md`
    const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 }
    await writeFileRaw(sourcePath, `# One\n${"甲".repeat(4500)}\n\n## Two\n${"乙".repeat(4500)}\n\n## Three\n${"丙".repeat(4500)}`)
    failLongChunksOnce = new Set([2])
    await expect(autoIngest(tmp.path, sourcePath, config)).rejects.toThrow("Chunk analysis stream failed")
    await writeFileRaw(`${tmp.path}/prompts/01-03-独立成页与名称复用规则.md`, "Updated evidence requirements.")
    mockStreamChat.mockClear()
    await autoIngest(tmp.path, sourcePath, config)
    const firstChunkCall = mockStreamChat.mock.calls.find(([, messages]) =>
      String(messages[0].content).startsWith("You are analyzing a long source document"),
    )
    expect(String(firstChunkCall?.[1]?.[0]?.content)).toContain("Updated evidence requirements.")
    expect(JSON.parse(String(firstChunkCall?.[1]?.[1]?.content)).chunk.index).toBe(2)
  })

  it("rejects an ingest when a truncated FILE block cannot be repaired", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/incomplete.md---",
      "---",
      'title: "Incomplete concept"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "",
      "# Incomplete concept",
      "",
      "This response was cut off",
    ].join("\n")
    truncatedRepairResponse = ""

    await expect(autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, useWikiStore.getState().llmConfig, undefined, "project-a")).rejects.toThrow("Ingest incomplete")
    expect((await listIngestRuns(tmp.path))[0].writeStatus).toBe("partial")

    const activity = useActivityStore.getState().items[0]
    expect(activity.status).toBe("error")
    expect(activity.detail).toContain("could not be repaired")
    expect(activity.detail).toContain("wiki/concepts/incomplete.md")
  })

  it("写入不再执行旧同步审阅，审阅取消与导入分离", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = `${"\n"}${"X".repeat(10_500)}`
    const controller = new AbortController()
    abortDuringReview = controller

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 }, controller.signal, "project-a")
    expect(controller.signal.aborted).toBe(false)
    expect((await listIngestRuns(tmp.path))[0].reviewRequested).toBe(false)
  })

  it("falls back to built-in PDF extraction when MinerU fails for a non-cancelled ingest", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["mineru fallback source"]
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/report.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        token: "mineru-token",
        modelVersion: "vlm",
      },
    })
    mockParseWithMineru.mockRejectedValueOnce(new Error("network failure from MinerU"))
    const updateSpy = vi.spyOn(useActivityStore.getState(), "updateItem")

    const written = await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/report.pdf`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(written.length).toBeGreaterThan(0)
    expect(mockParseWithMineru).toHaveBeenCalled()
    expect(
      updateSpy.mock.calls.some(([, updates]) =>
        updates.detail?.includes("falling back to built-in PDF extraction"),
      ),
    ).toBe(true)
    updateSpy.mockRestore()
  })

  it("uses a configured local MinerU backend without a cloud token", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["local mineru source"]
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/local.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        backend: "local",
        token: "",
        modelVersion: "vlm",
      },
    })
    mockParseWithMineru.mockResolvedValueOnce({
      markdown: "local MinerU markdown",
      savedImages: [],
    })

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/local.pdf`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(mockParseWithMineru).toHaveBeenCalled()
  })

  it("does not fall back to built-in PDF extraction when MinerU is cancelled", async () => {
    if (!tmp) throw new Error("missing temp project")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/cancelled.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        token: "mineru-token",
        modelVersion: "vlm",
      },
    })
    const controller = new AbortController()
    controller.abort()
    mockParseWithMineru.mockRejectedValueOnce(new Error("MinerU parsing cancelled"))

    await expect(
      autoIngest(
        tmp.path,
        `${tmp.path}/raw/sources/project-a/cancelled.pdf`,
        useWikiStore.getState().llmConfig,
        controller.signal,
        "project-a",
      ),
    ).rejects.toThrow(/Ingest cancelled|operation was aborted/)

    expect(
      useActivityStore.getState().items.some((item) =>
        item.detail?.includes("falling back to built-in PDF extraction"),
      ),
    ).toBe(false)
  })

  it("交互写入知识页仍规范化原始来源身份", async () => {
    if (!tmp) throw new Error("missing temp project")

    const conversationId = "conv-interactive-source"
    useChatStore.setState({
      activeConversationId: conversationId,
      conversations: [
        {
          id: conversationId,
          title: "Interactive knowledge page",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      ingestSource: `${tmp.path}/raw/sources/project-a/config.yaml`,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Please save the knowledge page.",
          timestamp: Date.now(),
          conversationId,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Ready to create the knowledge page.",
          timestamp: Date.now(),
          conversationId,
        },
      ],
    })

    const writtenPaths = await executeIngestWrites(
      tmp.path,
      useWikiStore.getState().llmConfig,
    )

    const canonicalSummary = "wiki/concepts/config.md"
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary).replace(/\\/g, "/")
    const staleSummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    const content = await fs.readFile(canonicalSummaryPath, "utf8")

    expect(writtenPaths.map((p) => p.replace(/\\/g, "/"))).toEqual([canonicalSummaryPath])
    await expect(fs.access(staleSummaryPath)).rejects.toThrow()
    expect(content).toContain('sources: ["project-a/config.yaml"]')
  })

  it("rejects unsafe and application-managed paths from interactive writes", async () => {
    if (!tmp) throw new Error("missing temp project")
    interactiveGenerationOverride = [
      "---FILE: wiki/INDEX.md---\n# hostile index\n---END FILE---",
      "---FILE: wiki\\overview.MD---\n# hostile overview\n---END FILE---",
      "---FILE: ../escape.md---\n# escape\n---END FILE---",
    ].join("\n")
    useChatStore.setState({ ingestSource: `${tmp.path}/raw/sources/project-a/config.yaml` })

    const written = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    expect(written).toEqual([])
    await expect(fs.access(path.join(tmp.path, "escape.md"))).rejects.toThrow()
  })

  // 通过真实临时文件验证交互入库也使用同一命名规则，不仅验证辅助函数。
  it.each(["/", "\\"])("交互入库将标题中的 %s 转为连字符并同步正文引用", async (separator) => {
    if (!tmp) throw new Error("missing temp project")
    const title = `YPD问题排查（动作${separator}插件）`
    interactiveGenerationOverride = [
      `---FILE: wiki/goals/${title}.md---`,
      "---", "type: goal", `title: '${title}'`, "---", `# ${title}`,
      "---END FILE---",
      "---FILE: wiki/goals/导航.md---",
      "---", "type: goal", "title: 导航", "---", `参见 [[${title}]]。`,
      "---END FILE---",
    ].join("\n")

    const written = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)
    const expectedPath = `${tmp.path}/wiki/goals/YPD问题排查（动作-插件）.md`
    expect(written).toContain(expectedPath)
    expect(await fs.readFile(expectedPath, "utf8")).toContain(`title: '${title}'`)
    expect(await fs.readFile(`${tmp.path}/wiki/goals/导航.md`, "utf8"))
      .toContain("[[YPD问题排查（动作-插件）]]")
    await expect(fs.access(`${tmp.path}/wiki/goals/插件）.md`)).rejects.toThrow()
  })

  it("sanitizes malformed citation links in interactive writes", async () => {
    if (!tmp) throw new Error("missing temp project")
    interactiveGenerationOverride = [
      "---FILE: wiki/entities/citations.md---",
      "---",
      "type: entity",
      "title: Citations",
      "---",
      "Evidence [[1]] and [[target|label].",
      "---END FILE---",
    ].join("\n")
    useChatStore.setState({ ingestSource: null })

    const written = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    expect(written).toHaveLength(1)
    const content = await fs.readFile(written[0], "utf8")
    expect(content).toContain("Evidence [1] and [[target|label]].")
  })
})
