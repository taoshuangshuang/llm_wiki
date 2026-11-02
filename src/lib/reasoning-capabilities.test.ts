import { describe, expect, it } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizeReasoningForProvider, resolveReasoningCapabilities } from "./reasoning-capabilities"

function config(provider: LlmConfig["provider"], model: string): LlmConfig {
  return {
    provider,
    model,
    apiKey: "key",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://gateway.example/v1",
    maxContextSize: 128_000,
  }
}

describe("reasoning capabilities", () => {
  it("Flash 仅在智谱官方接口启用支持的推理档位，未知网关仍不推断协议", () => {
    const cfg = { ...config("custom", "GLM-5.3-Flash"), customEndpoint: "https://open.bigmodel.cn/api/paas/v4" }
    expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "low" })
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto", "low", "high", "max"])
    expect(resolveReasoningCapabilities({ ...cfg, customEndpoint: "https://gateway.example/v1" }).modes).toEqual(["auto"])
    expect(resolveReasoningCapabilities({ ...cfg, apiMode: "anthropic_messages" }).modes).toEqual(["auto"])
  })

  it("官方 GLM-5.3 按能力映射旧设置，并保留用户要求的较高思考预算", () => {
    const cfg = { ...config("custom", "GLM-5.3"), customEndpoint: "https://open.bigmodel.cn/api/paas/v4" }
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto", "low", "high", "max"])
    expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "low" })
    expect(normalizeReasoningForProvider(cfg, { mode: "medium" })).toEqual({ mode: "high" })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 2048 })).toEqual({ mode: "low" })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 4096 })).toEqual({ mode: "high" })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 8192 })).toEqual({ mode: "max" })
  })

  it("does not infer vendor-private controls from a custom gateway model name", () => {
    const cfg = config("custom", "Qwen3-thinking-only")
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto"])
    expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "auto" })
  })

  it("offers OpenRouter's documented reasoning controls only on its endpoint", () => {
    const cfg = {
      ...config("custom", "vendor/reasoning-model"),
      customEndpoint: "https://openrouter.ai/api/v1",
    }

    expect(resolveReasoningCapabilities(cfg).modes)
      .toEqual(["auto", "off", "low", "medium", "high", "max", "custom"])
    expect(normalizeReasoningForProvider(cfg, { mode: "low" })).toEqual({ mode: "low" })
  })

  it("does not offer off for thinking-required Gemini and Claude models", () => {
    expect(resolveReasoningCapabilities(config("google", "gemini-2.5-pro")).modes)
      .not.toContain("off")
    expect(resolveReasoningCapabilities(config("anthropic", "claude-opus-4-7")).modes)
      .not.toContain("off")
    expect(resolveReasoningCapabilities(config("anthropic", "claude-sonnet-4-6")).modes)
      .not.toContain("custom")
  })

  it("limits OpenAI reasoning models to representable effort levels", () => {
    expect(resolveReasoningCapabilities(config("openai", "gpt-5.4")).modes)
      .toEqual(["auto", "low", "medium", "high"])
    expect(normalizeReasoningForProvider(config("openai", "gpt-5.4"), { mode: "max" }))
      .toEqual({ mode: "auto" })
  })

  it("normalizes custom budgets to positive integer values", () => {
    const cfg = config("anthropic", "claude-sonnet-4-5")
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 2048.9 }))
      .toEqual({ mode: "custom", budgetTokens: 2048 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 10 }))
      .toEqual({ mode: "custom", budgetTokens: 1024 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 99_999 }))
      .toEqual({ mode: "custom", budgetTokens: 32_768 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 0 }))
      .toEqual({ mode: "auto" })
  })
})
