/** 最终验收的完整输入输出契约：真实临时文件系统，仅替换模型响应。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
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
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import type { SavedImage } from "./extract-source-images"

const pagePath = "wiki/concepts/类型映射.md"
const source = "# 类型映射\n\n| 编码 | 类型 |\n| --- | --- |\n| alpha | string |\n| beta | integer |\n\n```sql\nSELECT alpha, beta FROM example;\n```"
const page = (body: string) => `---\ntype: concept\ntitle: 类型映射\nsources: [input.md]\nrelated: []\n---\n# 类型映射\n\n${body}`
const fileBlock = (path: string, content: string) => `---FILE: ${path}---\n${content}\n---END FILE---`

let project: Awaited<ReturnType<typeof createTempProject>>
let generation: string
let mergedOutput: string
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
  mergedOutput = page("合并生成后，beta -> integer。")
  repairOutput = fileBlock(pagePath, page(source))
  results = []
  acceptanceInputs = []
  acceptanceSystems = []
  repairs = 0
  truncateAcceptance = false
  acceptanceFailure = false
  savedImages = []
  vi.mocked(streamChat).mockReset()
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    const user = String(messages[1]?.content ?? "")
    let response = "类型映射及 SQL 的来源分析。"
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
    } else if (system.includes("generate wiki files")) response = generation
    else if (system.startsWith("You are merging")) response = mergedOutput
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



/** 临时诊断：运行真实入库、真实临时磁盘和真实验收，只替换模型响应。 */
describe("文件边界损坏的完整入库诊断", () => {
  it("模型漏写文件结束标记时，应用必须阻止错误成功状态", async () => {
    const secondPath = "wiki/concepts/第二篇.md"
    generation = [
      `---FILE: ${pagePath}---`, page("第一篇正文。"),
      `---FILE: ${secondPath}---`,
      "---\ntype: concept\ntitle: 第二篇\nsources: [input.md]\nrelated: []\n---\n# 第二篇\n\n第二篇正文。",
      "---END FILE---",
    ].join("\n")
    await expect(ingest()).rejects.toThrow("truncated wiki file")
    expect(await fileExists(`${project.path}/${secondPath}`)).toBe(true)
    expect(await fileExists(`${project.path}/${pagePath}`)).toBe(false)
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
    expect(acceptanceInputs).toHaveLength(0)
    // 重试仍不能将未修复边界当作成功，已完整页也不能被吞入另一页正文。
    await expect(ingest()).rejects.toThrow("truncated wiki file")
    expect(await readFileRaw(`${project.path}/${secondPath}`)).not.toContain("---FILE:")

  })

  it("多个文件边界连续缺失时不吞并页面，也不产生成功缓存", async () => {
    const paths = Array.from({ length: 5 }, (_, index) => `wiki/concepts/损坏片段${index + 1}.md`)
    generation = paths.map((path) => `---FILE: ${path}---\n${page("该主题的独立事实。")}`).join("\n") + "\n---END FILE---"
    await expect(ingest()).rejects.toThrow("truncated wiki file")
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
    expect(useActivityStore.getState().items[0].status).toBe("error")
  })
})
