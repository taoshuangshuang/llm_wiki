/** 项目提示词作为可编辑配置：验证默认值、项目覆盖和缺省恢复，不依赖真实模型。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { DEFAULT_INGEST_PROMPTS, initializeProjectIngestPrompts, loadProjectIngestPrompts, renderIngestPromptTemplate } from "./ingest-prompts"
import { buildAnalysisPrompt, buildGenerationPrompt, buildPageMergeSystemPrompt } from "./ingest"

let project: Awaited<ReturnType<typeof createTempProject>> | undefined
afterEach(async () => { await project?.cleanup(); project = undefined })

describe("项目级入库提示词", () => {
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
    const generation = buildGenerationPrompt("## Page Types", "", "", "source.md", undefined, "", undefined, "CUSTOM_GENERATION_POLICY")
    const merge = buildPageMergeSystemPrompt("CUSTOM_MERGE_POLICY")
    expect(analysis).toContain("CUSTOM_ANALYSIS_POLICY")
    expect(generation).toContain("CUSTOM_GENERATION_POLICY")
    expect(merge).toContain("CUSTOM_MERGE_POLICY")
    expect(analysis).not.toContain(DEFAULT_INGEST_PROMPTS.analysis.trim())
    expect(generation).not.toContain(DEFAULT_INGEST_PROMPTS.generation.trim())
    expect(merge).not.toContain(DEFAULT_INGEST_PROMPTS.merge.trim())
    expect(generation).toContain("---END FILE---")
    expect(generation).toContain("frontmatter type must match the schema directory")
    expect(merge).toContain("Output the COMPLETE file: YAML frontmatter + body")
  })
})
