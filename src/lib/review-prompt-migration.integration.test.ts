import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => realFs)
import { DEFAULT_INGEST_PROMPTS } from "./ingest-prompts"
import { applyReviewPromptMigration, previewReviewPromptMigration } from "./review-prompt-migration"

let project: Awaited<ReturnType<typeof createTempProject>>
beforeEach(async () => { project = await createTempProject("review-prompt") })
afterEach(async () => { await project.cleanup() })

describe("后台审阅提示词迁移", () => {
  it("预览不写文件，应用保存备份且不覆盖旧业务规则", async () => {
    const original = "保留 SQL 全文。\n{{source}}\n输出旧 REVIEW 块。"
    await writeFileRaw(`${project.path}/prompts/03-01-待审查事项分析.md`, original)
    const preview = await previewReviewPromptMigration(project.path)
    expect(preview.needsManualReview).toBe(true)
    expect(await realFs.fileExists(`${project.path}/prompts/07-01-统一后台审阅.md`)).toBe(false)
    await expect(applyReviewPromptMigration(project.path, preview.revision, preview.proposed)).rejects.toThrow("自定义规则")
    const rules = `${DEFAULT_INGEST_PROMPTS.backgroundReview}\n业务约束：保留 SQL 全文。`
    const backup = await applyReviewPromptMigration(project.path, preview.revision, rules)
    expect(await readFileRaw(`${backup}/旧审阅模板.md`)).toBe(original)
    expect(await readFileRaw(`${project.path}/prompts/03-01-待审查事项分析.md`)).toBe(original)
    expect(await readFileRaw(`${project.path}/prompts/07-01-统一后台审阅.md`)).toBe(rules)
  })

  it("预览后原规则变化时拒绝应用，防止覆盖后续编辑", async () => {
    const preview = await previewReviewPromptMigration(project.path)
    await writeFileRaw(`${project.path}/prompts/03-01-待审查事项分析.md`, "新的自定义规则")
    await expect(applyReviewPromptMigration(project.path, preview.revision, preview.proposed)).rejects.toThrow("已变化")
  })
  it("合并与内容等项目规则逐份展示差异，预览不静默改写文件", async () => {
    const current = "只保留必要关键事实；保留本项目 SQL 安全约束。"
    await writeFileRaw(`${project.path}/prompts/04-02-页面内容合并规则.md`, current)
    const preview = await previewReviewPromptMigration(project.path)
    expect(preview.changes).toContainEqual({ key: "merge", name: "04-02-页面内容合并规则.md", current, proposed: DEFAULT_INGEST_PROMPTS.merge })
    expect(await readFileRaw(`${project.path}/prompts/04-02-页面内容合并规则.md`)).toBe(current)
  })

})
