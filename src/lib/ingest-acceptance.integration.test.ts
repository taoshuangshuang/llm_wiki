/** 写入后审阅的完整输入输出契约：真实临时文件系统，仅替换模型响应。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./embedding", async (importOriginal) => ({
  ...await importOriginal<typeof import("./embedding")>(),
  fetchEmbedding: vi.fn(), vectorSearchChunks: vi.fn(), embedPage: vi.fn().mockResolvedValue(true),
}))
vi.mock("./extract-source-images", async (importOriginal) => ({
  ...await importOriginal<typeof import("./extract-source-images")>(),
  extractAndSaveSourceImages: async () => savedImages,
  extractAndSaveMarkdownImages: async () => [],
}))
vi.mock("./image-caption-pipeline", async (importOriginal) => ({
  ...await importOriginal<typeof import("./image-caption-pipeline")>(),
  captionMarkdownImages: async (_project: string, text: string) => ({ enrichedMarkdown: text, freshCaptions: 0, cachedCaptions: 0, failed: 0 }),
  loadCaptionCache: async () => new Map([["image-sha", "原文示意图"]]),
}))

import { streamChat } from "./llm-client"
import { autoIngest } from "./ingest"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import type { AcceptanceIssue, AcceptanceReport } from "./ingest-acceptance"
import { saveIngestCache } from "./ingest-cache"
import { loadReviewItems, saveReviewItems } from "./persist"
import type { SavedImage } from "./extract-source-images"
import { parseFrontmatter } from "./frontmatter"
import * as fsCommands from "@/commands/fs"
import { fetchEmbedding, vectorSearchChunks } from "./embedding"

const pagePath = "wiki/concepts/类型映射.md"
const source = "# 类型映射\n\n| 编码 | 类型 |\n| --- | --- |\n| alpha | string |\n| beta | integer |\n\n```sql\nSELECT alpha, beta FROM example;\n```"
const page = (body: string) => `---\ntype: concept\ntitle: 类型映射\nsources: [input.md]\nrelated: []\n---\n# 类型映射\n\n${body}`
const fileBlock = (path: string, content: string) => `---FILE: ${path}---\n${content}\n---END FILE---`
const issue = (kind: AcceptanceIssue["kind"]): AcceptanceIssue => ({
  kind, description: "遗漏 beta 映射和 SQL",
  sourceEvidence: "input.md 第 6 行 beta -> integer；第 9 行 SELECT alpha, beta FROM example;",
  pageEvidence: "页面只有分类摘要",
  pages: [pagePath],
})

/** 模拟原有生成阶段产生的冲突审查项，验收不得消费或关闭它。 */
function conflictReview(): string {
  return `\n---REVIEW: contradiction | 类型依据冲突---\ninput.md 定义 beta 为 integer，old.md 定义为 boolean，双方依据需人工判断。\nPAGES: ${pagePath}\nOPTIONS: 人工确认\n---END REVIEW---`
}

let project: Awaited<ReturnType<typeof createTempProject>>
let generation: string
let repairOutput: string
let results: unknown[]
let acceptanceInputs: Record<string, unknown>[]
let acceptanceSystems: string[]
let repairs: number
let truncateAcceptance: boolean
let acceptanceFailure: boolean
let savedImages: SavedImage[]

beforeEach(async () => {
  project = await createTempProject("acceptance")
  await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| Type | Directory | Description |\n| concept | wiki/concepts/ | 概念 |\n| source | wiki/sources/ | 来源 |\n")
  await writeFileRaw(`${project.path}/raw/sources/input.md`, source)
  useWikiStore.setState({
    sourceWatchConfig: { ...useWikiStore.getState().sourceWatchConfig, generateSourceSummary: false },
    project: { id: "acceptance", name: "acceptance", path: project.path },
    outputLanguage: "auto",
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
  })
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  generation = fileBlock(pagePath, page("只有分类摘要。"))
  repairOutput = fileBlock(pagePath, page(source))
  results = []
  acceptanceInputs = []
  acceptanceSystems = []
  repairs = 0
  truncateAcceptance = false
  acceptanceFailure = false
  savedImages = []
  vi.mocked(fetchEmbedding).mockReset().mockResolvedValue([1, 0])
  vi.mocked(vectorSearchChunks).mockReset().mockResolvedValue([])
  vi.mocked(streamChat).mockReset()
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    const user = String(messages[1]?.content ?? "")
    let response = "类型映射及 SQL 的来源分析。"
    if (user.startsWith('{"task":"核对语义相似页面')) {
      const input = JSON.parse(user)
      callbacks.onToken(JSON.stringify({ decisions: input.candidates.map((candidate: { path: string }) => ({ path: candidate.path, verdict: "same" })) }))
      callbacks.onDone()
      return
    }
    if (user.startsWith('{"task":"规划长材料变更')) {
      const input = JSON.parse(user)
      callbacks.onToken(JSON.stringify({ targets: input.candidates, createNew: false }))
      callbacks.onDone()
      return
    }
    if (user.startsWith('{"task":"结构规范和内容覆盖审阅')) {
      acceptanceSystems.push(system)
      acceptanceInputs.push(JSON.parse(user))
      if (acceptanceFailure) { callbacks.onError(new Error("验收服务失败")); return }
      const result = results.shift() ?? { summary: "结构规范，关键内容已保留", issues: [] }
      response = typeof result === "string" ? result : JSON.stringify(result)
      callbacks.onToken(response)
      callbacks.onDone({ truncated: truncateAcceptance, finishReason: truncateAcceptance ? "length" : "stop" })
      return
    }
    if (user.startsWith('{"task":"修复下列')) {
      repairs++
      response = repairOutput
    } else if (system.startsWith("You are repairing truncated wiki FILE blocks")) response = repairOutput
    else if (system.includes("generate wiki files") || system.includes("你负责已有知识页的正文片段整理")) {
      response = system.includes("你负责已有知识页的正文片段整理") ? JSON.stringify({ unchanged: true }) : generation
    }
    else if (system.startsWith("You are merging")) throw new Error("完整稿不得再次调用正文合并")
    else if (system.includes("identifying high-value follow-up")) response = ""
    callbacks.onToken(response)
    callbacks.onDone()
  })
})

afterEach(async () => { await project.cleanup() })

function ingest(maxContextSize = 128_000, signal?: AbortSignal): Promise<string[]> {
  return autoIngest(project.path, `${project.path}/raw/sources/input.md`, {
    ...useWikiStore.getState().llmConfig, model: "test", apiKey: "test", maxContextSize,
  }, signal)
}

async function report(): Promise<AcceptanceReport> {
  return JSON.parse(await readFileRaw(`${project.path}/.llm-wiki/acceptance/${sourceSummarySlugFromIdentity("input.md")}.json`))
}

describe("自动入库待审阅项", () => {
  describe("生成阶段决定旧页面更新目标", () => {
    const existingPath = "wiki/practices/字段类型约定.md"
    const original = page("已有 SQL 示例与适用条件。")
      .replace("type: concept", "type: practice")
      .replace("title: 类型映射", "title: 字段类型约定\ncreated: 2026-01-01")
      .replace("sources: [input.md]", "sources: [old.md]")

    async function prepare(): Promise<void> {
      await writeFileRaw(`${project.path}/${existingPath}`, original)
      useWikiStore.setState({ embeddingConfig: {
        ...useWikiStore.getState().embeddingConfig, enabled: true, model: "test", endpoint: "http://embedding.test",
      } })
      vi.mocked(vectorSearchChunks).mockResolvedValue([{
        chunk_id: "old:0", page_id: "practices/字段类型约定", chunk_index: 0,
        chunk_text: "类型映射 SQL", heading_path: "", score: 0.9,
      }])
    }

    it("生成前读取不同名候选，完整稿沿用精确旧路径并保护来源和身份", async () => {
      await prepare()
      generation = fileBlock(existingPath, page("已有 SQL 示例与适用条件。\n新补充 beta -> integer 与 SQL。\n[[wiki/practices/字段类型约定#字段|映射]]"))
      const paths = await ingest()
      expect(paths).toContain(existingPath)
      expect(await fileExists(`${project.path}/${pagePath}`)).toBe(false)
      const saved = await readFileRaw(`${project.path}/${existingPath}`)
      expect(saved).toContain("已有 SQL 示例与适用条件。")
      expect(saved).toContain("beta -> integer")
      expect(saved).toContain("[[字段类型约定#字段|映射]]")
      expect(parseFrontmatter(saved).frontmatter).toMatchObject({
        type: "practice", title: "字段类型约定", created: "2026-01-01", sources: ["old.md", "input.md"],
      })
      const call = vi.mocked(streamChat).mock.calls.find(([, messages]) => String(messages[1]?.content).includes("Stage 1 Analysis"))
      expect(String(call?.[1][1].content)).toContain("已有 SQL 示例与适用条件。")
      expect(vi.mocked(streamChat).mock.calls.some(([, messages]) => String(messages[0].content).startsWith("You are merging"))).toBe(false)
      expect(acceptanceInputs[0].beforePages).toEqual({ [existingPath]: original })
    })

    it("相关而不同主题时生成独立页，保留候选原样", async () => {
      await prepare()
      expect(await ingest()).toContain(pagePath)
      expect(await readFileRaw(`${project.path}/${existingPath}`)).toBe(original)
    })

    it("AI 判断存在风险时先写完整稿，再保留待审阅提示", async () => {
      await prepare()
      generation += `\n---REVIEW: duplicate | 相关主题可能重叠---\n保留两页并请用户核对主题边界。\nPAGES: ${existingPath}, ${pagePath}\nOPTIONS: Skip\n---END REVIEW---`
      await ingest()
      expect(await fileExists(`${project.path}/${pagePath}`)).toBe(true)
      expect(await readFileRaw(`${project.path}/${existingPath}`)).toBe(original)
      expect((await loadReviewItems(project.path)).some((review) => review.type === "duplicate")).toBe(true)
    })

    it.each(["", "无法生成完整稿"])("无效生成结果 %j 不覆盖旧页或记录成功", async (output) => {
      await prepare()
      generation = output
      await expect(ingest()).rejects.toThrow()
      expect(await readFileRaw(`${project.path}/${existingPath}`)).toBe(original)
      expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
    })

    it("多个同名候选已读后允许模型给出精确目标，其余页面保持原样", async () => {
      const other = "wiki/concepts/字段类型约定.md"
      await prepare()
      await writeFileRaw(`${project.path}/${other}`, original)
      generation = fileBlock(existingPath, page("已有 SQL 示例与适用条件。\n完整更新稿。"))
      await ingest()
      expect(await readFileRaw(`${project.path}/${other}`)).toBe(original)
      expect(await readFileRaw(`${project.path}/${existingPath}`)).toContain("完整更新稿")
    })

    it("跨目录同名目标未能重新规划时保留旧页并持久化目标问题", async () => {
      const sameName = "wiki/practices/类型映射.md"
      await writeFileRaw(`${project.path}/${sameName}`, original.replace("字段类型约定", "类型映射"))
      await expect(ingest()).rejects.toThrow("目标仍不明确")
      expect(await fileExists(`${project.path}/${pagePath}`)).toBe(false)
      expect((await loadReviewItems(project.path)).some((review) => review.type === "duplicate" && review.affectedPages?.includes(sameName))).toBe(true)
    })

    it("重复目标 FILE 必须先整合，不能依次覆盖丢失前一份事实", async () => {
      generation += "\n" + fileBlock(pagePath, page("另一份不完整内容。"))
      await expect(ingest()).rejects.toThrow("目标仍不明确")
      expect(await fileExists(`${project.path}/${pagePath}`)).toBe(false)
    })

    it("向量服务失败时公开降级原因，名称和原文检索仍可完成入库", async () => {
      await prepare()
      vi.mocked(fetchEmbedding).mockRejectedValue(new Error("embedding offline"))
      await ingest()
      expect(await fileExists(`${project.path}/${pagePath}`)).toBe(true)
      expect(await readFileRaw(`${project.path}/.llm-wiki/ingest-warnings.log`)).toContain("embedding offline")
    })

    it("写入期间展示完整稿整理、分类和实际目标路径", async () => {
      generation = fileBlock(pagePath, page(source))
      const details: string[] = []
      const unsubscribe = useActivityStore.subscribe((state) => { details.push(state.items[0]?.detail ?? "") })
      try {
        await ingest()
        expect(details).toContain(`处理文件 1/1：整理完整更新稿 — ${pagePath}`)
        expect(details).toContain(`处理文件 1/1：业务模块分类 — ${pagePath}`)
        expect(details).toContain(`处理文件 1/1：写入文件 — ${pagePath}`)
      } finally { unsubscribe() }
    })
  })

  // 完整生成到验收链路：不能只靠提示词，模型或合并重新带回路径时也须归一化。
  it("验收前将正文和旧索引转换为文件名引用，索引新增项遵循同一约定", async () => {
    const target = "wiki/concepts/查询边界.md"
    await writeFileRaw(`${project.path}/${target}`, page("目标内容").replace("title: 类型映射", "title: 展示标题"))
    await writeFileRaw(`${project.path}/wiki/index.md`, "# 索引\n- [[concepts/查询边界]] — 展示标题\n")
    generation = fileBlock(pagePath, page("参见 [[concepts/查询边界#范围|配置说明]] 和 [[展示标题]]。"))

    await ingest()

    expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("[[查询边界#范围|配置说明]]")
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("和 [[查询边界]]")
    expect(acceptanceInputs[0].pages).toMatchObject({ [pagePath]: expect.stringContaining("[[查询边界#范围|配置说明]]") })
    const index = await readFileRaw(`${project.path}/wiki/index.md`)
    expect(index).toContain("[[查询边界]] — 展示标题")
    expect(index).toContain("[[类型映射]] — 类型映射")
    expect(index).not.toContain("[[concepts/")
  })

  it("覆盖问题只生成待审阅项，不调用补录或覆盖已规范化页面", async () => {
    await writeFileRaw(`${project.path}/wiki/concepts/查询边界.md`, page("目标内容"))
    generation = fileBlock(pagePath, page("参见 [[concepts/查询边界]]。"))
    results = [{ summary: "遗漏内容", issues: [issue("coverage")] }]
    await ingest()
    expect(acceptanceInputs).toHaveLength(1)
    expect(repairs).toBe(0)
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("[[查询边界]]")
    expect(useReviewStore.getState().items[0].type).toBe("coverage")
  })

  it("含井号的实际文件名在缓存重试时不重复追加索引", async () => {
    generation = fileBlock("wiki/concepts/查询#get.md", page(source).replace("title: 类型映射", "title: 查询#get"))
    await ingest()
    await ingest()
    const index = await readFileRaw(`${project.path}/wiki/index.md`)
    expect(index.match(/\[\[查询#get\]\]/g)).toHaveLength(2)
  })

  // 复现 PDF 入库的真实边界：模型省略知识页后缀，原始 PDF 名称仍须保持不变。
  it.each(["wiki/concepts/类型映射", "wiki/concepts/type-mapping", "wiki/concepts/类型映射.MD"])(
    "PDF 生成路径 %s 时，落盘为 Markdown 并完成验收及缓存重试", async (generatedPath) => {
      const sourceName = "领域元数据设计及应用文档.pdf"
      const inputPath = `${project.path}/raw/sources/${sourceName}`
      await writeFileRaw(inputPath, source)
      generation = fileBlock(generatedPath, page(source).replace("sources: [input.md]", `sources: ["${sourceName}"]`))
      const config = { ...useWikiStore.getState().llmConfig, model: "test", apiKey: "test", maxContextSize: 128_000 }

      const paths = await autoIngest(project.path, inputPath, config)
      expect(paths).toContain(pagePath)
      expect(await fileExists(`${project.path}/${pagePath.replace(/\.md$/, "")}`)).toBe(false)
      expect(await readFileRaw(inputPath)).toBe(source)
      expect(parseFrontmatter(await readFileRaw(`${project.path}/${pagePath}`)).frontmatter?.sources).toEqual([sourceName])
      expect(Object.keys(acceptanceInputs[0].pages as object)).toContain(pagePath)
      const acceptancePath = `${project.path}/.llm-wiki/acceptance/${sourceSummarySlugFromIdentity(sourceName)}.json`
      expect(JSON.parse(await readFileRaw(acceptancePath)).status).toBe("clear")

      // 同一来源再次入库走缓存，保持规范路径，不重复生成或重复验收。
      expect(await autoIngest(project.path, inputPath, config)).toContain(pagePath)
      expect(acceptanceInputs).toHaveLength(1)
    },
  )

  it("截断页面与修复输出均省略后缀时，仍写入同一 Markdown 页面并通过验收", async () => {
    // 首次输出未闭合，修复模型也省略后缀；两阶段必须识别为同一个待修复页面。
    const extensionlessPath = pagePath.replace(/\.md$/, "")
    generation = `---FILE: ${extensionlessPath}---\n${page("尚未输出完整")}`
    repairOutput = fileBlock(extensionlessPath, page(source))

    expect(await ingest()).toContain(pagePath)
    expect(await fileExists(`${project.path}/${extensionlessPath}`)).toBe(false)
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("SELECT alpha, beta FROM example;")
    expect((await report()).status).toBe("clear")
  })

  it("省略后缀的生成页面在审阅后保持原路径，不自动补录", async () => {
    generation = fileBlock(pagePath.replace(/\.md$/, ""), page("只有分类摘要。"))
    results = [{ summary: "发现遗漏", issues: [issue("coverage")] }]
    expect(await ingest()).toContain(pagePath)
    expect(await fileExists(`${project.path}/${pagePath.replace(/\.md$/, "")}`)).toBe(false)
    expect(acceptanceInputs).toHaveLength(1)
    expect(repairs).toBe(0)
    expect((await report()).rounds[0].issues[0].kind).toBe("coverage")
  })

  it("默认只生成知识页，保留 sources，不补建来源摘要", async () => {
    await ingest()
    const summary = `wiki/sources/${sourceSummarySlugFromIdentity("input.md")}.md`
    expect(await fileExists(`${project.path}/${summary}`)).toBe(false)
    expect(parseFrontmatter(await readFileRaw(`${project.path}/${pagePath}`)).frontmatter?.sources).toEqual(["input.md"])
    expect((await report()).status).toBe("clear")
  })

  it("关闭摘要时跳过模型多余的 source 块，已有摘要保持原样", async () => {
    const summary = `wiki/sources/${sourceSummarySlugFromIdentity("input.md")}.md`
    const original = "---\ntype: source\ntitle: 历史导读\n---\n历史内容。"
    await writeFileRaw(`${project.path}/${summary}`, original)
    generation += `\n${fileBlock(summary, "---\ntype: source\ntitle: 新摘要\n---\n不应写入")}`
    await ingest()
    expect(await readFileRaw(`${project.path}/${summary}`)).toBe(original)
    expect(Object.keys(acceptanceInputs[0].pages as object)).not.toContain(summary)
  })

  it("关闭摘要后配图附在对应知识页，缓存重跑保持幂等", async () => {
    useWikiStore.setState({ multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: true } })
    savedImages = [{ index: 0, mimeType: "image/png", page: 1, width: 10, height: 10,
      relPath: "media/input/diagram.png", absPath: `${project.path}/wiki/media/input/diagram.png`, sha256: "image-sha" }]
    await ingest()
    const first = await readFileRaw(`${project.path}/${pagePath}`)
    expect(first).toContain("## 来源配图：input.md")
    expect(first).toContain("diagram.png")
    expect(first).toContain("原文示意图")
    expect(await fileExists(`${project.path}/wiki/sources/${sourceSummarySlugFromIdentity("input.md")}.md`)).toBe(false)
    await ingest()
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toBe(first)
  })
  it("应用维护的 source 摘要不要求加入业务类型表", async () => {
    useWikiStore.setState({ sourceWatchConfig: { ...useWikiStore.getState().sourceWatchConfig, generateSourceSummary: true } })
    await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| Type | Directory | Description |\n| concept | wiki/concepts/ | 概念 |\n\n## 维护约定\n应用生成 type: source 来源摘要到 wiki/sources/，不作为业务内容类型。")
    await ingest()
    expect((await report()).status).toBe("clear")
    expect(repairs).toBe(0)
  })

  it("完整原文可放入上下文时一次核对，不能把后文误判为无来源依据", async () => {
    const wholeSource = `前文定义。\n${"原文条目。\n".repeat(120)}尾部有依据的映射TAIL_EVIDENCE`
    await writeFileRaw(`${project.path}/raw/sources/input.md`, wholeSource)
    await ingest()
    expect(acceptanceInputs).toHaveLength(1)
    expect(String(acceptanceInputs[0].source)).toContain("TAIL_EVIDENCE")
  })

  it("已有失败报告在重新打开待审阅时也能加载，不必付费重跑模型", async () => {
    await writeFileRaw(`${project.path}/.llm-wiki/acceptance/failed.json`, JSON.stringify({
      sourceIdentity: "input.md", status: "failed", updatedAt: 123,
      rounds: [{ summaries: ["遗漏"], issues: [issue("coverage")] }],
    }))
    const reviews = await loadReviewItems(project.path)
    expect(reviews.some((item) => item.type === "coverage" && item.description.includes("遗漏 beta 映射和 SQL"))).toBe(true)
  })

  it("点 X 忽略后清理列表并重载，同一历史报告和再次入库都不恢复待处理项", async () => {
    await writeFileRaw(`${project.path}/.llm-wiki/acceptance/ignored.json`, JSON.stringify({
      sourceIdentity: "input.md", status: "pending-review", updatedAt: 123,
      rounds: [{ summaries: ["需核对"], issues: [issue("structure")] }],
    }))
    const [original] = await loadReviewItems(project.path)
    useReviewStore.getState().setItems([original])
    useReviewStore.getState().dismissItem(original.id)
    // 清理已解决列表不能抹掉用户的忽略决定；保存后模拟应用重新打开。
    useReviewStore.getState().clearResolved()
    await saveReviewItems(project.path, useReviewStore.getState().items)
    const loaded = await loadReviewItems(project.path)
    expect(loaded.filter((item) => !item.resolved)).toEqual([])
    expect(loaded).toContainEqual(expect.objectContaining({ id: original.id, dismissed: true }))
    useReviewStore.getState().setItems(loaded)
    useReviewStore.getState().addItem(original)
    useReviewStore.getState().addItems([original])
    expect(useReviewStore.getState().items.filter((item) => !item.resolved)).toEqual([])
    expect(useReviewStore.getState().items).toHaveLength(1)
    expect(await loadReviewItems(project.path)).toEqual(loaded)
  })

  it("旧验收事项按报告恢复两种类型，同标题也保留人工处理状态且不重复", async () => {
    // 旧版两类问题使用同一个 confirm 身份；迁移后两类都应继承其处理状态。
    await writeFileRaw(`${project.path}/.llm-wiki/acceptance/legacy.json`, JSON.stringify({
      sourceIdentity: "input.md", status: "failed", updatedAt: 123,
      rounds: [{ summaries: ["需核对"], issues: [issue("structure"), issue("coverage")] }],
    }))
    await saveReviewItems(project.path, [{
      id: "legacy", type: "confirm", title: "入库验收未通过：input.md：遗漏 beta 映射和 SQL",
      description: "旧验收说明", sourcePath: `${project.path}/raw/sources/input.md`,
      options: [{ label: "已人工修正，需重试验收", action: "已人工修正，需重试验收" }],
      resolved: true, resolvedAction: "已人工修正，需重试验收", createdAt: 100,
    }])
    const items = await loadReviewItems(project.path)
    expect(items.map((item) => item.type)).toEqual(["structure", "coverage"])
    expect(items.every((item) => item.resolved && item.resolvedAction === "已审阅" && item.createdAt === 100)).toBe(true)
    await saveReviewItems(project.path, items)
    expect(await loadReviewItems(project.path)).toEqual(items)
  })

  it("没有报告的旧验收事项改为普通待确认项，保留原处理状态", async () => {
    await saveReviewItems(project.path, [{
      id: "legacy", type: "confirm", title: "入库验收未通过：input.md：旧问题",
      description: "旧问题\n\n请核对原文并修正页面或规则，然后点击失败来源右侧的重试按钮。",
      options: [{ label: "已人工修正，需重试验收", action: "已人工修正，需重试验收" }],
      resolved: false, createdAt: 100,
    }])
    const [item] = await loadReviewItems(project.path)
    expect(item).toMatchObject({ type: "confirm", title: "入库审阅：input.md：旧问题", resolved: false })
    expect(item.description).not.toContain("重试按钮")
    expect(item.options).toEqual([{ label: "已审阅", action: "已审阅" }])
  })

  it("审阅报告保存失败仍保留全部发现，使用待审阅文件持久化", async () => {
    results = [{ summary: "需核对", issues: [issue("structure"), issue("coverage")] }]
    const write = fsCommands.writeFile
    const spy = vi.spyOn(fsCommands, "writeFile").mockImplementation(async (path, content) => {
      if (path.includes("/.llm-wiki/acceptance/")) throw new Error("报告目录不可写")
      return write(path, content)
    })
    try {
      await ingest()
      const items = await loadReviewItems(project.path)
      expect(items.map((item) => item.type)).toEqual(["structure", "coverage", "confirm"])
      expect(items[2].description).toContain("报告目录不可写")
      expect(useActivityStore.getState().items[0].status).toBe("done")
    } finally { spy.mockRestore() }
  })

  it("待审阅事项保存失败仍报错，不把问题丢失的任务当成完成", async () => {
    results = [{ summary: "需核对", issues: [issue("coverage")] }]
    const write = fsCommands.writeFile
    const spy = vi.spyOn(fsCommands, "writeFile").mockImplementation(async (path, content) => {
      if (path.endsWith("/.llm-wiki/review.json")) throw new Error("审阅文件不可写")
      return write(path, content)
    })
    try {
      await expect(ingest()).rejects.toThrow("审阅记录保存失败")
      expect(useActivityStore.getState().items[0].status).toBe("error")
      expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
      expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("只有分类摘要")
    } finally { spy.mockRestore() }
  })
  it("历史失败报告中的冲突不转成验收问题，原有冲突审查仍保留", async () => {
    await writeFileRaw(`${project.path}/.llm-wiki/acceptance/legacy.json`, JSON.stringify({
      sourceIdentity: "input.md", status: "failed", updatedAt: 123,
      rounds: [{ summaries: ["旧版冲突与遗漏"], issues: [{ ...issue("coverage"), kind: "conflict" }, issue("coverage")] }],
    }))
    await writeFileRaw(`${project.path}/.llm-wiki/review.json`, JSON.stringify([{
      id: "legacy-conflict", type: "contradiction", title: "原有冲突", description: "人工判断双方说法",
      sourcePath: `${project.path}/raw/sources/input.md`, affectedPages: [pagePath], options: [], resolved: false, createdAt: 123,
    }]))
    const reviews = await loadReviewItems(project.path)
    expect(reviews.filter((item) => item.type === "coverage")).toHaveLength(1)
    expect(reviews.filter((item) => item.type === "contradiction")).toHaveLength(1)
  })

  it("使用原始输入及实际落盘页，将全部问题按结构和覆盖类型持久化", async () => {
    results = [{ summary: "需人工核对", issues: [issue("structure"), issue("coverage")] }]
    await ingest()
    expect(repairs).toBe(0)
    expect(acceptanceInputs).toHaveLength(1)
    expect(acceptanceInputs[0].source).toBe(`${source}\n`)
    expect((acceptanceInputs[0].pages as Record<string, string>)[pagePath]).toContain("只有分类摘要")
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("只有分类摘要")
    expect((await loadReviewItems(project.path)).map((item) => item.type)).toEqual(["structure", "coverage"])
    expect(useActivityStore.getState().items[0]).toMatchObject({ status: "done", detail: expect.stringContaining("2 个待审阅项") })
  })

  it("模型返回空问题列表时，程序兜底发现的结构问题仍交待审阅", async () => {
    generation = fileBlock(pagePath, "---\ntitle: 类型映射\nsources: [input.md]\n---\n# 类型映射\n正文")
    await ingest()
    expect(repairs).toBe(0)
    expect((await report()).rounds[0].issues.some((finding) => finding.description.includes("type"))).toBe(true)
    expect((await loadReviewItems(project.path)).some((item) => item.type === "structure")).toBe(true)
    expect(useActivityStore.getState().items[0].status).toBe("done")
  })

  it("有待审阅项仍完成导入和缓存，重复导入不重跑模型且保留待处理项", async () => {
    results = [{ summary: "缺少明细", issues: [issue("coverage")] }]
    expect(await ingest()).toContain(pagePath)
    expect(repairs).toBe(0)
    expect((await report()).status).toBe("pending-review") // 问题待人工审阅，与导入完成状态独立。
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(true)
    expect((await loadReviewItems(project.path))[0]).toMatchObject({ type: "coverage", resolved: false })
    await ingest()
    expect(acceptanceInputs).toHaveLength(1)
    expect(useReviewStore.getState().items).toHaveLength(1)
  })

  it("新一轮检查无问题也不自动关闭旧待审阅项，人工已审阅状态跨刷新保留", async () => {
    results = [{ summary: "遗漏", issues: [issue("coverage")] }]
    await ingest()
    await writeFileRaw(`${project.path}/raw/sources/input.md`, `${source}\n补充说明。`)
    await ingest()
    expect((await loadReviewItems(project.path))[0].resolved).toBe(false)
    const item = useReviewStore.getState().items[0]
    useReviewStore.getState().resolveItem(item.id, "已审阅")
    await saveReviewItems(project.path, useReviewStore.getState().items)
    expect((await loadReviewItems(project.path))[0]).toMatchObject({ resolved: true, resolvedAction: "已审阅" })
  })

  it("已有页面保留合并结果，冲突独立待审阅，不影响验收成功和缓存", async () => {
    const existing = page("旧资料：beta -> boolean。原有解释和其他来源事实。").replace("[input.md]", "[old.md]")
    await writeFileRaw(`${project.path}/${pagePath}`, existing)
    generation = fileBlock(pagePath, page(`旧资料 old.md：beta -> boolean。\n\n新资料 input.md：\n${source}`)) + conflictReview()
    await ingest()
    expect(repairs).toBe(0)
    expect(acceptanceInputs).toHaveLength(1)
    expect(acceptanceInputs[0]).not.toHaveProperty("pendingConflicts")
    expect(acceptanceInputs[0].beforePages).toHaveProperty(pagePath)
    const written = await readFileRaw(`${project.path}/${pagePath}`)
    expect((acceptanceInputs[0].pages as Record<string, string>)[pagePath]).toBe(written)
    expect(written).toContain("旧资料 old.md：beta -> boolean")
    expect(written).toContain("| beta | integer |")
    expect(parseFrontmatter(written).frontmatter?.sources).toEqual(["old.md", "input.md"])
    const reviews = await loadReviewItems(project.path)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ type: "contradiction", resolved: false, affectedPages: [pagePath] })
    expect((await report()).status).toBe("clear")
    expect(await report()).not.toHaveProperty("pendingConflicts")
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(true)
    expect(useActivityStore.getState().items[0].detail).toContain("已写入")
  })

  it("新生成的冲突页面正常写入和索引，成功缓存不清除待审阅冲突", async () => {
    generation = fileBlock(pagePath, page(`old.md 记录 beta -> boolean；input.md 记录如下：\n${source}`)) + conflictReview()
    await ingest()
    const content = await readFileRaw(`${project.path}/${pagePath}`)
    expect(content).toContain("beta -> boolean")
    expect(content).toContain("| beta | integer |")
    expect(await readFileRaw(`${project.path}/wiki/index.md`)).toContain("[[类型映射]]")
    expect((await report()).status).toBe("clear")
    await ingest()
    expect(acceptanceInputs).toHaveLength(1)
    expect(useReviewStore.getState().items).toHaveLength(1)
    expect(useReviewStore.getState().items[0]).toMatchObject({ type: "contradiction", resolved: false })
  })

  it("同页冲突与覆盖问题分别待审阅，双方说法保留且不自动补录", async () => {
    generation = fileBlock(pagePath, page("old.md：beta -> boolean；input.md：beta -> integer。")) + conflictReview()
    results = [{ summary: "缺少 SQL", issues: [issue("coverage")] }]
    await ingest()
    expect(repairs).toBe(0)
    expect((await report()).rounds).toHaveLength(1)
    const content = await readFileRaw(`${project.path}/${pagePath}`)
    expect(content).toContain("beta -> boolean")
    expect(content).toContain("beta -> integer")
    expect((await loadReviewItems(project.path)).map((item) => item.type)).toEqual(["contradiction", "coverage"])
  })

  it("遗漏一方观点仍记录为覆盖待审阅项，不被冲突事项替代", async () => {
    generation += conflictReview()
    results = [{ summary: "观点遗漏", issues: [{ ...issue("coverage"), description: "遗漏原文 beta -> integer" }] }]
    await ingest()
    expect((await loadReviewItems(project.path)).find((item) => item.type === "coverage")?.description).toContain("遗漏原文 beta -> integer")
    expect(repairs).toBe(0)
  })

  it("覆盖问题保留合并后的页面和独立冲突事项，不恢复旧文件", async () => {
    await writeFileRaw(`${project.path}/${pagePath}`, page("旧页面，仅 beta -> boolean。").replace("[input.md]", "[old.md]"))
    generation = fileBlock(pagePath, page("完整稿保留 beta -> boolean，同时补充 beta -> integer。")) + conflictReview()
    results = [{ summary: "遗漏", issues: [issue("coverage")] }]
    await ingest()
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("补充 beta -> integer")
    expect(useReviewStore.getState().items.map((item) => item.type)).toEqual(["contradiction", "coverage"])
    expect(useActivityStore.getState().items[0].status).toBe("done")
  })

  it.each(["", "通过", "{}", '{"summary":"通过"}', '{"summary":"","issues":[]}']) (
    "无效验收响应 %j 不能当成通过", async (response) => {
      results = [response]
      await ingest()
      expect((await loadReviewItems(project.path)).some((item) => item.type === "confirm")).toBe(true)
      expect((await report()).status).toBe("pending-review")
      expect(repairs).toBe(0)
    },
  )

  it.each(["调用失败", "输出截断"])("审阅%s转待确认，文件写入和缓存仍完成", async (mode) => {
    acceptanceFailure = mode === "调用失败"
    truncateAcceptance = mode === "输出截断"
    await ingest()
    expect((await report()).error).toContain(mode === "调用失败" ? "验收服务失败" : "响应被截断")
    expect((await loadReviewItems(project.path))[0]).toMatchObject({ type: "confirm", resolved: false })
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(true)
    expect(useActivityStore.getState().items[0].status).toBe("done")
  })

  it("读取自定义审阅规则且不覆盖配置，不再调用旧补录规则", async () => {
    await writeFileRaw(`${project.path}/prompts/06-01-最终验收规则.md`, "CUSTOM_REVIEW_RULE：逐条保留类型映射。")
    await writeFileRaw(`${project.path}/prompts/06-02-验收修复补录规则.md`, "CUSTOM_REPAIR_RULE：保留已有正文并补齐 SQL。")
    results = [{ summary: "发现遗漏", issues: [issue("coverage")] }]
    await ingest()
    expect(acceptanceSystems).toEqual(["CUSTOM_REVIEW_RULE：逐条保留类型映射。"])
    expect(repairs).toBe(0)
    expect(await readFileRaw(`${project.path}/prompts/06-01-最终验收规则.md`)).toBe("CUSTOM_REVIEW_RULE：逐条保留类型映射。")
  })

  it("通过后复用缓存，修改验收规则后下次入库重新检查", async () => {
    await ingest()
    await ingest()
    expect(acceptanceInputs).toHaveLength(1)
    await writeFileRaw(`${project.path}/prompts/06-01-最终验收规则.md`, "检查完整映射和 SQL；返回 summary 和 issues JSON。")
    await ingest()
    expect(acceptanceInputs).toHaveLength(2)
    expect(acceptanceSystems[1]).toContain("检查完整映射和 SQL")
  })

  it("未经最终验收的历史缓存不能绕过新增验收", async () => {
    await writeFileRaw(`${project.path}/${pagePath}`, page("旧版生成但未经复查的内容"))
    await saveIngestCache(project.path, "input.md", source, [pagePath])
    await ingest()
    expect(acceptanceInputs).toHaveLength(1)
    expect((await report()).status).toBe("clear")
  })

  it("原文在预算内时核对完整文本，末尾信息不会被摘要或截断替代", async () => {
    const longSource = `${"原文知识条目。\n".repeat(240)}尾部映射 beta -> integer 和 SQL。`
    await writeFileRaw(`${project.path}/raw/sources/input.md`, longSource)
    await ingest()
    expect(acceptanceInputs).toHaveLength(1)
    expect(acceptanceInputs.map((input) => input.source).join("")).toBe(`${longSource}\n`)
    expect(acceptanceInputs[0].sourceScope).toBe("complete")
  })

  it("长文后续分段验收失败仍保留写入页面，冲突独立持久化", async () => {
    await writeFileRaw(`${project.path}/raw/sources/input.md`, "原文知识条目。\n".repeat(6000))
    generation = fileBlock(pagePath, page("保留已有知识。\n".repeat(9000))) + conflictReview()
    results = [{ summary: "首段已覆盖", issues: [] }, "无效响应"]
    await ingest()
    expect(useReviewStore.getState().items.filter((item) => item.type === "contradiction")).toHaveLength(1)
    expect(useReviewStore.getState().items.some((item) => item.type === "confirm")).toBe(true)
    expect(await readFileRaw(`${project.path}/${pagePath}`)).toContain("保留已有知识")
    expect((await report()).status).toBe("pending-review")
    expect(acceptanceInputs[0].sourceScope).toBe("fragment")
    expect(String(acceptanceInputs[0].scopeNote)).toContain("不得将本段未出现")
  })

  it("审阅容量不足转待确认，不截取材料或阻断导入", async () => {
    await writeFileRaw(`${project.path}/prompts/06-01-最终验收规则.md`, "审阅规则。".repeat(40000))
    await ingest()
    expect((await report()).error).toContain("上下文预算")
    expect(acceptanceInputs).toHaveLength(0)
    expect((await loadReviewItems(project.path))[0].type).toBe("confirm")
    expect(useActivityStore.getState().items[0].status).toBe("done")
  })

  it("审阅发现问题时不执行模型补录输出，不增加额外文件", async () => {
    results = [{ summary: "遗漏", issues: [issue("coverage")] }]
    repairOutput = fileBlock("../outside.md", "不允许写入")
    await ingest()
    expect(repairs).toBe(0)
    expect(await fileExists(`${project.path}/outside.md`)).toBe(false)
  })

})
