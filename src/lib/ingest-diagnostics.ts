/** 持久化入库现场：保留各阶段的真实输入输出、错误和页面快照，不参与生成决策。 */
import { createDirectory, readFile, writeFile } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizePath } from "./path-utils"
import { sourceIdentityForPath } from "./source-identity"
import { observeLlmCalls, type LlmObservation, type ObservedLlmCall } from "./llm-observer"
import type { StreamCompletion } from "./llm-client"

type RunStatus = "running" | "completed" | "failed" | "cancelled"
interface CallSummary { file: string; stage: string; status: RunStatus | "truncated" }
interface PageSnapshot { before?: string; after?: string; readError?: string }

/** 只隐藏凭据字段和已知凭据；正文、提示词和模型返回内容保留在项目本地。 */
function createRedactor(secrets: Set<string>) {
  const redactText = (text: string): string => {
    let value = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<REDACTED>@")
      .replace(/([?&](?:api[_-]?key|token|access_token|secret|password)=)[^&#\s"']*/gi, "$1<REDACTED>")
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join("<REDACTED>")
    return value
  }
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value)
    if (Array.isArray(value)) return value.map(redact)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:api[_-]?key|authorization|proxy-authorization|headers|customHeaders|password|secret|token|access_token)$/i.test(key)
        ? "<REDACTED>" : redact(item),
    ]))
  }
  return redact
}

/** 每次尝试独立目录；失败重试和成功缓存命中都不会覆盖前次证据。 */
export class IngestDiagnostics {
  readonly runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`
  readonly directory: string
  readonly config: LlmConfig
  private queue = Promise.resolve()
  private unavailable = false
  private secrets = new Set<string>()
  private redact = createRedactor(this.secrets)
  private pages: Record<string, PageSnapshot> = {}
  private events: Array<{ at: string; stage: string; detail: unknown }> = []
  private pendingCalls = new Set<Promise<void>>()
  private manifest: {
    version: number; runId: string; mode: string; sourcePath: string; sourceIdentity: string
    startedAt: string; finishedAt?: string; status: RunStatus; cacheHit: boolean
    calls: CallSummary[]; writtenPaths: string[]; error?: unknown
  }

  constructor(private projectPath: string, sourcePath: string, config: LlmConfig, mode = "auto") {
    this.projectPath = normalizePath(projectPath).replace(/\/+$/, "")
    this.directory = `${this.projectPath}/.llm-wiki/ingest-diagnostics/${this.runId}`
    this.manifest = {
      version: 1, runId: this.runId, mode, sourcePath,
      sourceIdentity: sourceIdentityForPath(projectPath, sourcePath),
      startedAt: new Date().toISOString(), status: "running", cacheHit: false, calls: [], writtenPaths: [],
    }
    this.config = this.observe(config)
  }

  /** 图片描述可能使用另一组配置，也要绑定到同一次导入。 */
  observe(config: LlmConfig): LlmConfig {
    for (const secret of [config.apiKey, ...Object.values(config.customHeaders ?? {})]) {
      if (secret) this.secrets.add(secret)
    }
    for (const endpoint of [config.customEndpoint, config.ollamaUrl]) {
      try {
        const url = new URL(endpoint)
        for (const secret of [url.username, url.password]) if (secret) this.secrets.add(secret)
        url.searchParams.forEach((value, key) => {
          if (/key|token|secret|password/i.test(key) && value) this.secrets.add(value)
        })
      } catch { /* 供应商配置校验仍由原链路负责。 */ }
    }
    return observeLlmCalls(config, (call) => this.beginCall(call))
  }

  /** 先写入运行状态，便于识别应用异常退出留下的未结束任务。 */
  async start(): Promise<void> {
    await this.save("manifest.json", this.manifest)
  }

  /** 诊断写入不替代业务异常；无论成功、失败或取消，都结束本次记录。 */
  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    await this.start()
    try {
      const result = await operation()
      const failed = Array.isArray(result) ? result.length === 0
        : this.manifest.calls.some((call) => call.status === "failed")
      await this.finish(signal?.aborted ? "cancelled" : failed ? "failed" : "completed")
      return result
    } catch (error) {
      await this.finish(signal?.aborted ? "cancelled" : "failed", error)
      throw error
    }
  }

  /** 固定文件名由调用方代码控制；不允许模型输出决定诊断目录。 */
  save(name: string, value: unknown): Promise<void> {
    if (this.unavailable) return this.queue
    let contents: string
    try { contents = JSON.stringify(this.redact(value), null, 2) }
    catch { this.disable(); return this.queue }
    this.queue = this.queue.then(async () => {
      if (this.unavailable) return
      try {
        await createDirectory(this.directory)
        await writeFile(`${this.directory}/${name}`, contents)
      } catch { this.disable() }
    })
    return this.queue
  }

  /** 保存阶段决策和程序处理结果，不把它们混入模型正文。 */
  event(stage: string, detail: unknown = {}): void {
    if (this.unavailable) return
    this.events.push({ at: new Date().toISOString(), stage, detail })
    void this.save("events.json", this.events)
  }

  /** 区分复用已有页面与重新调用模型的任务。 */
  cache(hit: boolean): void {
    this.manifest.cacheHit = hit
    this.event("cache", { hit })
    void this.save("manifest.json", this.manifest)
  }

  /** 每个页面只保留本轮首次修改前的版本。 */
  beforeWrite(path: string, content: string): void {
    if (this.unavailable) return
    this.pages[path] ??= { before: content }
    void this.save("pages.json", this.pages)
  }

  /** 统一记录项目相对路径，供最终快照和任务清单使用。 */
  fileWritten(path: string): void {
    const normalized = normalizePath(path)
    const relative = normalized.startsWith(`${this.projectPath}/`) ? normalized.slice(this.projectPath.length + 1) : normalized
    if (!this.manifest.writtenPaths.includes(relative)) this.manifest.writtenPaths.push(relative)
  }

  /** 在项目提交锁内读取，避免下一份资料的写入被误当成本轮结果。 */
  async capturePages(): Promise<void> {
    if (this.unavailable) return
    for (const path of new Set([...Object.keys(this.pages), ...this.manifest.writtenPaths])) {
      this.pages[path] ??= {}
      try { this.pages[path].after = await readFile(`${this.projectPath}/${path}`) }
      catch (error) { this.pages[path].readError = String(error) }
    }
    await this.save("pages.json", this.pages)
  }

  /** 等待在途调用日志并保存任务最终状态，保留原始业务异常。 */
  async finish(status: RunStatus, error?: unknown): Promise<void> {
    // 部分旧调用方在 onDone 回调中提前继续执行；也等待这些调用的最后一次诊断落盘。
    await Promise.allSettled([...this.pendingCalls])
    this.manifest.status = status
    this.manifest.finishedAt = new Date().toISOString()
    if (error !== undefined) this.manifest.error = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
    await this.save("manifest.json", this.manifest)
    await this.queue
  }

  /** 记录不可用时只警告一次，避免磁盘故障反复干扰导入。 */
  private disable(): void {
    if (this.unavailable) return
    this.unavailable = true
    console.warn("[ingest:diagnostics] 诊断记录保存失败，本次导入继续；请检查磁盘空间和项目目录权限。")
  }

  /** 为单次模型调用分配文件，并定期保存流式返回的中间正文。 */
  private beginCall(call: ObservedLlmCall): LlmObservation | undefined {
    if (this.unavailable) return undefined
    const file = `call-${String(this.manifest.calls.length + 1).padStart(4, "0")}.json`
    const summary: CallSummary = { file, stage: call.stage, status: "running" }
    this.manifest.calls.push(summary)
    const record: {
      stage: string; startedAt: string; finishedAt?: string; model: unknown
      messages: ObservedLlmCall["messages"]; overrides: ObservedLlmCall["overrides"]
      requests: Array<{ url: string; body: unknown; status?: number }>
      response: { content: string }; completion?: StreamCompletion; error?: unknown; status: CallSummary["status"]
      transportResponse: { tail: string; observedChars: number; tailOnly: boolean }
    } = {
      stage: call.stage, startedAt: new Date().toISOString(),
      model: call.config, messages: call.messages, overrides: call.overrides,
      requests: [], response: { content: "" }, status: "running",
      transportResponse: { tail: "", observedChars: 0, tailOnly: false },
    }
    let dirty = false
    let settle!: () => void
    const finished = new Promise<void>((resolve) => { settle = resolve })
    this.pendingCalls.add(finished)
    const persist = () => this.save(file, record)
    // 最多每三秒保存一次中间正文；请求前和调用结束时强制落盘。
    const timer = setInterval(() => {
      if (dirty) { dirty = false; void persist() }
    }, 3000)
    void persist()
    void this.save("manifest.json", this.manifest)
    return {
      request: async (url, body) => { record.requests.push({ url, body }); await persist() },
      httpStatus: (status) => {
        const request = record.requests[record.requests.length - 1]
        if (request) request.status = status
        dirty = true
      },
      rawResponse: (text) => {
        const raw = record.transportResponse
        raw.observedChars += text.length
        raw.tail = (raw.tail + text).slice(-65536)
        raw.tailOnly = raw.observedChars > raw.tail.length
        dirty = true
      },
      token: (text) => { if (!this.unavailable) { record.response.content += text; dirty = true } },
      done: (completion) => { record.completion = completion },
      error: (error) => {
        record.error = error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
      },
      finish: async (aborted) => {
        clearInterval(timer)
        record.status = aborted ? "cancelled" : record.error ? "failed" : record.completion?.truncated ? "truncated" : "completed"
        record.finishedAt = new Date().toISOString()
        summary.status = record.status
        try { await persist(); await this.save("manifest.json", this.manifest) }
        finally { settle(); this.pendingCalls.delete(finished) }
      },
    }
  }
}
