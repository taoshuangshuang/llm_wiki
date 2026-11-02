/** 通过真实文件验证恢复契约，模型、队列和界面不参与日志正确性。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
import { stat, utimes } from "node:fs/promises"

vi.mock("@/commands/fs", () => realFs)

import { beginIngestRun, commitIngestPage, loadIngestRun, recoverIngestRun, updateIngestRun } from "./ingest-run"
import { ingestSourceVersion } from "./ingest-write-guard"

let project: Awaited<ReturnType<typeof createTempProject>>
const target = "wiki/concepts/example.md"
beforeEach(async () => { project = await createTempProject("ingest-run") })
afterEach(async () => { vi.restoreAllMocks(); await project.cleanup() })

describe("可靠入库记录", () => {
  it("原始文件大小与时间戳相同，实际字节变化仍使来源版本失效", async () => {
    const source = `${project.path}/raw/sources/binary.pdf`
    await writeFileRaw(source, "binary A")
    const metadata = await stat(source)
    const before = await ingestSourceVersion(source)
    await writeFileRaw(source, "binary B")
    await utimes(source, metadata.atime, metadata.mtime)
    expect((await stat(source)).size).toBe(metadata.size)
    expect(await ingestSourceVersion(source)).not.toBe(before)
  })
  it("连续提交保留首次旧快照，工作单元映射到最终页面", async () => {
    await writeFileRaw(`${project.path}/${target}`, "旧知识")
    const run = await beginIngestRun(project.path, "project", "raw/sources/a.md", "a.md", "来源原文")
    await commitIngestPage(project.path, run.runId, target, "旧知识", "事实 A", "unit-a", "merge")
    await commitIngestPage(project.path, run.runId, target, "事实 A", "事实 A\n事实 B", "unit-b", "merge")
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.pages[target].before).toBe("旧知识")
    expect(saved.pages[target].after).toBe("事实 A\n事实 B")
    expect(saved.completedUnits).toEqual({ "unit-a": target, "unit-b": target })
    expect(saved.reviewRequested).toBe(true)
    expect(saved.pending).toBeUndefined()
  })

  it("写后崩溃仅补登记，不再次改写页面", async () => {
    const run = await beginIngestRun(project.path, "project", "raw/sources/a.md", "a.md", "原文")
    await updateIngestRun(project.path, run.runId, (state) => {
      state.pending = { path: target, before: null, after: "已写页面", unitId: "a", mode: "create" }
    })
    await writeFileRaw(`${project.path}/${target}`, "已写页面")
    const commit = vi.spyOn(realFs, "compareAndWriteFile")
    const recovered = await recoverIngestRun(project.path, run.runId)
    expect(recovered.completedUnits.a).toBe(target)
    expect(commit).not.toHaveBeenCalled()
  })

  it("恢复遇到新正文时保留文件，并禁止盲目重放", async () => {
    const run = await beginIngestRun(project.path, "project", "raw/sources/a.md", "a.md", "原文")
    await updateIngestRun(project.path, run.runId, (state) => {
      state.pending = { path: target, before: "旧版", after: "意图正文", unitId: "a", mode: "replace" }
    })
    await writeFileRaw(`${project.path}/${target}`, "人工编辑")
    expect((await recoverIngestRun(project.path, run.runId)).writeStatus).toBe("recovery-required")
    expect(await readFileRaw(`${project.path}/${target}`)).toBe("人工编辑")
    await expect(beginIngestRun(project.path, "project", "raw/sources/a.md", "a.md", "原文")).rejects.toThrow("恢复")
  })

  it("意图保存失败不触碰页面；过期预期版本不覆盖页面", async () => {
    const run = await beginIngestRun(project.path, "project", "raw/sources/a.md", "a.md", "原文")
    await writeFileRaw(`${project.path}/${target}`, "人工编辑")
    const save = vi.spyOn(realFs, "writeFileAtomic").mockRejectedValueOnce(new Error("磁盘已满"))
    await expect(commitIngestPage(project.path, run.runId, target, "旧版", "新稿", "a", "replace")).rejects.toThrow("磁盘已满")
    save.mockRestore()
    expect(await readFileRaw(`${project.path}/${target}`)).toBe("人工编辑")
    await expect(commitIngestPage(project.path, run.runId, target, "旧版", "新稿", "a", "replace")).rejects.toThrow("VERSION_CONFLICT")
    expect(await readFileRaw(`${project.path}/${target}`)).toBe("人工编辑")
  })

  it("相同来源补写延续 run，正文变化建立新 run", async () => {
    const first = await beginIngestRun(project.path, "project", "raw/sources/a.md", "a.md", "原文")
    const resumed = await beginIngestRun(project.path, "project", "raw/sources/a.md", "a.md", "原文")
    expect(resumed.runId).toBe(first.runId)
    expect(resumed.attempt).toBe(2)
    const changed = await beginIngestRun(project.path, "project", "raw/sources/a.md", "a.md", "修改后的原文")
    expect(changed.runId).not.toBe(first.runId)
  })
})
