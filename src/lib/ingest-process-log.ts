/** 每个来源一个 JSONL 文件，持续追加真实输入输出；日志异常不参与业务结果判断。 */
import { appendIngestLog, readIngestLog } from "@/commands/fs"
import { sourceIdentityForPath } from "./source-identity"
import { normalizePath } from "./path-utils"
import type { ObservedLlmCall, LlmObservation } from "./llm-observer"
import type { LlmConfig } from "@/stores/wiki-store"

const pending = new Map<string, Promise<void>>()
const failures = new Map<string, string>()

export function processLogKey(projectPath: string, sourcePath: string): string {
  return `${normalizePath(projectPath).replace(/\/+$/, "")}\0${sourceIdentityForPath(projectPath, sourcePath)}`
}

/** 导出前等待本来源已排队的日志，不等待模型或导入结束。 */
export async function readSourceProcessLog(projectPath: string, sourcePath: string): Promise<{ text: string; error?: string }> {
  const key = processLogKey(projectPath, sourcePath)
  await pending.get(key)
  try { return { text: await readIngestLog(projectPath, sourceIdentityForPath(projectPath, sourcePath)), error: failures.get(key) } }
  catch (error) { return { text: "", error: `读取过程日志失败：${String(error)}` } }
}

export class IngestProcessLog {
  private readonly key: string
  private readonly sourceIdentity: string
  private runId?: string
  private attempt?: number
  private sequence = 0
  private callCount = 0
  private warned = false
  private secrets = new Set<string>()
  private redact = createLogRedactor(this.secrets)

  constructor(private projectPath: string, private sourcePath: string, readonly executionId: string, private phase: string) {
    this.key = processLogKey(projectPath, sourcePath)
    this.sourceIdentity = sourceIdentityForPath(projectPath, sourcePath)
  }

  /** 早期读取失败也有来源身份；业务运行建立后补记关联，不修改已有日志。 */
  bindRun(runId: string, attempt: number): void {
    this.runId = runId
    this.attempt = attempt
    this.record("run-bound", { runId, attempt })
  }

  /** 模型、图片描述等不同配置的凭据均进入脱敏集合。 */
  registerSecrets(config: LlmConfig): void {
    for (const secret of [config.apiKey, ...Object.values(config.customHeaders ?? {})]) if (secret) this.secrets.add(secret)
    for (const endpoint of [config.customEndpoint, config.ollamaUrl]) {
      try {
        const url = new URL(endpoint)
        for (const secret of [url.username, url.password]) if (secret) this.secrets.add(secret)
        url.searchParams.forEach((value, key) => { if (/key|token|secret|password/i.test(key) && value) this.secrets.add(value) })
      } catch { /* 供应商配置校验仍由原链路负责。 */ }
    }
  }

  /** 旧诊断快照与追加日志共用凭据集合和脱敏规则。 */
  sanitize(value: unknown): unknown { return this.redact(value) }

  /** 入队前固定快照，避免可变对象在异步落盘前被后续阶段改写。 */
  record(event: string, data: unknown = {}, stage = this.phase): void {
    try {
      const entry = JSON.parse(JSON.stringify(this.redact({
        version: 1, time: new Date().toISOString(), executionId: this.executionId,
        runId: this.runId, attempt: this.attempt, sourceIdentity: this.sourceIdentity,
        sourcePath: this.sourcePath, phase: this.phase, sequence: ++this.sequence, stage, event, data,
      })))
      const write = (pending.get(this.key) ?? Promise.resolve()).then(async () => {
        try {
          // 后续写入恢复时把缺失风险一并保存，应用重启后仍能看到曾经丢失日志。
          const recordingWarning = failures.get(this.key)
          await appendIngestLog(this.projectPath, this.sourceIdentity, { ...entry, ...(recordingWarning ? { recordingWarning } : {}) })
        }
        catch (error) { this.failed(error) }
      })
      pending.set(this.key, write)
      void write.then(() => { if (pending.get(this.key) === write) pending.delete(this.key) })
    } catch (error) { this.failed(error) }
  }

  async flush(): Promise<void> { await pending.get(this.key) }

  private failed(error: unknown): void {
    failures.set(this.key, String(this.redact(String(error))))
    if (this.warned) return
    this.warned = true
    console.warn("[ingest:process-log] 过程日志保存失败，业务继续；导出时会标记记录可能不完整。")
  }

  /** 模型请求记录完整材料；流式正文按增量定期追加，异常结束也保留已收到内容。 */
  observeCall(call: ObservedLlmCall): LlmObservation {
    this.registerSecrets(call.config)
    const callId = `${this.executionId}:${++this.callCount}`
    const started = Date.now()
    let output = ""
    let receivedChars = 0
    let transportTail = ""
    let error: unknown
    let completion: unknown
    const emitOutput = () => {
      if (!output) return
      this.record("llm-output", { callId, text: output }, call.stage)
      output = ""
    }
    this.record("llm-start", { callId, config: call.config, messages: call.messages, overrides: call.overrides }, call.stage)
    const timer = setInterval(emitOutput, 3000)
    return {
      request: async (url, body) => { this.record("llm-request", { callId, url, body }, call.stage) },
      httpStatus: (status) => { this.record("llm-http-status", { callId, status }, call.stage) },
      rawResponse: (text) => { receivedChars += text.length; transportTail = (transportTail + text).slice(-65536) },
      token: (text) => { output += text },
      done: (value) => { completion = value },
      error: (value) => { error = value; this.record("llm-error", { callId, error: value }, call.stage) },
      finish: async (aborted) => {
        clearInterval(timer)
        emitOutput()
        this.record("llm-finish", { callId, aborted, completion, error, receivedChars, transportTail, tailOnly: receivedChars > transportTail.length, elapsedMs: Date.now() - started }, call.stage)
        await this.flush()
      },
    }
  }
}

/** 只隐藏凭据字段和已知凭据；正文、提示词和模型返回内容保留在项目本地。 */
export function createLogRedactor(secrets: Set<string>) {
  const redactText = (text: string): string => {
    let value = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<REDACTED>@")
      .replace(/([?&](?:api[_-]?key|token|access_token|secret|password)=)[^&#\s"']*/gi, "$1<REDACTED>")
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join("<REDACTED>")
    return value
  }
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value)
    if (Array.isArray(value)) return value.map(redact)
    if (value instanceof Error) return redact({ name: value.name, message: value.message, stack: value.stack })
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:api[_-]?key|authorization|proxy-authorization|headers|customHeaders|password|secret|token|access_token)$/i.test(key)
        ? "<REDACTED>" : redact(item),
    ]))
  }
  return redact
}

