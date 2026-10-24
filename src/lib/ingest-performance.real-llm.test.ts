/** 可选真实模型验证：隔离临时项目，检查完整入库后的事实覆盖与验收结果。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => realFs)
// 仅替换 Tauri 网络传输以复用桌面代理设置，模型响应来自真实服务端。
vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: async () => requestThroughDesktopProxy,
  isFetchNetworkError: () => false,
}))

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"

const enabled = process.env.RUN_INGEST_PERF_TEST === "1"
let project: Awaited<ReturnType<typeof createTempProject>> | undefined
let proxyUrl: string | undefined
const requests: Array<{ elapsedMs: number; effort: unknown; completionTokens: unknown }> = []

/** 通过标准库转发 HTTP；凭据只经子进程标准输入传递，不进入命令行或日志。 */
async function requestThroughDesktopProxy(url: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body))
  if (process.env.INGEST_PERF_BASELINE === "1") {
    // 对照组重放修复前省略思考参数的真实请求，使用独立临时项目避免结果缓存。
    delete body.thinking
    delete body.reasoning_effort
  }
  const python = `import sys,json,urllib.request,urllib.error
x=json.load(sys.stdin)
p=x.get('proxy')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'http':p,'https':p} if p else {}))
request=urllib.request.Request(x['url'],data=json.dumps(x['body']).encode(),headers=x['headers'])
try:
 with opener.open(request,timeout=90) as response:
  print(json.dumps({'status':response.status,'body':response.read().decode()}))
except urllib.error.HTTPError as error:
 print(json.dumps({'status':error.code,'body':error.read().decode()}))
except Exception as error:
 print(json.dumps({'status':599,'body':json.dumps({'error':{'message':str(error)}})}))`
  const start = performance.now()
  const child = spawn("python3", ["-c", python])
  let output = ""
  child.stdout.on("data", (data) => { output += data })
  child.stdin.end(JSON.stringify({ url, headers: init.headers, body, proxy: proxyUrl }))
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", () => resolve())
  })
  const result = JSON.parse(output) as { status: number; body: string }
  const response = JSON.parse(result.body)
  requests.push({ elapsedMs: Math.round(performance.now() - start), effort: body.reasoning_effort ?? "default",
    completionTokens: response.usage?.completion_tokens })
  return new Response(result.body, { status: result.status, headers: { "Content-Type": "application/json" } })
}

afterEach(async () => { await project?.cleanup(); project = undefined; requests.length = 0 })

describe.skipIf(!enabled)("真实模型完整入库质量与耗时", () => {
  it("保留重试边界、原样 API 和表结构，并通过最终验收", async () => {
    const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), "Library/Application Support/com.llmwiki.app/app-state.json"), "utf8"))
    const config: LlmConfig = { ...settings.llmConfig, streamingEnabled: false }
    proxyUrl = settings.proxyConfig?.enabled ? settings.proxyConfig.url : undefined
    project = await createTempProject("ingest-performance-live")
    const ddl = "CREATE TABLE jobs (id BIGINT PRIMARY KEY, queue VARCHAR(64) NOT NULL, priority INT DEFAULT 5);"
    await writeFileRaw(`${project.path}/purpose.md`, "记录任务调度服务的完整技术知识，保留精确接口、表结构与异常边界。")
    await writeFileRaw(`${project.path}/schema.md`, "# Schema\n## Page Types\n| Type | Directory | Purpose |\n| topic | wiki/topics/ | 技术知识主题，按来源整理全部事实 |")
    await writeFileRaw(`${project.path}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${project.path}/wiki/overview.md`, "# Overview\n")
    const source = `${project.path}/raw/sources/scheduler.md`
    await writeFileRaw(source, `# 任务调度服务\n默认重试次数为3，只有HTTP 503允许重试，HTTP 400不得重试。\nAPI签名：Task submit(String queue, int priority)\n表定义：\n\`\`\`sql\n${ddl}\n\`\`\`\n队列名允许字母、数字和横线，空队列名报错QUEUE_REQUIRED。`)
    useWikiStore.setState({
      project: { id: "performance-live", name: "性能样例", path: project.path }, outputLanguage: "Chinese",
      multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
      embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false },
      sourceWatchConfig: { ...useWikiStore.getState().sourceWatchConfig, generateSourceSummary: false },
    })
    useActivityStore.setState({ items: [] })
    useReviewStore.setState({ items: [] })
    const start = performance.now()
    const written = await autoIngest(project.path, source, config)
    const pages = written.filter((p) => !["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(p))
    const content = (await Promise.all(pages.map((p) => fs.readFile(`${project!.path}/${p}`, "utf8")))).join("\n")
    expect(pages.length).toBeGreaterThan(0)
    expect(content).toContain("Task submit(String queue, int priority)")
    expect(content.replace(/\s+/g, " ")).toContain(ddl)
    expect(content).toContain("QUEUE_REQUIRED")
    expect(content).toContain("503")
    expect(content).toMatch(/400[^\n]{0,30}(?:不得|不能|不重试|不可|不允许|不支持)/)
    expect(content).toContain("scheduler.md")
    const reports = await fs.readdir(`${project.path}/.llm-wiki/acceptance`)
    const report = JSON.parse(await fs.readFile(`${project.path}/.llm-wiki/acceptance/${reports[0]}`, "utf8"))
    expect(report.status).toBe("passed")
    console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - start), pages: pages.length, requests }))
  }, 360_000)
})
