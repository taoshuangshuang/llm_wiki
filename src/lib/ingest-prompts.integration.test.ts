/** 验证提示词配置接入真实入库链路，同时保持原有模型调用、缓存和文件写入行为。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { parseFrontmatter } from "./frontmatter"
import { streamChat } from "./llm-client"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
// 本组聚焦既有提示词阶段；最终验收的真实接入由 ingest-acceptance.integration.test.ts 覆盖。
vi.mock("./ingest-acceptance", () => ({
  runIngestAcceptance: vi.fn(async () => ({ report: { status: "passed", rounds: [] }, reviews: [] })),
}))

import { autoIngest } from "./ingest"
import { removeFromIngestCache } from "./ingest-cache"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { DEFAULT_INGEST_PROMPTS } from "./ingest-prompts"

const oldPath = "wiki/references/QuerySchema模型.md"
const newPath = "wiki/references/QuerySchema模型说明.md"
const oldPage = "---\ntype: reference\ntitle: QuerySchema模型\nsources: [old.md]\n---\n# QuerySchema模型\n\nfields 定义查询字段，orders 定义排序字段。"
const incoming = "---\ntype: reference\ntitle: QuerySchema模型说明\nsources: [incoming.md]\n---\n# QuerySchema模型说明\n\npager 定义分页参数，conditions 定义查询条件。"
let project: Awaited<ReturnType<typeof createTempProject>>
let generation = ""
let prompts: string[] = []
let requests: string[] = []

beforeEach(async () => {
  vi.clearAllMocks()
  prompts = []
  requests = []
  generation = `---FILE: ${newPath}---\n${incoming}\n---END FILE---`
  project = await createTempProject("ingest-prompt-config")
  await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| Type | Directory | Purpose |\n| reference | wiki/references/ | 技术参考 |\n")
  await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "QuerySchema 查询模型说明。")
  await writeFileRaw(`${project.path}/${oldPath}`, oldPage)
  useWikiStore.setState({
    sourceWatchConfig: { ...useWikiStore.getState().sourceWatchConfig, generateSourceSummary: true },
    project: { id: "prompt-config", name: "prompt-config", path: project.path },
    outputLanguage: "auto",
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
  })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    prompts.push(system)
    requests.push(String(messages[1]?.content ?? ""))
    let response = "QuerySchema 查询模型分析。"
    const user = String(messages[1]?.content ?? "")
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
    if (system.includes("你负责已有知识页的正文片段整理")) response = JSON.stringify({ unchanged: true })
    else if (system.includes("本批次只处理来源摘要")) response = "---FILE: wiki/sources/incoming.md---\n---\ntype: source\ntitle: 输入资料\nsources: [incoming.md]\n---\n# 来源\n查询模型事实。\n---END FILE---"
    else if (system.includes("generate wiki files")) response = generation
    else if (system.startsWith("You are merging")) response = `${oldPage}\n\npager 定义分页参数，conditions 定义查询条件。`
    else if (system.includes("业务模块分类器")) response = '{"moduleIds":["query"]}'
    else if (system.includes("identifying high-value follow-up")) response = ""
    else if (system.includes("analyzing a long source")) response = "## Chunk Analysis\n查询模型证据。\n## Updated Global Digest\n查询模型整体分析。"
    callbacks.onToken(response)
    callbacks.onDone()
  })
})

afterEach(async () => { await project.cleanup() })

function ingest(maxContextSize = 128000): Promise<string[]> {
  const config = { ...useWikiStore.getState().llmConfig, model: "test", apiKey: "test", maxContextSize }
  return autoIngest(project.path, `${project.path}/raw/sources/incoming.md`, config)
}

describe("提示词可配置且默认入库行为保持不变", () => {
  it("沿用按路径写入规则，不新增名称匹配步骤或额外模型调用", async () => {
    await ingest()
    expect(prompts).toHaveLength(2)
    expect(await fileExists(`${project.path}/${newPath}`)).toBe(true)
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toBe(oldPage)
  })

  it("自定义分析和生成策略进入原有阶段，输出协议直接写在默认模板中", async () => {
    await writeFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`, "CUSTOM_ANALYSIS_POLICY")
    await writeFileRaw(`${project.path}/prompts/02-02-独立页面写作规则.md`, "CUSTOM_GENERATION_POLICY")
    await ingest()
    expect(prompts[0]).toContain("CUSTOM_ANALYSIS_POLICY")
    expect(prompts[1]).toContain("CUSTOM_GENERATION_POLICY")
    expect(prompts[1]).toContain("---END FILE---")
    expect(prompts).toHaveLength(2)
  })

  it("完整替换分析和生成框架，不再由代码强制按实体与概念组织", async () => {
    await writeFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`, [
      "按项目分类分析候选页面，并给出类型和分类依据。",
      "Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.", "{{language_rule}}", "{{独立成页与名称复用规则}}",
      "{{schema_context}}", "{{purpose_context}}", "{{index_context}}",
    ].join("\n"))
    await writeFileRaw(`${project.path}/prompts/02-01-Wiki页面生成.md`, [
      "You generate wiki files. 根据主要用途选择项目定义的类型。",
      "{{language_rule}}", "来源：{{source_identity}}，日期：{{today}}", "{{schema}}",
      "来源摘要路径：{{summary_path}}", "{{独立页面写作规则}}",
      "{{purpose_context}}", "{{index_context}}", "{{overview_context}}",
      DEFAULT_INGEST_PROMPTS.generationTemplate.slice(DEFAULT_INGEST_PROMPTS.generationTemplate.indexOf("## Output Format")),
    ].join("\n"))
    await ingest()
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("给出类型和分类依据")
    expect(prompts[0]).not.toContain("## Key Entities")
    expect(prompts[0]).not.toContain("## Key Concepts")
    expect(prompts[1]).not.toContain("Concept or schema-defined typed pages")
    expect(prompts[1]).not.toContain("one of the known types")
    expect(prompts[1]).toContain("---END FILE---")
    expect(await fileExists(`${project.path}/${newPath}`)).toBe(true)
  })

  it("长文分块使用项目模板，保留程序要求的两个输出章节", async () => {
    await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "# 查询模型\n\n查询模型的技术说明。\n\n".repeat(3000))
    await writeFileRaw(`${project.path}/prompts/01-02-长文分块分析.md`, [
      "You are analyzing a long source. CUSTOM_CHUNK_TEMPLATE",
      "Do not output chain-of-thought, hidden reasoning, or a thinking transcript.", "{{language_rule}}", "Output exactly two markdown sections:",
      "## Chunk Analysis", "按 schema 判断候选页类型，解释分类依据。", "## Updated Global Digest",
      "{{独立成页与名称复用规则}}", "{{purpose_context}}", "{{schema_context}}", "{{index_context}}",
    ].join("\n"))
    // 缩短本测试的生成框架，为小窗口留下原文分批空间；分块分析仍使用真实项目模板。
    await writeFileRaw(`${project.path}/prompts/02-01-Wiki页面生成.md`, "You generate wiki files. {{language_rule}} {{schema}} {{source_identity}} {{today}} {{purpose_context}} {{index_context}} {{overview_context}} {{来源摘要生成要求}} {{独立页面写作规则}}")
    await writeFileRaw(`${project.path}/prompts/02-02-独立页面写作规则.md`, "按主题保留事实。")
    generation = `---FILE: ${oldPath}---\n${oldPage}\n---END FILE---`
    await ingest(12000)
    const chunkPrompts = prompts.filter((prompt) => prompt.includes("CUSTOM_CHUNK_TEMPLATE"))
    expect(chunkPrompts.length).toBeGreaterThan(1)
    expect(chunkPrompts.every((prompt) => prompt.includes("## Updated Global Digest"))).toBe(true)
    expect(chunkPrompts.every((prompt) => !prompt.includes("- New or updated entities"))).toBe(true)
    expect(await fileExists(`${project.path}/${oldPath}`)).toBe(true)
  })

  it("分析策略变化使完成缓存失效，清除缓存后仍使用最新配置", async () => {
    await ingest()
    await writeFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`, "CUSTOM_REANALYSIS_POLICY")
    await ingest()
    expect(prompts).toHaveLength(4)
    await removeFromIngestCache(project.path, "incoming.md")
    await ingest()
    expect(prompts).toHaveLength(6)
    expect(prompts[4]).toContain("CUSTOM_REANALYSIS_POLICY")
  })

  it("已有路径直接写完整稿，原合并策略不再触发二次正文生成", async () => {
    generation = `---FILE: ${oldPath}---\n${oldPage}\n\npager 定义分页参数，conditions 定义查询条件。\n---END FILE---`
    await writeFileRaw(`${project.path}/prompts/04-02-页面内容合并规则.md`, "CUSTOM_MERGE_POLICY")
    await writeFileRaw(`${project.path}/prompts/04-01-页面合并任务.md`, DEFAULT_INGEST_PROMPTS.mergeTemplate.replace(
      "You are merging source-backed material", "You are merging CUSTOM_MERGE_TEMPLATE",
    ))
    await ingest()
    expect(prompts).toHaveLength(2)
    expect(prompts.some((prompt) => prompt.includes("CUSTOM_MERGE_POLICY"))).toBe(false)
    expect(requests[1]).toContain("fields 定义查询字段")
    const saved = await readFileRaw(`${project.path}/${oldPath}`)
    expect(saved).toContain("fields 定义查询字段")
    expect(saved).toContain("pager 定义分页参数")
    expect(parseFrontmatter(saved).frontmatter?.sources).toEqual(["old.md", "incoming.md"])
    expect(await fileExists(`${project.path}/${newPath}`)).toBe(false)
  })

  it("模块分类和审查建议沿用原调用阶段，加载各自的项目策略", async () => {
    const schema = await readFileRaw(`${project.path}/schema.md`)
    await writeFileRaw(`${project.path}/schema.md`, `${schema}\n## Business Modules\n\`\`\`json\n{"version":1,"modules":[{"id":"query","name":"查询","description":"查询模型"}]}\n\`\`\`\n`)
    await writeFileRaw(`${project.path}/prompts/05-02-业务模块选择规则.md`, "CUSTOM_CLASSIFICATION_POLICY")
    await writeFileRaw(`${project.path}/prompts/03-02-待审查事项筛选规则.md`, "CUSTOM_REVIEW_POLICY")
    await writeFileRaw(`${project.path}/prompts/05-01-业务模块分类.md`, `CUSTOM_MODULE_TEMPLATE\n${DEFAULT_INGEST_PROMPTS.classificationTemplate}`)
    await writeFileRaw(`${project.path}/prompts/03-01-待审查事项分析.md`, `CUSTOM_REVIEW_TEMPLATE\n${DEFAULT_INGEST_PROMPTS.reviewTemplate}`)
    await writeFileRaw(`${project.path}/prompts/02-03-研究搜索词生成规则.md`, "CUSTOM_RESEARCH_QUERY_POLICY")
    await writeFileRaw(`${project.path}/prompts/03-03-待审查事项分析请求.md`, "CUSTOM_REVIEW_REQUEST")
    generation += `\n---FILE: wiki/sources/incoming.md---\n---\ntype: source\ntitle: 输入资料\nsources: [incoming.md]\n---\n${"来源证据。".repeat(2200)}\n---END FILE---`
    await ingest()
    expect(prompts.some((prompt) => prompt.includes("CUSTOM_CLASSIFICATION_POLICY") && prompt.includes("moduleIds"))).toBe(true)
    expect(prompts.some((prompt) => prompt.includes("CUSTOM_REVIEW_POLICY") && prompt.includes("---END REVIEW---"))).toBe(true)
    expect(prompts.some((prompt) => prompt.includes("CUSTOM_MODULE_TEMPLATE") && prompt.includes("CUSTOM_CLASSIFICATION_POLICY"))).toBe(true)
    expect(prompts.some((prompt) => prompt.includes("CUSTOM_REVIEW_TEMPLATE") && prompt.includes("CUSTOM_RESEARCH_QUERY_POLICY"))).toBe(true)
    expect(requests).toContain("CUSTOM_REVIEW_REQUEST")
  })
})
