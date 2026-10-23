/** 经过真实入库、HTTP 协议转换和磁盘写入，验证诊断记录能还原失败及低质量导入。 */
import fs from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

const transport = vi.hoisted(() => ({ fetch: vi.fn(), failDiagnostics: false }))
vi.mock("@/commands/fs", () => ({
  ...realFs,
  writeFile: async (path: string, content: string) => {
    if (transport.failDiagnostics && path.includes("/ingest-diagnostics/")) throw new Error("disk full")
    return realFs.writeFile(path, content)
  },
}))
vi.mock("./tauri-fetch", async () => ({
  ...await vi.importActual<typeof import("./tauri-fetch")>("./tauri-fetch"),
  getHttpFetch: async () => transport.fetch,
}))

import { autoIngest, executeIngestWrites, startIngest } from "./ingest"
import { IngestDiagnostics } from "./ingest-diagnostics"
import { withLlmStage } from "./llm-observer"
import { streamChat } from "./llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"

let project: Awaited<ReturnType<typeof createTempProject>>
const source = "# 入库材料\n\n完整材料包括字段选择、排序和分页。"
const pagePath = "wiki/references/查询模型.md"
const page = "---\ntype: reference\ntitle: 查询模型\nsources: [source.md]\n---\n# 查询模型\n\n这里只写了字段选择。"
const config: LlmConfig = {
  provider: "custom", apiKey: "diagnostic-api-secret", model: "fixture-model",
  ollamaUrl: "", customEndpoint: "https://fixture.invalid/v1?token=endpoint-secret",
  customHeaders: { "X-Gateway-Key": "gateway-secret" },
  maxContextSize: 128000, streamingEnabled: false,
}

function response(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
    headers: { "Content-Type": "application/json" },
  })
}

/** 固定模型输出，保留真实提示词、协议和页面验收链路，不访问任何模型服务。 */
function normalResponder(_url: string, options: RequestInit): Response {
  const body = JSON.parse(String(options.body))
  const system = body.messages[0].content as string
  if (system.includes("generate wiki files")) return response(`---FILE: ${pagePath}---\n${page}\n---END FILE---`)
  if (system.includes("最终验收") || system.includes("覆盖")) {
    return response(JSON.stringify({ summary: "夹具验收通过；此结果不代表人工质量评价。", issues: [] }))
  }
  return response("分析材料中的字段选择、排序和分页。")
}

beforeEach(async () => {
  transport.fetch.mockReset().mockImplementation(normalResponder)
  transport.failDiagnostics = false
  project = await createTempProject("ingest-diagnostics")
  await writeFileRaw(`${project.path}/raw/sources/source.md`, source)
  await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| Type | Directory | Purpose |\n| reference | wiki/references/ | 技术参考 |\n")
  useWikiStore.setState({
    project: { id: "diagnostics", name: "diagnostics", path: project.path }, outputLanguage: "auto",
    sourceWatchConfig: { ...useWikiStore.getState().sourceWatchConfig, generateSourceSummary: false },
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false },
  })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  useChatStore.setState({ conversations: [], activeConversationId: null, messages: [], isStreaming: false, streamingContent: "" })
})

afterEach(async () => { await project.cleanup(); vi.restoreAllMocks() })

async function readRuns() {
  const root = `${project.path}/.llm-wiki/ingest-diagnostics`
  const entries = await fs.readdir(root).catch(() => [])
  expect(entries.length, "每次导入应独立保存诊断目录").toBeGreaterThan(0)
  return Promise.all(entries.sort().map(async (name) => {
    const directory = `${root}/${name}`
    const manifest = JSON.parse(await readFileRaw(`${directory}/manifest.json`))
    const calls = await Promise.all(manifest.calls.map(async (call: { file: string }) =>
      JSON.parse(await readFileRaw(`${directory}/${call.file}`))))
    return { directory, manifest, calls }
  }))
}

describe("入库诊断现场", () => {
  it("成功也保留实际输入、原始模型正文和最终页，供事后检查内容遗漏", async () => {
    await autoIngest(project.path, `${project.path}/raw/sources/source.md`, config)
    const [run] = await readRuns()
    expect(run.manifest.status).toBe("completed")
    expect(run.calls.map((call) => call.stage)).toEqual(["analysis", "generation", "acceptance"])
    expect(JSON.parse(await readFileRaw(`${run.directory}/source.json`)).content).toBe(source)
    const generation = run.calls[1]
    expect(generation.messages[1].content).toContain(source)
    expect(generation.response.content).toContain(page)
    // 诊断中的 wire body 必须来自真实 provider 转换，而不是自行猜测请求结构。
    expect(generation.requests[0].body).toEqual(JSON.parse(String(transport.fetch.mock.calls[1][1].body)))
    expect(generation.completion.finishReason).toBe("stop")
    const pages = JSON.parse(await readFileRaw(`${run.directory}/pages.json`))
    expect(pages[pagePath].after).toBe(await readFileRaw(`${project.path}/${pagePath}`))
    // 后续页面即使被人工修改，也不能覆盖当时导入结果的快照。
    await writeFileRaw(`${project.path}/${pagePath}`, "后续修改")
    expect(JSON.parse(await readFileRaw(`${run.directory}/pages.json`))[pagePath].after).toContain("这里只写了字段选择")
    const text = (await Promise.all((await fs.readdir(run.directory)).map((file) => readFileRaw(`${run.directory}/${file}`)))).join("\n")
    for (const secret of ["diagnostic-api-secret", "endpoint-secret", "gateway-secret"]) expect(text).not.toContain(secret)
  })

  it("生成中途断流后保存已收到的正文、错误和失败阶段", async () => {
    let reads = 0
    transport.fetch.mockImplementationOnce(() => response("完整的材料分析"))
      .mockImplementationOnce(() => new Response(new ReadableStream({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `---FILE: ${pagePath}---\n尚未完成` } }] })}\n\n`))
          else controller.error(new TypeError("Failed to fetch"))
        },
      }), { headers: { "Content-Type": "text/event-stream" } }))
    await expect(autoIngest(project.path, `${project.path}/raw/sources/source.md`, { ...config, streamingEnabled: true })).rejects.toThrow()
    const [run] = await readRuns()
    expect(run.manifest.status).toBe("failed")
    expect(run.calls[1].stage).toBe("generation")
    expect(run.calls[1].response.content).toContain("尚未完成")
    expect(run.calls[1].error.message).toContain("Connection lost")
  })

  it("重复导入分别记录，缓存命中明确标识且不虚构模型调用", async () => {
    await autoIngest(project.path, `${project.path}/raw/sources/source.md`, config)
    const count = transport.fetch.mock.calls.length
    await autoIngest(project.path, `${project.path}/raw/sources/source.md`, config)
    const runs = await readRuns()
    expect(runs).toHaveLength(2)
    const cached = runs.find((run) => run.manifest.cacheHit)
    expect(cached).toBeDefined()
    expect(cached!.calls).toEqual([])
    expect(transport.fetch).toHaveBeenCalledTimes(count)
  })

  it("诊断目录写入失败不改变导入结果，也不增加模型调用", async () => {
    transport.failDiagnostics = true
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(autoIngest(project.path, `${project.path}/raw/sources/source.md`, config)).resolves.toContain(pagePath)
    expect(transport.fetch).toHaveBeenCalledTimes(3)
    expect(warning).toHaveBeenCalled()
  })

  it("供应商拒绝 temperature 时保留重试前后的两个真实请求", async () => {
    transport.fetch.mockImplementationOnce(() => new Response("temperature unsupported", { status: 400 }))
    await autoIngest(project.path, `${project.path}/raw/sources/source.md`, config)
    const [run] = await readRuns()
    expect(run.calls[0].requests).toHaveLength(2)
    expect(run.calls[0].requests[0]).toMatchObject({ status: 400, body: { temperature: 0.1 } })
    expect(run.calls[0].requests[1].status).toBe(200)
    expect(run.calls[0].requests[1].body).not.toHaveProperty("temperature")
    expect(run.calls[0].status).toBe("completed")
  })

  it("并发任务复用同一供应商配置时，输入输出分别归属各自任务", async () => {
    const first = new IngestDiagnostics(project.path, `${project.path}/raw/sources/first.md`, config)
    const second = new IngestDiagnostics(project.path, `${project.path}/raw/sources/second.md`, config)
    await Promise.all([first.start(), second.start()])
    transport.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
      await Promise.resolve()
      const body = JSON.parse(String(options.body))
      return response(`结果：${body.messages[0].content}`)
    })
    await Promise.all([first, second].map(async (trace, index) => {
      await streamChat(withLlmStage(trace.config, "analysis"), [{ role: "user", content: `输入-${index}` }], {
        onToken: () => {}, onDone: () => {}, onError: (error) => { throw error },
      })
      await trace.finish("completed")
    }))
    const runs = await readRuns()
    expect(runs).toHaveLength(2)
    for (const run of runs) {
      expect(run.calls).toHaveLength(1)
      expect(run.calls[0].response.content).toBe(`结果：${run.calls[0].messages[0].content}`)
    }
    expect(new Set(runs.map((run) => run.calls[0].messages[0].content)).size).toBe(2)
    expect(config).not.toHaveProperty("diagnostics")
  })

  it("用户中途取消时保留部分正文，并明确标记取消而不是成功", async () => {
    const controller = new AbortController()
    let reads = 0
    transport.fetch.mockImplementationOnce(() => response("完整的材料分析"))
      .mockImplementationOnce(() => new Response(new ReadableStream({
        pull(stream) {
          if (reads++ === 0) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "取消前收到的正文" } }] })}\n\n`))
          else { controller.abort(); stream.error(new DOMException("cancelled", "AbortError")) }
        },
      }), { headers: { "Content-Type": "text/event-stream" } }))
    await expect(autoIngest(project.path, `${project.path}/raw/sources/source.md`, { ...config, streamingEnabled: true }, controller.signal)).rejects.toThrow("cancelled")
    const [run] = await readRuns()
    expect(run.manifest.status).toBe("cancelled")
    expect(run.calls[1].status).toBe("cancelled")
    expect(run.calls[1].response.content).toBe("取消前收到的正文")
  })

  it("完整稿生成、分类记录到当前任务，并保留修改前后的真实页面", async () => {
    const old = page.replace("sources: [source.md]", "sources: [other.md]").replace("这里只写了字段选择。", "已有材料定义排序。")
    await writeFileRaw(`${project.path}/${pagePath}`, old)
    await writeFileRaw(`${project.path}/schema.md`, `${await readFileRaw(`${project.path}/schema.md`)}\n## Business Modules\n\x60\x60\x60json\n{"version":1,"modules":[{"id":"query","name":"查询","description":"查询知识"}]}\n\x60\x60\x60`)
    transport.fetch.mockImplementation((url: string, options: RequestInit) => {
      const system = JSON.parse(String(options.body)).messages[0].content as string
      if (system.includes("generate wiki files")) return response(`---FILE: ${pagePath}---\n${page}\n已有材料定义排序。\n---END FILE---`)
      if (system.includes("业务模块分类器")) return response('{"moduleIds":["query"]}')
      return normalResponder(url, options)
    })
    await autoIngest(project.path, `${project.path}/raw/sources/source.md`, config)
    const [run] = await readRuns()
    expect(run.calls.map((call) => call.stage)).toEqual(["analysis", "generation", "module-classification", "acceptance"])
    const pages = JSON.parse(await readFileRaw(`${run.directory}/pages.json`))
    expect(pages[pagePath].before).toBe(old)
    expect(pages[pagePath].after).toContain("module/query")
  })

  it("非流式响应本身不是合法 JSON 时，保留供应商原始响应用于协议诊断", async () => {
    transport.fetch.mockImplementationOnce(() => new Response("<html>upstream gateway error</html>"))
    await expect(autoIngest(project.path, `${project.path}/raw/sources/source.md`, config)).rejects.toThrow()
    const [run] = await readRuns()
    expect(run.manifest.status).toBe("failed")
    expect(run.calls[0].transportResponse).toEqual({
      tail: "<html>upstream gateway error</html>", observedChars: 35, tailOnly: false,
    })
    expect(run.calls[0].error.message).toBeTruthy()
  })

  it("交互式来源分析和保存到 Wiki 分别记录，并保留讨论历史", async () => {
    useChatStore.getState().createConversation()
    await startIngest(project.path, `${project.path}/raw/sources/source.md`, config)
    useChatStore.getState().addMessage("user", "补充要求：保留排序和分页说明。")
    transport.fetch.mockImplementation(() => response(`---FILE: ${pagePath}---\n${page}\n---END FILE---`))
    await executeIngestWrites(project.path, config)
    const runs = await readRuns()
    expect(runs).toHaveLength(2)
    const analysis = runs.find((run) => run.manifest.mode === "interactive-analysis")!
    const writing = runs.find((run) => run.manifest.mode === "auto")!
    expect(analysis.calls[0].stage).toBe("interactive-analysis")
    expect(writing.calls.map((call) => call.stage)).toContain("generation")
    expect(writing.calls.find((call) => call.stage === "generation")!.messages.some((message: { content: string }) => message.content.includes("补充要求"))).toBe(true)
    expect(JSON.parse(await readFileRaw(`${writing.directory}/pages.json`))[pagePath].after).toContain("这里只写了字段选择")
  })
})
