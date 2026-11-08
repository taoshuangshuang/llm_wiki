/** 验证提示词配置接入真实入库链路，同时保持原有模型调用、缓存和文件写入行为。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { parseFrontmatter } from "./frontmatter"
import { referenceContextFromFiles } from "@/test-helpers/reference-context"
import { streamChat } from "./llm-client"

vi.mock("@/commands/fs", () => realFs)
// 原生关系索引使用真实临时文件适配，避免 Node 环境尝试调用桌面 IPC。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command, args) => {
  if (command === "wiki_reference_context") return referenceContextFromFiles(args)
  throw new Error(`本组测试未配置原生命令：${command}`)
}) }))
// 本组验证生成和写入协议；统一审阅入口及串行交接由专门场景集成测试覆盖。
vi.mock("./ingest-review", () => ({ runIngestReview: vi.fn(async (path: string, runId: string) => { await updateIngestRun(path, runId, (run) => { run.reviewRequested = false; run.reviewStatus = "complete" }) }) }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
// 本组聚焦既有提示词阶段；最终验收的真实接入由 ingest-acceptance.integration.test.ts 覆盖。
vi.mock("./ingest-acceptance", () => ({
  runIngestAcceptance: vi.fn(async () => ({ report: { status: "passed", rounds: [] }, reviews: [] })),
}))

import { beginIngestRun, listIngestRuns, updateIngestRun } from "./ingest-run"
import { loadProjectIngestPrompts } from "./ingest-prompts"
import { autoIngest } from "./ingest"
import { checkIngestCache, removeFromIngestCache } from "./ingest-cache"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { DEFAULT_INGEST_PROMPTS } from "./ingest-prompts"
import { writeProjectSchema } from "./project-schema"
import { runIngestAcceptance } from "./ingest-acceptance"

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
    if (system.startsWith("核对新知识页和候选页")) {
      response = JSON.stringify({ decisions: JSON.parse(String(messages[1].content)).candidates.map((page: { path: string }) => ({ path: page.path, verdict: "same" })) })
    } else if (system.includes("generate wiki files")) response = generation
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
  it.each([
    ["Can't-expand-DataType-问题排查", "Cant-expand-DataType-问题排查"],
    ['"DataType"-问题排查', "DataType-问题排查"],
    ["DataType:定义?", "DataType-定义-"],
    ["DataType\u200b-问题排查", "DataType-问题排查"],
  ])("模型文件名 %s 修正后完成知识页写入并交接审阅", async (name, expected) => {
    // 复现真实失败：模型已返回完整正文，文件名直接沿用 Can't。
    const title = name
    const path = `wiki/references/${expected}.md`
    generation = `---FILE: wiki/references/${name}.md---\n---\ntype: reference\ntitle: ${JSON.stringify(title)}\n---\n# ${title}\n\nCan't expand DataType 报错时，根据实体 URI 与属性类型定位问题。\n---END FILE---`
    const written = await ingest()
    expect(written).toContain(path)
    expect(await readFileRaw(`${project.path}/${path}`)).toContain(`# ${title}`)
    expect(await fileExists(`${project.path}/wiki/references/${name}.md`)).toBe(false)
    const [run] = await listIngestRuns(project.path)
    expect(run).toMatchObject({ writeStatus: "complete", reviewStatus: "complete" })
    expect(run.pages[path]).toBeDefined()
  })

  it("重试旧任务时重新生成，不能重放旧规则留下的日志和合并建议", async () => {
    const legacy = await beginIngestRun(project.path, "prompt-config", "raw/sources/incoming.md", "incoming.md", "QuerySchema 查询模型说明。")
    await updateIngestRun(project.path, legacy.runId, (state) => {
      state.writeStatus = "failed"
      state.generation = { raw: "---FILE: wiki/log.md---\nOLD_GENERATION_ONLY_LOG\n---END FILE---", analysis: "因已有页而不生成", sourceContext: "QuerySchema 查询模型说明。", incomplete: false }
    })
    await ingest()
    expect(prompts).toHaveLength(2)
    const latest = (await listIngestRuns(project.path))[0]
    expect(latest.writeStatus).toBe("complete")
    expect(latest.runId).not.toBe(legacy.runId)
    expect(latest.documentRunId).toBeDefined()
    expect(await readFileRaw(`${project.path}/${newPath}`)).toContain("pager 定义分页参数")
    expect(await readFileRaw(`${project.path}/wiki/log.md`)).not.toContain("OLD_GENERATION_ONLY_LOG")
  })

  it("分析和生成隔离旧库目录，后续主题核对与合并仍读取旧正文", async () => {
    // 用只存在于旧库的哨兵识别材料泄漏；来源只有查询模型说明。
    await writeFileRaw(`${project.path}/wiki/index.md`, "- [[ONLY_IN_EXISTING_INDEX]]")
    await writeFileRaw(`${project.path}/wiki/overview.md`, "ONLY_IN_EXISTING_OVERVIEW")
    generation = `---FILE: ${oldPath}---\n${incoming.replace(/QuerySchema模型说明/g, "QuerySchema模型")}\n---END FILE---`
    await ingest()
    for (const material of [...prompts.slice(0, 2), ...requests.slice(0, 2)]) {
      expect(material).not.toContain("ONLY_IN_EXISTING_INDEX")
      expect(material).not.toContain("ONLY_IN_EXISTING_OVERVIEW")
      expect(material).not.toContain("fields 定义查询字段")
    }
    expect(requests.slice(2).join("\n")).toContain("fields 定义查询字段")
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toContain("pager 定义分页参数")
  })

  it("仅日志和合并建议不能成功入库；人工重试会重新生成并合并已有页", async () => {
    // 复现真实任务：模型声明应合并，但实际只有日志 FILE 和 duplicate REVIEW。
    generation = `---FILE: wiki/log.md---\n## [2026-10-25] ingest | 建议合并查询模型\n---END FILE---\n---REVIEW: duplicate | 应补充已有页面---\n补充到已有查询模型页面。\nPAGES: ${oldPath}\n---END REVIEW---`
    await expect(ingest()).rejects.toThrow("未生成有效知识页面")
    const [failed] = await listIngestRuns(project.path)
    expect(failed).toMatchObject({ writeStatus: "failed", reviewRequested: false, pages: {} })
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toBe(oldPage)

    // 改正模型输出后，同一来源仍能重试，且保留旧事实与双方来源。
    generation = `---FILE: ${oldPath}---\n${incoming.replace(/QuerySchema模型说明/g, "QuerySchema模型")}\n---END FILE---`
    await ingest()
    const [completed] = await listIngestRuns(project.path)
    expect(completed).toMatchObject({ runId: failed.runId, writeStatus: "complete", reviewRequested: false })
    expect(Object.keys(completed.pages)).toEqual([oldPath])
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toContain("fields 定义查询字段")
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toContain("pager 定义分页参数")
  })

  it("历史日志成功缓存即使哈希匹配也不能命中", async () => {
    // 直接落盘旧格式，避免新缓存写入规则掩盖历史兼容问题。
    const contract = "old-contract"
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["原文", contract])))
    await writeFileRaw(`${project.path}/wiki/log.md`, "仅有日志")
    await writeFileRaw(`${project.path}/.llm-wiki/ingest-cache.json`, JSON.stringify({ entries: {
      "incoming.md": { hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""), timestamp: 0, filesWritten: ["wiki/log.md"] },
    } }))
    expect(await checkIngestCache(project.path, "incoming.md", "原文", contract)).toBeNull()
  })

  it("自定义上下文标题生效，模型请求不再携带代码追加的提示文字", async () => {
    await writeFileRaw(`${project.path}/wiki/index.md`, "- [[QuerySchema模型]]")
    await writeFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`, DEFAULT_INGEST_PROMPTS.analysisTemplate.replace(
      "## Project Schema (page types available — map source content to schema-defined types when it fits)", "## CUSTOM_SCHEMA_LABEL",
    ))
    await writeFileRaw(`${project.path}/prompts/02-01-Wiki页面生成.md`, DEFAULT_INGEST_PROMPTS.generationTemplate.replace(
      /^- 正文笔记链接[^\n]+/m, "CUSTOM_LINK_RULE",
    ))
    await ingest()
    expect(prompts[0]).toContain("## CUSTOM_SCHEMA_LABEL")
    expect(prompts[0]).not.toContain("## Current Wiki Index")
    expect(prompts[1]).toContain("CUSTOM_LINK_RULE")
    expect(prompts[1]).not.toContain("正文笔记链接使用 [[实际文件名]]")
    expect(JSON.parse(requests[0])).toEqual({ source_identity: "incoming.md", source: "QuerySchema 查询模型说明。" })
    expect(JSON.parse(requests[1])).toMatchObject({ source_identity: "incoming.md", completed_paths: [],
      analysis: "QuerySchema 查询模型分析。", source: "QuerySchema 查询模型说明。" })
  })

  it.each(["legacy", "split"])("%s schema 按阶段使用规范，独立模块字典仍参与最终分类", async (format) => {
    const schema = `${await readFileRaw(`${project.path}/schema.md`)}\n## Custom Policy\nKEEP_CUSTOM_CONSTRAINT\n\n## Frontmatter\nKEEP_REQUIRED_FIELD\n\n## Business Modules\n\`\`\`json\n{"version":1,"modules":[{"id":"query","name":"Query","description":"ONLY_MODULE_BOUNDARY"}]}\n\`\`\``
    if (format === "split") await writeProjectSchema(project.path, schema)
    else await writeFileRaw(`${project.path}/schema.md`, schema)
    await ingest()
    const analysis = prompts.find((prompt) => prompt.includes("## Key Entities"))!
    const generation = prompts.find((prompt) => prompt.includes("generate wiki files"))!
    const classification = prompts.find((prompt) => prompt.includes("业务模块分类器"))!
    expect(analysis).toContain("KEEP_CUSTOM_CONSTRAINT")
    expect(analysis).not.toContain("KEEP_REQUIRED_FIELD")
    expect(analysis).not.toContain("ONLY_MODULE_BOUNDARY")
    expect(generation).toContain("KEEP_REQUIRED_FIELD")
    expect(generation).not.toContain("ONLY_MODULE_BOUNDARY")
    expect(classification).toContain("ONLY_MODULE_BOUNDARY")
    expect(classification).not.toContain("KEEP_REQUIRED_FIELD")
    expect(runIngestAcceptance).not.toHaveBeenCalled()
    expect((await listIngestRuns(project.path))[0].reviewRequested).toBe(false)
    expect(parseFrontmatter(await readFileRaw(`${project.path}/${newPath}`)).frontmatter?.tags).toContain("module/query")
  })

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
      "{{独立页面写作规则}}",
      "{{purpose_context}}", "{{index_context}}", "{{overview_context}}",
      DEFAULT_INGEST_PROMPTS.generationTemplate.slice(DEFAULT_INGEST_PROMPTS.generationTemplate.indexOf("## 输出协议")),
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
    await writeFileRaw(`${project.path}/wiki/index.md`, "ONLY_IN_EXISTING_INDEX")
    await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "# 查询模型\n\n查询模型的技术说明。\n\n".repeat(3000))
    await writeFileRaw(`${project.path}/prompts/01-02-长文分块分析.md`, [
      "You are analyzing a long source. CUSTOM_CHUNK_TEMPLATE",
      "Do not output chain-of-thought, hidden reasoning, or a thinking transcript.", "{{language_rule}}", "Output exactly two markdown sections:",
      "## Chunk Analysis", "按 schema 判断候选页类型，解释分类依据。", "## Updated Global Digest",
      "{{独立成页与名称复用规则}}", "{{purpose_context}}", "{{schema_context}}", "{{index_context}}",
    ].join("\n"))
    await ingest(4096)
    const chunkPrompts = prompts.filter((prompt) => prompt.includes("CUSTOM_CHUNK_TEMPLATE"))
    expect(chunkPrompts.length).toBeGreaterThan(1)
    expect(chunkPrompts.every((prompt) => prompt.includes("## Updated Global Digest"))).toBe(true)
    expect(chunkPrompts.every((prompt) => !prompt.includes("- New or updated entities"))).toBe(true)
    expect(chunkPrompts.every((prompt) => !prompt.includes("ONLY_IN_EXISTING_INDEX"))).toBe(true)
    expect(await fileExists(`${project.path}/${newPath}`)).toBe(true)
  })

  it("修改分析规则使旧生成缓存失效，来源重新分析后才保存新结果", async () => {
    await ingest()
    await writeFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`, "CUSTOM_REANALYSIS_POLICY")
    await ingest()
    expect(prompts).toHaveLength(4)
    expect(prompts[2]).toContain("CUSTOM_REANALYSIS_POLICY")
    await removeFromIngestCache(project.path, "incoming.md")
    await ingest()
    expect(prompts).toHaveLength(6)
    expect(prompts[4]).toContain("CUSTOM_REANALYSIS_POLICY")
  })

  it("已有路径沿用原合并机制，并读取项目配置的正文合并策略", async () => {
    generation = `---FILE: ${oldPath}---\n${incoming.replace(/QuerySchema模型说明/g, "QuerySchema模型")}\n---END FILE---`
    await writeFileRaw(`${project.path}/prompts/04-02-页面内容合并规则.md`, "CUSTOM_MERGE_POLICY")
    await writeFileRaw(`${project.path}/prompts/04-01-页面合并任务.md`, DEFAULT_INGEST_PROMPTS.mergeTemplate.replace(
      "You are merging source-backed material", "You are merging CUSTOM_MERGE_TEMPLATE",
    ))
    await ingest()
    expect(prompts).toHaveLength(4)
    expect(prompts[3]).toContain("CUSTOM_MERGE_POLICY")
    expect(prompts[3]).toContain("CUSTOM_MERGE_TEMPLATE")
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
    expect(prompts.some((prompt) => prompt.includes("CUSTOM_REVIEW_POLICY") && prompt.includes("---END REVIEW---"))).toBe(false)
    expect(prompts.some((prompt) => prompt.includes("CUSTOM_MODULE_TEMPLATE") && prompt.includes("CUSTOM_CLASSIFICATION_POLICY"))).toBe(true)
    const policies = await loadProjectIngestPrompts(project.path)
    expect(policies.reviewTemplate).toContain("CUSTOM_REVIEW_TEMPLATE")
    expect(policies.review).toBe("CUSTOM_REVIEW_POLICY")
    expect(requests).not.toContain("CUSTOM_REVIEW_REQUEST")
    expect((await listIngestRuns(project.path))[0].reviewRequested).toBe(false)
  })
})
