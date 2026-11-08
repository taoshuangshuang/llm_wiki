/** 使用真实临时 Wiki 验证映射、历史引用、提交恢复和人工审阅边界，不请求模型。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw, readFileRaw, fileExists } from "@/test-helpers/fs-temp"
import { referenceContextFromFiles } from "@/test-helpers/reference-context"

vi.mock("@/commands/fs", () => realFs)
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (_command, args) => referenceContextFromFiles(args)) }))

import { maintainWikiReferences, inspectWikiReferences, hasWikiSection } from "./wiki-reference-maintenance"
import { inspectStructure } from "./review-checks/format"
import { beginIngestRun, loadIngestRun, contentRevision } from "./ingest-run"
import { repairReviewIssues } from "./ingest-review-repair"
import { useWikiStore } from "@/stores/wiki-store"

let project: Awaited<ReturnType<typeof createTempProject>>
const target = "wiki/concepts/B.md", history = "wiki/concepts/历史.md"
const markdown = (title: string, body: string, related = "[]") => `---\ntype: concept\ntitle: ${title}\nsources: [来源.md]\nrelated: ${related}\n---\n# ${title}\n${body}\n`
beforeEach(async () => {
  project = await createTempProject("reference-maintenance")
  await writeFileRaw(`${project.path}/${target}`, markdown("B", "## 保留章节\n事实。"))
})
afterEach(async () => { vi.restoreAllMocks(); await project.cleanup() })

describe("入库后的全库引用维护", () => {
  it.each(["block", "inline"])("%s related 中的历史双括号引用按实际目标检查，格式问题单独保留", async (style) => {
    // 模拟截图：目标真实存在，related 使用带别名、章节的历史双括号写法。
    const related = style === "block" ? '\n  - "[[concepts/B#保留章节|说明]]"\n  - "[[X]]"' : '["[[concepts/B#保留章节|说明]]", "[[X]]"]'
    const text = markdown("历史", "[[concepts/B#保留章节]]", related)
    const material = { id: "after", path: history, text, revision: await contentRevision(text), startLine: 1, endLine: text.split("\n").length }
    const issues = await inspectWikiReferences(project.path, [material])
    // 只报告真正缺失的 X，不能将 [[ ]] 本身作为目标名称，也不能重复包装错误提示。
    expect(issues.map((issue) => issue.pageEvidence)).toEqual(["X"])
    expect(issues[0].description).toBe("失效引用 [[X]]：目标页面不存在或名称不唯一")
    expect(inspectStructure(history, text, "").map((issue) => issue.description)).toContain("related 必须是页面标识字符串列表，不包含双括号包装或嵌套数组")
  })

  it("章节检查识别行内代码标题、Markdown 锚点和块定位，忽略代码示例", () => {
    const content = "# B\n## 参数 `tenantId`\n## 参数 `tenantId`\n另一个章节\n---\n内容。 ^block\n```md\n## 示例章节\n```"
    for (const anchor of ["参数 tenantId", "参数-tenantid", "参数-tenantid-1", "另一个章节", "^block", "参数　TenantID", " 参数tenantid ", "#另一个章节#", "%E5%8F%A6%E4%B8%80%E4%B8%AA%E7%AB%A0%E8%8A%82"]) expect(hasWikiSection(content, anchor)).toBe(true)
    for (const anchor of ["示例章节", "", "#", "参数"]) expect(hasWikiSection(content, anchor)).toBe(false)
  })
  it("维护历史入链和 related，保留存在的章节、别名，缺失章节退回页面，并跳过代码", async () => {
    const before = markdown("历史", "[[A#保留章节|说明]] [[wiki/concepts/A.md#已移除|旧说明]] [[X]]\n`[[A]]`\n```md\n[[A]]\n```", "[A]")
    await writeFileRaw(`${project.path}/${history}`, before)
    const run = await beginIngestRun(project.path, "test", "raw/sources/来源.md", "来源.md", "事实。")
    const redirects = new Map([["A", target], ["concepts/A", target]])
    expect(await maintainWikiReferences(project.path, [target], redirects, run.runId)).toEqual([history])
    const after = await readFileRaw(`${project.path}/${history}`)
    expect(after).toContain("[[B#保留章节|说明]] [[B|旧说明]] [[X]]")
    expect(after).toContain("`[[A]]`\n```md\n[[A]]\n```")
    expect(after).toContain('related: ["B"]')
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.pages[history]).toMatchObject({ before, after, mode: "maintenance" })
    // 重启后重放同一映射为幂等操作，不能追加重复提交或创建缺失目标。
    expect(await maintainWikiReferences(project.path, [target], redirects, run.runId)).toEqual([])
    expect(await fileExists(`${project.path}/wiki/concepts/X.md`)).toBe(false)
  })

  it("A 仍存在时保持其历史入链和 related 不变", async () => {
    await writeFileRaw(`${project.path}/wiki/concepts/A.md`, markdown("A", "独有内容。"))
    const before = markdown("历史", "[[A#独有内容]]", "[A]")
    await writeFileRaw(`${project.path}/${history}`, before)
    expect(await maintainWikiReferences(project.path, [target], new Map([["A", target]]))).toEqual([])
    expect(await readFileRaw(`${project.path}/${history}`)).toBe(before)
  })

  it("重定向链遇到仍存在的 B 即停止，不因部分内容归并而跨到 C", async () => {
    const c = "wiki/concepts/C.md"
    await writeFileRaw(`${project.path}/${c}`, markdown("C", "另一部分内容。"))
    await writeFileRaw(`${project.path}/${history}`, markdown("历史", "[[A]] [[B]]"))
    await maintainWikiReferences(project.path, [target, c], new Map([["A", target], ["B", c]]))
    expect(await readFileRaw(`${project.path}/${history}`)).toContain("[[B]] [[B]]")
  })

  it("引用方写入失败后保留已提交结果，再执行可继续未完成引用", async () => {
    const second = "wiki/concepts/另一页.md"
    await writeFileRaw(`${project.path}/${history}`, markdown("历史", "[[A]]"))
    await writeFileRaw(`${project.path}/${second}`, markdown("另一页", "[[A]]"))
    const original = realFs.compareAndWriteFile
    let writes = 0
    vi.spyOn(realFs, "compareAndWriteFile").mockImplementation(async (...args) => {
      if (++writes === 2) throw new Error("模拟写入中断")
      return original(...args)
    })
    await expect(maintainWikiReferences(project.path, [target], new Map([["A", target]]))).rejects.toThrow("模拟写入中断")
    vi.restoreAllMocks()
    await maintainWikiReferences(project.path, [target], new Map([["A", target]]))
    for (const path of [history, second]) expect(await readFileRaw(`${project.path}/${path}`)).toContain("[[B]]")
  })

  it("未知目标照常保留，格式阶段只报告缺页；缺章节降级为整页链接，同页同目标去重且有效章节不误报", async () => {
    const text = markdown("历史", "[[X]] [[X]] [[X#任意锚点]] [[B#保留章节]] [[B#保留 章节|别名]] [[B#不存在]] [[#当前章节]]\n## 当前章节\n`[[示例]]`", "[X]")
    await writeFileRaw(`${project.path}/${history}`, text)
    const material = { id: "after", path: history, text, revision: await contentRevision(text), startLine: 1, endLine: text.split("\n").length }
    const issues = await inspectWikiReferences(project.path, [material])
    expect(issues).toHaveLength(1)
    expect(issues.map((issue) => issue.pageEvidence)).toEqual(["X"])
    expect(issues[0].description).toBe("失效引用 [[X]]：目标页面不存在或名称不唯一")
    expect(issues.every((issue) => issue.manual)).toBe(true)
    expect(await readFileRaw(`${project.path}/${history}`)).toBe(text)
    // 缺失引用进入格式审阅，但不得进入自动格式修复或补页链路。
    const run = await beginIngestRun(project.path, "test", "raw/sources/来源.md", "来源.md", "事实。")
    const items = issues.map((issue, index) => ({ id: `ref-${index}`, type: "structure" as const, subtype: "失效引用", title: issue.description, description: issue.description, affectedPages: [history], options: [], resolved: false, createdAt: 0 }))
    expect(await repairReviewIssues(project.path, run.runId, "format", items, useWikiStore.getState().llmConfig, "")).toEqual(items)
    expect((await loadIngestRun(project.path, run.runId)).repairAttempts ?? []).toHaveLength(0)
  })
})
