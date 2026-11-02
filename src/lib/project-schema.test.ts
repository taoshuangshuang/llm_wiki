/** 验证 Schema 的持久格式及按用途上下文契约，使用真实临时文件而非内部调用顺序。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import cases from "@/test-helpers/fixtures/project-schema.json"

vi.mock("@/commands/fs", () => realFs)

import { loadProjectSchema, splitProjectSchema, writeProjectSchema, migrateProjectSchemaFiles } from "./project-schema"
import { buildAnalysisPrompt, buildChunkAnalysisSystemPrompt, buildGenerationPrompt } from "./ingest"
import { loadProjectWikiSchemaRouting } from "./wiki-schema"
import { parseModuleCatalog } from "@/features/business-modules/catalog"
import { templates } from "./templates"

let project: Awaited<ReturnType<typeof createTempProject>> | undefined
afterEach(async () => { await project?.cleanup(); project = undefined })

const core = "# Schema\n\n## Page Types\n| concept | wiki/concepts/ | Ideas |\n\n## Custom Policy\nCUSTOM_CONSTRAINT"
const rules = "## Frontmatter\nCUSTOM_REQUIRED_FIELD"
const modules = '## Business Modules\n```json\n{"version":1,"modules":[{"id":"query","name":"Query","description":"MODULE_BOUNDARY"}]}\n```'
const legacy = `${core}\n\n${rules}\n\n${modules}\n`

describe("Schema 职责拆分", () => {
  it.each(cases)("$name", ({ input, core, rules, modules }) => {
    expect(splitProjectSchema(input)).toEqual({ core, rules, modules })
  })

  it("旧项目无需改盘，分析、生成、分类各自获得必要规范", async () => {
    project = await createTempProject("schema-legacy")
    await writeFileRaw(`${project.path}/schema.md`, legacy)
    expect(await loadProjectSchema(project.path, "analysis")).toBe(core)
    expect(await loadProjectSchema(project.path, "generation")).toBe(`${core}\n\n${rules}`)
    expect(await loadProjectSchema(project.path, "classification")).toBe(modules)
    expect(await readFileRaw(`${project.path}/schema.md`)).toBe(legacy)
  })

  it("新模板物理拆分后与旧格式得到相同上下文及路由", async () => {
    project = await createTempProject("schema-split")
    await writeProjectSchema(project.path, legacy)
    expect(await readFileRaw(`${project.path}/schema.md`)).toBe(`${core}\n`)
    expect(await readFileRaw(`${project.path}/page-rules.md`)).toBe(`${rules}\n`)
    expect(await loadProjectSchema(project.path, "generation")).toBe(`${core}\n\n${rules}`)
    expect(await loadProjectWikiSchemaRouting(project.path)).toEqual({ typeDirs: { concept: "wiki/concepts" } })
    expect(parseModuleCatalog(await loadProjectSchema(project.path, "classification"))?.byId.has("query")).toBe(true)
  })

  it("独立片段替代对应旧章节，空文件可以显式禁用旧配置", async () => {
    project = await createTempProject("schema-override")
    await writeFileRaw(`${project.path}/schema.md`, legacy)
    await writeFileRaw(`${project.path}/page-rules.md`, "## Frontmatter\nNEW_REQUIRED_FIELD")
    await writeFileRaw(`${project.path}/business-modules.md`, "")
    expect(await loadProjectSchema(project.path, "generation")).toBe(`${core}\n\n## Frontmatter\nNEW_REQUIRED_FIELD`)
    expect(await loadProjectSchema(project.path, "classification")).toBe("")
  })

  it("只读取当前用途的片段，其他片段不可读也不影响分析或分类", async () => {
    project = await createTempProject("schema-lazy")
    await writeFileRaw(`${project.path}/schema.md`, core)
    await realFs.createDirectory(`${project.path}/page-rules.md`)
    await writeFileRaw(`${project.path}/business-modules.md`, modules)
    expect(await loadProjectSchema(project.path, "analysis")).toBe(core)
    expect(await loadProjectSchema(project.path, "classification")).toBe(modules)
    await expect(loadProjectSchema(project.path, "generation")).rejects.toThrow()
  })

  it("根配置缺失时兼容 wiki/schema.md，空根配置不会重新启用旧规则", async () => {
    project = await createTempProject("schema-fallback")
    await writeFileRaw(`${project.path}/wiki/schema.md`, legacy)
    expect(await loadProjectSchema(project.path, "analysis")).toBe(core)
    await writeFileRaw(`${project.path}/schema.md`, "")
    expect(await loadProjectSchema(project.path, "analysis")).toBe("")
  })

  it("旧拆分文件迁入根目录，保留原文且不会覆盖根目录的显式空值", async () => {
    project = await createTempProject("schema-root-migration")
    await writeFileRaw(`${project.path}/schema.md`, legacy)
    await writeFileRaw(`${project.path}/schema/page-rules.md`, rules)
    await writeFileRaw(`${project.path}/schema/business-modules.md`, modules)
    // 迁移前仍能读取旧目录；迁移后根目录成为唯一有效的新配置来源。
    expect(await loadProjectSchema(project.path, "classification")).toBe(modules)
    await migrateProjectSchemaFiles(project.path)
    expect(await readFileRaw(`${project.path}/page-rules.md`)).toBe(rules)
    expect(await readFileRaw(`${project.path}/business-modules.md`)).toBe(modules)
    expect(await readFileRaw(`${project.path}/schema/business-modules.md`)).toBe(modules)
    await writeFileRaw(`${project.path}/business-modules.md`, "")
    await migrateProjectSchemaFiles(project.path)
    expect(await loadProjectSchema(project.path, "classification")).toBe("")
  })

  it("最终分析提示词不含写作规范和分类字典，生成保留自定义约束与字段", () => {
    const analysis = buildAnalysisPrompt("", "", "", legacy)
    const chunk = buildChunkAnalysisSystemPrompt("", legacy, "", "")
    const generation = buildGenerationPrompt(legacy, "", "", "source.md")
    for (const prompt of [analysis, chunk]) {
      expect(prompt).toContain("CUSTOM_CONSTRAINT")
      expect(prompt).not.toContain("CUSTOM_REQUIRED_FIELD")
      expect(prompt).not.toContain("MODULE_BOUNDARY")
    }
    expect(generation).toContain("CUSTOM_REQUIRED_FIELD")
    expect(generation).toContain("CUSTOM_CONSTRAINT")
    expect(generation).not.toContain("MODULE_BOUNDARY")
  })

  it.each(templates)("内置模板 $id 拆分后保留全部类型和写作规则", async (template) => {
    project = await createTempProject("schema-template")
    await writeProjectSchema(project.path, template.schema)
    const parts = splitProjectSchema(template.schema)
    expect(await loadProjectSchema(project.path, "analysis")).toBe(parts.core)
    expect(await loadProjectSchema(project.path, "generation")).toBe([parts.core, parts.rules].filter(Boolean).join("\n\n"))
    expect(await loadProjectSchema(project.path, "classification")).toBe("")
  })
})
