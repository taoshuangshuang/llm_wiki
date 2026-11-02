/** 真实文件验证追加日志、失败现场与导出契约，不依赖日志内部队列实现。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
const dialog = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: dialog.save }))

import * as fsCommands from "@/commands/fs"
import { IngestDiagnostics } from "./ingest-diagnostics"
import { IngestProcessLog, readSourceProcessLog } from "./ingest-process-log"
import { buildIngestLogExport, exportIngestLog } from "./ingest-log-export"
import { beginLlmObservation, withLlmStage } from "./llm-observer"
import { useWikiStore } from "@/stores/wiki-store"

let project: Awaited<ReturnType<typeof createTempProject>>
beforeEach(async () => { project = await createTempProject(); vi.clearAllMocks() })
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await project.cleanup() })

const entries = (text: string) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))

describe("来源过程日志与单文件导出", () => {
  it("失败导入保存完整输入、流式输出、错误，审阅重试继续追加且凭据脱敏", async () => {
    const config = { ...useWikiStore.getState().llmConfig, apiKey: "secret-api-key", customHeaders: { Authorization: "secret-header" } }
    const diagnostics = new IngestDiagnostics(project.path, "raw/sources/a/faq.md", config)
    await expect(diagnostics.run(undefined, async () => {
      diagnostics.process.bindRun("business-run", 1)
      const input = { body: "第一行\n第二行", tags: ["事实"] }
      diagnostics.event("context-budget", { sourceLength: 9, sourceBudget: 20 })
      await diagnostics.save("source.json", input)
      const call = beginLlmObservation(withLlmStage(diagnostics.config, "generation"), [{ role: "user", content: "完整提示词 secret-api-key" }])!
      await call.request("https://example.test/v1?token=secret-api-key", input)
      call.httpStatus(200)
      call.token("部分输出 secret-header")
      call.rawResponse("data: partial response")
      call.error(new Error("连接中断"))
      await call.finish(false)
      throw new Error("生成失败")
    })).rejects.toThrow("生成失败")

    const review = new IngestProcessLog(project.path, `${project.path}/raw/sources/a/faq.md`, "review-retry", "review")
    review.bindRun("business-run", 2)
    review.record("review-step-finish", { step: "knowledge", status: "incomplete", reason: "证据不足" })
    await review.flush()
    const { text } = await readSourceProcessLog(project.path, "raw/sources/a/faq.md")
    const log = entries(text)
    expect(text).not.toContain("secret-api-key")
    expect(text).not.toContain("secret-header")
    expect(text).toContain("<REDACTED>")
    expect(log.find((entry) => entry.event === "snapshot").data.value).toEqual({ body: "第一行\n第二行", tags: ["事实"] })
    expect(log.find((entry) => entry.event === "llm-output").data.text).toBe("部分输出 <REDACTED>")
    expect(log.find((entry) => entry.event === "llm-error").data.error.message).toBe("连接中断")
    expect(log.find((entry) => entry.event === "execution-finish").data.status).toBe("failed")
    expect(log[log.length - 1]).toMatchObject({ runId: "business-run", attempt: 2, executionId: "review-retry", event: "review-step-finish" })
    expect((await readSourceProcessLog(project.path, "raw/sources/b/faq.md")).text).toBe("")
  })

  it("并发执行独立标识且冻结输入快照，日志失败不替换业务返回值", async () => {
    const first = new IngestProcessLog(project.path, "raw/sources/a.md", "one", "ingest")
    const second = new IngestProcessLog(project.path, "raw/sources/a.md", "two", "review")
    const input = { value: "原始输入" }
    first.record("input", input)
    input.value = "后续修改"
    second.record("output", { value: "审阅输出" })
    await Promise.all([first.flush(), second.flush()])
    const log = entries((await readSourceProcessLog(project.path, "raw/sources/a.md")).text)
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ executionId: "one", data: { value: "原始输入" } })
    expect(log[1].executionId).toBe("two")

    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(fsCommands, "appendIngestLog").mockRejectedValue(new Error("日志磁盘不可写"))
    const diagnostics = new IngestDiagnostics(project.path, "raw/sources/error.md", useWikiStore.getState().llmConfig)
    await expect(diagnostics.run(undefined, async () => ["wiki/a.md"])).resolves.toEqual(["wiki/a.md"])
    const originalError = new Error("业务原始错误")
    const failedDiagnostics = new IngestDiagnostics(project.path, "raw/sources/error.md", useWikiStore.getState().llmConfig)
    await expect(failedDiagnostics.run(undefined, async () => { throw originalError })).rejects.toBe(originalError)
    const exported = entries(await buildIngestLogExport(project.path, "raw/sources/error.md"))
    expect(exported[0].data.recordingError).toContain("日志磁盘不可写")
  })

  it("流式调用尚未结束也定期追加正文，中断后已接收内容可导出", async () => {
    vi.useFakeTimers()
    const log = new IngestProcessLog(project.path, "raw/sources/stream.md", "stream", "ingest")
    const call = log.observeCall({ stage: "generation", config: useWikiStore.getState().llmConfig, messages: [{ role: "user", content: "输入" }] })
    call.token("中断前已收到的正文")
    await vi.advanceTimersByTimeAsync(3000)
    await log.flush()
    expect(entries((await readSourceProcessLog(project.path, "raw/sources/stream.md")).text).find((entry) => entry.event === "llm-output").data.text).toBe("中断前已收到的正文")
    await call.finish(true)
  })

  it("历史任务导出旧诊断快照并明确缺失过程，绝不把快照伪装成运行事件", async () => {
    const root = `${project.path}/.llm-wiki/ingest-diagnostics/old`
    await writeFileRaw(`${root}/manifest.json`, JSON.stringify({ sourceIdentity: "a.md", status: "failed" }))
    await writeFileRaw(`${root}/call-0001.json`, JSON.stringify({ model: { apiKey: "legacy-secret" }, messages: [{ content: "旧输入 legacy-secret" }], response: { content: "旧输出" } }))
    const text = await buildIngestLogExport(project.path, "raw/sources/a.md", undefined, { status: "failed", error: "来源失败" })
    const log = entries(text)
    expect(log[0].data.hasProcessLog).toBe(false)
    expect(log[0].data.limitation).toContain("无法还原每一步")
    expect(log.filter((entry) => entry.event === "legacy-diagnostic-snapshot")).toHaveLength(2)
    expect(log.some((entry) => entry.event === "export-queue-snapshot")).toBe(true)
    expect(text).toContain("旧输出")
    expect(text).not.toContain("legacy-secret")
  })

  it("取消导出不写文件；确认后生成一个可逐行解析的完整日志文件", async () => {
    const write = vi.spyOn(fsCommands, "writeFile")
    dialog.save.mockResolvedValueOnce(null)
    await expect(exportIngestLog(project.path, "raw/sources/a.md")).resolves.toBeUndefined()
    expect(write).not.toHaveBeenCalled()
    const log = new IngestProcessLog(project.path, "raw/sources/a.md", "export", "ingest")
    log.record("input", { text: "正文\n换行" })
    await log.flush()
    const destination = `${project.path}/export.jsonl`
    dialog.save.mockResolvedValueOnce(destination)
    await expect(exportIngestLog(project.path, "raw/sources/a.md")).resolves.toBe(destination)
    const exported = entries(await realFs.readFile(destination))
    expect(exported[0].data.hasProcessLog).toBe(true)
    expect(exported[1].data.text).toBe("正文\n换行")
  })

  it("中断留下的损坏行明确标记，后续完整事件仍可分析", async () => {
    vi.spyOn(fsCommands, "readIngestLog").mockResolvedValue('{"unfinished":\n{"event":"restarted","data":{"status":"running"}}\n')
    const exported = entries(await buildIngestLogExport(project.path, "raw/sources/a.md"))
    expect(exported.find((entry) => entry.event === "invalid-log-line").data.reason).toContain("中断")
    expect(exported.some((entry) => entry.event === "restarted")).toBe(true)
  })
})
