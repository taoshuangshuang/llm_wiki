import { beforeEach, describe, expect, it, vi } from "vitest"
import { streamChat } from "@/lib/llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { generateReviewQuestions, parseReviewQuestions, reviewChoiceMessage } from "./review-conversation-choices"

vi.mock("@/lib/llm-client", () => ({ streamChat: vi.fn() }))

const review = {
  id: "type-conflict", type: "contradiction" as const,
  title: "元数据关系相关表字段类型与URI格式不一致",
  description: "md_interface 的 createTime/modifyTime 原文档误写为 String，实际应为 Date；另有 URI 是否包含协议前缀的不一致。",
  affectedPages: ["wiki/md_interface.md"],
}
const questions = [
  { question: "md_interface.createTime 的字段类型是什么？", options: ["createTime 是 String 类型", "createTime 是 Date 类型"] },
  { question: "URI 是否包含协议前缀？", options: ["URI 包含协议前缀", "URI 不包含协议前缀"] },
]

beforeEach(() => vi.resetAllMocks())

describe("根据实际审阅材料生成开场确认项", () => {
  it("将完整争议材料送入模型，展示字段类型及 URI 的独立选择", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ questions }))
      callbacks.onDone()
    })
    const signal = new AbortController().signal
    const config = useWikiStore.getState().llmConfig
    expect(await generateReviewQuestions(review, config, "zh", signal)).toEqual(questions)
    const [, messages, , actualSignal] = vi.mocked(streamChat).mock.calls[0]
    expect(JSON.parse(messages[1].content as string)).toEqual(review)
    expect(messages[0].content).toContain("不能据此预选或推荐答案")
    expect(actualSignal).toBe(signal)
  })

  it("其他条目使用自己的正文生成选项，而不是复用字段类型模板", async () => {
    const other = { ...review, id: "merge", type: "duplicate" as const, title: "两个页面是否介绍同一协议", description: "页面 A 与页面 B 的范围可能相同" }
    const generated = [{ question: "两个页面的范围是否相同？", options: ["范围相同", "范围不同"] }]
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      expect(JSON.parse(messages[1].content as string)).toEqual(other)
      callbacks.onToken(JSON.stringify({ questions: generated }))
    })
    expect(await generateReviewQuestions(other, useWikiStore.getState().llmConfig, "zh", new AbortController().signal)).toEqual(generated)
  })

  it("不适合转为选择的开放问题返回空列表，供界面继续正常会话", async () => {
    const openReview = { ...review, title: "分析索引性能下降原因", description: "需要进一步检索运行日志与性能数据才能分析原因。" }
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      expect(messages[0].content).toContain("普通分析、开放问题")
      expect(messages[0].content).toContain("混合条目只为适合选择的部分列题")
      expect(JSON.parse(messages[1].content as string)).toEqual(openReview)
      callbacks.onToken('{"questions":[]}')
    })
    expect(await generateReviewQuestions(openReview, useWikiStore.getState().llmConfig, "zh", new AbortController().signal)).toEqual([])
    expect(parseReviewQuestions('{"questions":[]}')).toEqual([])
  })

  it("模型输出被截断或失败时报告错误，不退回固定操作", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ questions }))
      callbacks.onDone({ truncated: true })
    })
    await expect(generateReviewQuestions(review, useWikiStore.getState().llmConfig, "zh", new AbortController().signal)).rejects.toThrow("Incomplete")
  })

  it("生成接口报错时保留失败状态供界面重试，不把半截内容显示为可选结论", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ questions }))
      callbacks.onError(new Error("生成服务不可用"))
    })
    await expect(generateReviewQuestions(review, useWikiStore.getState().llmConfig, "zh", new AbortController().signal)).rejects.toThrow("生成服务不可用")
  })

  it("取消后不采纳已经返回的旧条目选项", async () => {
    const controller = new AbortController()
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      controller.abort()
      callbacks.onToken(JSON.stringify({ questions }))
    })
    await expect(generateReviewQuestions(review, useWikiStore.getState().llmConfig, "zh", controller.signal)).rejects.toThrow()
  })

  it.each([null, {}, { questions: [{ question: "类型", options: ["String", "String"] }] }, { questions: [{ question: "类型", options: [null, "Date"] }] }])("拒绝不可用的确认项：%j", (value) => {
    expect(() => parseReviewQuestions(JSON.stringify(value))).toThrow()
  })

  it("兼容 JSON 代码块，只发送用户实际选择的结论", () => {
    const parsed = parseReviewQuestions(`\u0060\u0060\u0060json\n${JSON.stringify({ questions })}\n\u0060\u0060\u0060`)
    const message = reviewChoiceMessage(parsed, { 0: "createTime 是 Date 类型", 1: "暂不确定，请先核查证据" }, "以下是我的选择；暂不修改页面。")
    expect(message).toContain("createTime 是 Date 类型")
    expect(message).not.toContain("createTime 是 String 类型")
    expect(message).toContain("URI 是否包含协议前缀？")
    expect(message).toContain("暂不确定，请先核查证据")
  })
})
