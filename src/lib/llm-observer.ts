/** 按配置对象绑定单次任务的观测器，避免并发导入共享全局“当前任务”。 */
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, RequestOverrides } from "./llm-providers"
import type { StreamCompletion } from "./llm-client"

export interface LlmObservation {
  request: (url: string, body: unknown) => Promise<void>
  httpStatus: (status: number) => void
  rawResponse: (text: string) => void
  token: (text: string) => void
  done: (completion?: StreamCompletion) => void
  error: (error: unknown) => void
  finish: (aborted: boolean) => Promise<void>
}

export interface ObservedLlmCall {
  stage: string
  config: LlmConfig
  messages: ChatMessage[]
  overrides?: RequestOverrides
}

type Observer = (call: ObservedLlmCall) => LlmObservation | undefined
const observers = new WeakMap<LlmConfig, { observer: Observer; stage: string }>()

/** 只复制本次调用的配置，不修改 store，也不把诊断信息混入供应商请求。 */
export function observeLlmCalls(config: LlmConfig, observer: Observer): LlmConfig {
  const observed = { ...config }
  observers.set(observed, { observer, stage: "unspecified" })
  return observed
}

/** 子阶段使用独立配置绑定；父阶段与并发请求的标识保持不变。 */
export function withLlmStage(config: LlmConfig, stage: string): LlmConfig {
  const binding = observers.get(config)
  if (!binding) return config
  const scoped = { ...config }
  observers.set(scoped, { ...binding, stage })
  return scoped
}

/** 普通聊天没有绑定时不启用观测；已绑定的调用创建独立记录。 */
export function beginLlmObservation(config: LlmConfig, messages: ChatMessage[], overrides?: RequestOverrides): LlmObservation | undefined {
  const binding = observers.get(config)
  if (!binding) return undefined
  return binding.observer({ config, messages, overrides, stage: binding.stage })
}
