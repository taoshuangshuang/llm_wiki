/** 项目提示词作为可编辑配置：验证默认值、项目覆盖和缺省恢复，不依赖真实模型。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { DEFAULT_INGEST_PROMPTS, initializeProjectIngestPrompts, loadProjectIngestPrompts, renderIngestPromptTemplate } from "./ingest-prompts"
import { buildAnalysisPrompt, buildGenerationPrompt, buildPageMergeSystemPrompt, buildChunkAnalysisSystemPrompt, buildReviewSuggestionPrompt, buildTruncatedFileRepairPrompt, parseFileBlocks } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let project: Awaited<ReturnType<typeof createTempProject>> | undefined
afterEach(async () => { await project?.cleanup(); project = undefined })

describe("项目级入库提示词", () => {
  it("生成、修复和会话模板的完整示例均可被真实 FILE 解析器接收", () => {
    // 验证模型会照抄的协议样例：YAML 与文件结束标记均处于代码围栏之外。
    const prompts = [
      buildGenerationPrompt("", "", "", "source.md"),
      buildTruncatedFileRepairPrompt(["wiki/concepts/example.md"], "source.md", {
        schema: "", purpose: "", analysis: "", sourceContext: "", maxContextSize: 128000,
      }).system,
      renderIngestPromptTemplate(DEFAULT_INGEST_PROMPTS.interactiveGenerationTemplate, {
        language_rule: "Chinese", schema: "", source_identity: "source.md",
      }),
    ]
    for (const prompt of prompts) {
      expect(prompt).not.toContain("```")
      const sample = prompt.match(/^---FILE: .+---\n[\s\S]*?^---END FILE---$/m)?.[0]
      expect(sample).toBeDefined()
      const parsed = parseFileBlocks(sample!)
      expect(parsed.blocks).toHaveLength(1)
      expect(parsed.truncatedPaths).toEqual([])
      expect(parsed.warnings).toEqual([])
      expect(parsed.blocks[0].content).toMatch(/^---\ntype:/)
      expect(parsed.blocks[0].content).toContain("sources:")
    }
  })

  it("新导入不提供完成标记分支，续传只跳过已完成路径", () => {
    const fresh = buildGenerationPrompt("", "", "", "source.md")
    const resumed = buildGenerationPrompt("", "", "", "source.md", "", "", undefined, undefined, ["wiki/concepts/done.md"])
    expect(fresh).not.toContain("---RESUME COMPLETE---")
    expect(resumed).toContain("wiki/concepts/done.md")
    expect(resumed).toContain("---RESUME COMPLETE---")
    expect(resumed).toContain("仅当所有所需页面均已完成时")
  })


  it("已迁移的新模板不含 index_context 时，分析、分块和生成均可正常启动", async () => {
    project = await createTempProject("source-only-template-contract")
    const analysisTemplate = "用户分析规则\n{{language_rule}}\n{{schema_context}}\n{{purpose_context}}\n{{独立成页与名称复用规则}}"
    const generationTemplate = "用户生成规则\n{{language_rule}}\n{{schema}}\n{{purpose_context}}\n{{source_identity}}\n{{today}}\n{{独立页面写作规则}}"
    await writeFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`, analysisTemplate)
    await writeFileRaw(`${project.path}/prompts/01-02-长文分块分析.md`, analysisTemplate)
    await writeFileRaw(`${project.path}/prompts/02-01-Wiki页面生成.md`, generationTemplate)
    const prompts = await loadProjectIngestPrompts(project.path)
    const analysis = buildAnalysisPrompt("PURPOSE", "旧目录不应注入", "来源正文", "SCHEMA", prompts.analysis, prompts.analysisTemplate)
    const chunk = buildChunkAnalysisSystemPrompt("PURPOSE", "SCHEMA", "旧目录不应注入", "来源正文", prompts.analysis, prompts.chunkAnalysisTemplate)
    const generation = buildGenerationPrompt("SCHEMA", "PURPOSE", "旧目录不应注入", "source.md", "", "来源正文", prompts.generation, prompts.generationTemplate)
    for (const output of [analysis, chunk, generation]) {
      expect(output).toContain("PURPOSE")
      expect(output).toContain("SCHEMA")
      expect(output).not.toContain("旧目录不应注入")
      expect(output).not.toContain("{{index_context}}")
    }
    expect(generation).toContain("source.md")
    expect(await readFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`)).toBe(analysisTemplate)
  })

  it("统一主题模板继承旧相似模板，保留历史文件，新名存在后优先读取新名", async () => {
    project = await createTempProject("unified-topic-prompt")
    const legacy = `${project.path}/prompts/04-03-相似页面主题核对.md`
    const current = `${project.path}/prompts/04-03-页面主题核对.md`
    await writeFileRaw(legacy, "自定义主题核对规则，输出 decisions。")
    await writeFileRaw(`${project.path}/prompts/04-04-同名页面主题核对.md`, "历史同名模板，输出 sameTopic。")
    expect((await loadProjectIngestPrompts(project.path)).pageMatchTemplate).toBe("自定义主题核对规则，输出 decisions。")
    await initializeProjectIngestPrompts(project.path)
    expect(await readFileRaw(current)).toBe("自定义主题核对规则，输出 decisions。")
    expect(await readFileRaw(legacy)).toBe("自定义主题核对规则，输出 decisions。")
    await writeFileRaw(current, "新的统一核对规则。")
    const prompts = await loadProjectIngestPrompts(project.path)
    expect(prompts.pageMatchTemplate).toBe("新的统一核对规则。")
    expect(prompts).not.toHaveProperty("sameNameMatchTemplate")
  })

  it("旧模板迁移先预览并保留业务原文，写入备份后可重复执行", async () => {
    project = await createTempProject("prompt-context-migration")
    const script = fileURLToPath(new URL("../../scripts/materialize-ingest-prompt-contexts.mjs", import.meta.url))
    const original = "自定义业务要求：保留注释与精确的 SQL。\n{{language_rule}}\n{{#schema_context}}\n## 自定义页面规范\n{{schema_context}}\n{{/schema_context}}\n{{purpose_context}}\n{{index_context}}\n{{独立成页与名称复用规则}}\n"
    const target = `${project.path}/prompts/01-01-来源文档分析.md`
    await writeFileRaw(target, original)
    // 旧项目里的摘要开关和路径引用必须显式迁移，避免新版渲染时留下未知变量。
    const generationTarget = `${project.path}/prompts/02-01-Wiki页面生成.md`
    const oldGeneration = DEFAULT_INGEST_PROMPTS.generationTemplate.replace(
      "仅生成知识页和入库日志，不生成 type: source 或 wiki/sources/ 来源摘要页；知识页 sources 直接引用原始文档。",
      "{{#来源摘要生成要求}}\n如生成来源摘要，使用 {{summary_path}}。\n{{/来源摘要生成要求}}\n{{#来源摘要关闭}}\n不生成来源摘要，知识页 sources 引用原文。\n{{/来源摘要关闭}}",
    )
    await writeFileRaw(generationTarget, oldGeneration)
    const preview = JSON.parse(execFileSync(process.execPath, [script, project.path], { encoding: "utf8" }))
    expect(preview.applied).toBe(false)
    expect(await readFileRaw(target)).toBe(original)
    const applied = JSON.parse(execFileSync(process.execPath, [script, project.path, "--apply"], { encoding: "utf8" }))
    expect(await readFileRaw(`${applied.backup}/01-01-来源文档分析.md`)).toBe(original)
    const migrated = await readFileRaw(target)
    expect(migrated).toContain("自定义业务要求：保留注释与精确的 SQL。")
    expect(migrated).not.toContain("## 已有知识库目录")
    expect(migrated).not.toContain("{{index_context}}")
    expect(migrated).toContain("MANDATORY OUTPUT LANGUAGE: {{language_rule}}")
    expect(migrated).toContain("{{独立成页与名称复用规则}}")
    expect(migrated).toContain("## 自定义页面规范\n{{schema_context}}")
    expect(migrated).not.toMatch(/\{\{[#/](?:schema_context|purpose_context|index_context)\}\}/)
    const generation = await readFileRaw(generationTarget)
    expect(generation).not.toMatch(/\{\{[^{}]*(?:来源摘要生成要求|来源摘要关闭|summary_path)[^{}]*\}\}/)
    expect(generation).toContain("知识页 sources 引用原文")
    expect(await readFileRaw(`${applied.backup}/02-01-Wiki页面生成.md`)).toBe(oldGeneration)
    const repeated = JSON.parse(execFileSync(process.execPath, [script, project.path], { encoding: "utf8" }))
    expect(repeated.updated).toEqual([])
    expect(repeated.created).toEqual([])
  })

  it("分析兼容旧目录变量但不注入已有库，审阅仍可读取目录", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const analysisTemplate = "{{language_rule}}|{{schema_context}}|{{purpose_context}}|{{index_context}}"
    expect(buildAnalysisPrompt("PURPOSE", "INDEX", "", "SCHEMA", "", analysisTemplate))
      .toBe("English|SCHEMA|PURPOSE|")
    expect(buildChunkAnalysisSystemPrompt("PURPOSE", "SCHEMA", "INDEX", "", "", analysisTemplate))
      .toBe("English|SCHEMA|PURPOSE|")
    const reviewTemplate = "{{language_rule}}|{{purpose_context}}|{{index_context}}|{{source_context}}|{{analysis}}|{{source}}|{{generation}}"
    expect(buildReviewSuggestionPrompt("PURPOSE", "INDEX", "source.md", "ANALYSIS", "SOURCE", "GENERATION", 128000, "", reviewTemplate))
      .toBe("English|PURPOSE|INDEX|source.md|ANALYSIS|SOURCE|GENERATION")
  })

  it("生成阶段不在自定义模板外追加链接、语言、摘要或续传指令", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const template = "{{language_rule}}|{{schema}}|{{purpose_context}}|{{index_context}}|{{overview_context}}|{{source_identity}}|{{today}}"
    const prompt = buildGenerationPrompt("SCHEMA", "PURPOSE", "INDEX", "source.md", "OVERVIEW", "", "", template)
    expect(prompt).toMatch(/^English\|SCHEMA\|PURPOSE\|\|\|source\.md\|\d{4}-\d{2}-\d{2}$/)
  })

  it("截断补写的完整指令可替换，用户消息仅含预算内的数据", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const prompt = buildTruncatedFileRepairPrompt(["wiki/concepts/a.md"], "source.md", {
      schema: "SCHEMA", purpose: "PURPOSE", analysis: "ANALYSIS", sourceContext: "SOURCE", maxContextSize: 128000,
    }, "CUSTOM_REPAIR {{language_rule}}")
    expect(prompt.system).toBe("CUSTOM_REPAIR English")
    expect(JSON.parse(prompt.user)).toEqual({ paths: ["wiki/concepts/a.md"], source_identity: "source.md",
      schema: "SCHEMA", purpose: "PURPOSE", analysis: "ANALYSIS", source: "SOURCE" })
  })

  it("首次加载提供可直接编辑的默认 Markdown 文件", async () => {
    project = await createTempProject("ingest-prompts")
    await initializeProjectIngestPrompts(project.path)
    const policies = await loadProjectIngestPrompts(project.path)
    expect(policies).toEqual(DEFAULT_INGEST_PROMPTS)
    expect(policies).not.toHaveProperty("caption")
    expect(policies).not.toHaveProperty("captionTemplate")
    expect(await readFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`)).toBe(DEFAULT_INGEST_PROMPTS.analysis)
    expect(await readFileRaw(`${project.path}/prompts/04-02-页面内容合并规则.md`)).toBe(DEFAULT_INGEST_PROMPTS.merge)
    expect(await readFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`)).toBe(DEFAULT_INGEST_PROMPTS.analysisTemplate)
    expect(await readFileRaw(`${project.path}/prompts/01-02-长文分块分析.md`)).toBe(DEFAULT_INGEST_PROMPTS.chunkAnalysisTemplate)
  })

  it("每次读取用户修改后的文件，不覆盖用户配置，空文件使用默认策略", async () => {
    project = await createTempProject("ingest-prompts")
    await writeFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`, "只收录源码已验证的知识。")
    await writeFileRaw(`${project.path}/prompts/02-02-独立页面写作规则.md`, "同主题同用途的内容合并到已有页。")
    await writeFileRaw(`${project.path}/prompts/04-02-页面内容合并规则.md`, " ")
    await writeFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`, "CUSTOM_ANALYSIS_TEMPLATE")
    await initializeProjectIngestPrompts(project.path)
    const first = await loadProjectIngestPrompts(project.path)
    expect(first.analysis).toBe("只收录源码已验证的知识。")
    expect(first.generation).toBe("同主题同用途的内容合并到已有页。")
    expect(first.merge).toBe(DEFAULT_INGEST_PROMPTS.merge)
    expect(first.analysisTemplate).toBe("CUSTOM_ANALYSIS_TEMPLATE")
    expect(await readFileRaw(`${project.path}/prompts/04-02-页面内容合并规则.md`)).toBe(" ")
    await writeFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`, "增加证据与版本边界检查。")
    expect((await loadProjectIngestPrompts(project.path)).analysis).toBe("增加证据与版本边界检查。")
  })

  it("模板单次展开上下文，保留来源中的占位符与特殊字符", () => {
    const template = "{{#schema}}\nSchema:\n{{schema}}\n{{/schema}}\n{{source}}\n{{optional}}"
    expect(renderIngestPromptTemplate(template, {
      schema: "结构说明", source: "来源中含 {{schema}} 和 $&", optional: "",
    })).toBe("Schema:\n结构说明\n来源中含 {{schema}} 和 $&")
    expect(renderIngestPromptTemplate(template, {
      schema: "", source: "来源正文", optional: "",
    })).toBe("来源正文")
  })

  it("按文件用途引用中文规则，保留规则原文中的占位符并检查未知引用", () => {
    const template = "{{#独立成页与名称复用规则}}\n规则：{{独立成页与名称复用规则}}\n{{/独立成页与名称复用规则}}"
    expect(renderIngestPromptTemplate(template, {
      独立成页与名称复用规则: "复用已有名称，原文含 {{schema}} 和 $&。",
    })).toBe("规则：复用已有名称，原文含 {{schema}} 和 $&。")
    expect(renderIngestPromptTemplate(template, { 独立成页与名称复用规则: "" })).toBe("")
    expect(() => renderIngestPromptTemplate("{{不存在的规则}}", {})).toThrow("未知变量")
  })

  it("旧名配置继续可读，补齐新名时继承原文，新旧并存时新名优先", async () => {
    project = await createTempProject("ingest-prompt-rename")
    await writeFileRaw(`${project.path}/prompts/analysis.md`, "旧项目的自定义规则。\n")
    await writeFileRaw(`${project.path}/prompts/page-merge.md`, " ")
    expect((await loadProjectIngestPrompts(project.path)).analysis).toBe("旧项目的自定义规则。\n")

    await initializeProjectIngestPrompts(project.path)
    expect(await readFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`)).toBe("旧项目的自定义规则。\n")
    expect(await readFileRaw(`${project.path}/prompts/analysis.md`)).toBe("旧项目的自定义规则。\n")
    expect(await readFileRaw(`${project.path}/prompts/04-02-页面内容合并规则.md`)).toBe(" ")
    expect((await loadProjectIngestPrompts(project.path)).merge).toBe(DEFAULT_INGEST_PROMPTS.merge)

    await writeFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`, "新名文件的规则。")
    await writeFileRaw(`${project.path}/prompts/analysis.md`, "旧名文件后续修改。")
    await initializeProjectIngestPrompts(project.path)
    expect((await loadProjectIngestPrompts(project.path)).analysis).toBe("新名文件的规则。")
    await writeFileRaw(`${project.path}/prompts/01-03-独立成页与名称复用规则.md`, " ")
    expect((await loadProjectIngestPrompts(project.path)).analysis).toBe(DEFAULT_INGEST_PROMPTS.analysis)
  })

  it("兼容无序号中文名称，读取与补齐时优先于原英文名称", async () => {
    project = await createTempProject("ingest-prompt-numbering")
    await writeFileRaw(`${project.path}/prompts/analysis-template.md`, "原英文名配置。")
    await writeFileRaw(`${project.path}/prompts/来源文档分析.md`, "无序号中文配置。\n")
    expect((await loadProjectIngestPrompts(project.path)).analysisTemplate).toBe("无序号中文配置。\n")

    await initializeProjectIngestPrompts(project.path)
    expect(await readFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`)).toBe("无序号中文配置。\n")
    expect(await readFileRaw(`${project.path}/prompts/来源文档分析.md`)).toBe("无序号中文配置。\n")
    await writeFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`, "带序号配置。")
    await initializeProjectIngestPrompts(project.path)
    expect((await loadProjectIngestPrompts(project.path)).analysisTemplate).toBe("带序号配置。")
  })

  it("移除图片配置后兼容之前的阶段序号，并优先于无序号配置", async () => {
    project = await createTempProject("ingest-prompt-stage-rename")
    await writeFileRaw(`${project.path}/prompts/来源文档分析.md`, "无序号配置。")
    await writeFileRaw(`${project.path}/prompts/02-01-来源文档分析.md`, "之前阶段序号的配置。\n")
    expect((await loadProjectIngestPrompts(project.path)).analysisTemplate).toBe("之前阶段序号的配置。\n")
    await initializeProjectIngestPrompts(project.path)
    expect(await readFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`)).toBe("之前阶段序号的配置。\n")
    await writeFileRaw(`${project.path}/prompts/01-01-来源文档分析.md`, "当前配置。")
    expect((await loadProjectIngestPrompts(project.path)).analysisTemplate).toBe("当前配置。")
  })

  it("模板缺失必要上下文、使用未知变量或条件不闭合时给出错误", () => {
    expect(() => renderIngestPromptTemplate("业务规则", { language_rule: "语言要求" }, ["language_rule"]))
      .toThrow("缺少必要变量")
    expect(() => renderIngestPromptTemplate("{{unknown}}", {})).toThrow("未知变量")
    expect(() => renderIngestPromptTemplate("{{#schema}}\n正文", { schema: "结构" })).toThrow("缺少结束标记")
    expect(() => renderIngestPromptTemplate("{{/schema}}", { schema: "结构" })).toThrow("条件未匹配")
  })

  it("业务策略可以替换默认值，默认模板直接包含生成和合并的输出契约", () => {
    const analysis = buildAnalysisPrompt("", "", "", "", "CUSTOM_ANALYSIS_POLICY")
    const generation = buildGenerationPrompt("## Page Types", "", "", "source.md", undefined, "", "CUSTOM_GENERATION_POLICY")
    const merge = buildPageMergeSystemPrompt("CUSTOM_MERGE_POLICY")
    expect(analysis).toContain("CUSTOM_ANALYSIS_POLICY")
    expect(generation).toContain("CUSTOM_GENERATION_POLICY")
    expect(merge).toContain("CUSTOM_MERGE_POLICY")
    expect(analysis).not.toContain(DEFAULT_INGEST_PROMPTS.analysis.trim())
    expect(generation).not.toContain(DEFAULT_INGEST_PROMPTS.generation.trim())
    expect(merge).not.toContain(DEFAULT_INGEST_PROMPTS.merge.trim())
    expect(generation).toContain("---END FILE---")
    expect(generation).toContain("frontmatter type 与 FILE 目录保持一致")
    expect(merge).toContain('"status":"merged"')
    expect(merge).toContain('status="failed"')
  })
})
