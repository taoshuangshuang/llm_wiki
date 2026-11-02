/** 从真实来源读取到持久化结果，验证过滤发生在任何模型调用和页面写入之前。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./extract-source-images", async (importOriginal) => ({
  ...await importOriginal<typeof import("./extract-source-images")>(),
  extractAndSaveSourceImages: vi.fn(async () => []),
}))

import { autoIngest, startIngest } from "./ingest"
import { beginIngestRun, listIngestRuns, updateIngestRun } from "./ingest-run"
import { extractAndSaveSourceImages } from "./extract-source-images"
import { streamChat } from "./llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"

let project: Awaited<ReturnType<typeof createTempProject>>
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(extractAndSaveSourceImages).mockResolvedValue([])
  project = await createTempProject("ingest-source-filter")
  useWikiStore.setState({
    project: { id: "filter", name: "filter", path: project.path },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
  })
  useChatStore.setState({ activeConversationId: null, conversations: [], messages: [], ingestSource: null })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
})
afterEach(async () => { await project.cleanup() })

describe("无正文来源跳过整条入库流程", () => {
  it.each(["", "# 自动建表\n## 设计", "---\n***\n……", "# 自动建表\n待补充"])("自动入库过滤 %j，不调用模型、不写页面、不请求审阅", async (content) => {
    const source = `${project.path}/raw/sources/自动建表.md`
    await writeFileRaw(source, content)
    const onSourceSkipped = vi.fn()
    const paths = await autoIngest(project.path, source, useWikiStore.getState().llmConfig, undefined, undefined, undefined, { onSourceSkipped })
    expect(paths).toEqual([])
    expect(streamChat).not.toHaveBeenCalled()
    expect(onSourceSkipped).toHaveBeenCalledOnce()
    const [run] = await listIngestRuns(project.path)
    expect(run).toMatchObject({ writeStatus: "skipped", reviewStatus: "not-applicable", reviewRequested: false, pages: {} })
    expect(run.sourceSkip?.message).toBeTruthy()
    expect(run.writeError).toBeUndefined()
    expect(await readFileRaw(source)).toBe(content)
    expect(await fileExists(`${project.path}/wiki/log.md`)).toBe(false)
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
    expect(useReviewStore.getState().items).toEqual([])
    const log = await realFs.readIngestLog(project.path, "自动建表.md")
    const finish = log.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.event === "execution-finish")
    expect(finish.data.status).toBe("skipped")
  })

  it("交互式来源分析同样跳过，并在会话中说明原因", async () => {
    const source = `${project.path}/raw/sources/自动建表.md`
    await writeFileRaw(source, "# 自动建表")
    await startIngest(project.path, source, useWikiStore.getState().llmConfig)
    expect(streamChat).not.toHaveBeenCalled()
    expect((await listIngestRuns(project.path))[0]).toMatchObject({ writeStatus: "skipped", reviewRequested: false })
    expect(useChatStore.getState().ingestSource).toBeNull()
    expect(JSON.stringify(useChatStore.getState().messages)).toContain("已跳过")
  })

  it.each(["支持重试。", "```java\nreturn true;\n```", "![](diagram.png)"])("有信息的短文本和图片仍进入模型分析：%j", async (content) => {
    const source = `${project.path}/raw/sources/自动建表.md`
    await writeFileRaw(source, content)
    await startIngest(project.path, source, useWikiStore.getState().llmConfig)
    expect(streamChat).toHaveBeenCalledOnce()
    expect((await listIngestRuns(project.path)).some((run) => run.writeStatus === "skipped")).toBe(false)
  })

  it("只有扫描图片的 PDF 不因缺少文字而被过滤", async () => {
    const source = `${project.path}/raw/sources/scan.pdf`
    await writeFileRaw(source, "")
    vi.mocked(extractAndSaveSourceImages).mockResolvedValue([{
      index: 0, page: 1, mimeType: "image/png", width: 100, height: 100, sha256: "scan",
      relPath: "media/scan/1.png", absPath: `${project.path}/wiki/media/scan/1.png`,
    }])
    await startIngest(project.path, source, useWikiStore.getState().llmConfig)
    expect(streamChat).toHaveBeenCalledOnce()
    expect(await listIngestRuns(project.path)).toEqual([])
  })

  it("归档后重新导入相同空文件，仍能生成可见的跳过记录", async () => {
    const source = `${project.path}/raw/sources/自动建表.md`
    await writeFileRaw(source, "")
    await autoIngest(project.path, source, useWikiStore.getState().llmConfig)
    const [first] = await listIngestRuns(project.path)
    await updateIngestRun(project.path, first.runId, (run) => { run.archived = true })
    await autoIngest(project.path, source, useWikiStore.getState().llmConfig)
    const runs = await listIngestRuns(project.path)
    expect(runs).toHaveLength(2)
    expect(runs.filter((run) => !run.archived)).toHaveLength(1)
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("来源读取失败保留异常，不误记为无意义内容跳过", async () => {
    const onSourceSkipped = vi.fn()
    await expect(autoIngest(project.path, `${project.path}/raw/sources/missing.md`, useWikiStore.getState().llmConfig,
      undefined, undefined, undefined, { onSourceSkipped })).rejects.toThrow()
    expect(onSourceSkipped).not.toHaveBeenCalled()
    expect(streamChat).not.toHaveBeenCalled()
    expect(await listIngestRuns(project.path)).toEqual([])
  })

  it("跳过结果独立记录，不覆盖旧流程已写入页面及其失败证据", async () => {
    const source = `${project.path}/raw/sources/自动建表.md`
    await writeFileRaw(source, "# 自动建表")
    const previous = await beginIngestRun(project.path, "filter", "raw/sources/自动建表.md", "自动建表.md", "# 自动建表")
    await updateIngestRun(project.path, previous.runId, (run) => {
      run.writeStatus = "partial"
      run.writeError = "历史写入故障"
      run.pages = { "wiki/a.md": { path: "wiki/a.md", before: null, after: "历史正文", revision: "old", unitIds: [], mode: "create" } }
    })
    await autoIngest(project.path, source, useWikiStore.getState().llmConfig)
    const runs = await listIngestRuns(project.path)
    expect(runs).toHaveLength(2)
    expect(runs.find((run) => run.runId === previous.runId)).toMatchObject({ writeStatus: "partial", writeError: "历史写入故障" })
    expect(runs.find((run) => run.writeStatus === "skipped")?.pages).toEqual({})
    expect(streamChat).not.toHaveBeenCalled()
  })
})
