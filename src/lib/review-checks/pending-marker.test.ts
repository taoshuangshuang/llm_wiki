import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../llm-client", () => ({ streamChat: vi.fn() }))

import { streamChat } from "../llm-client"
import { checkKnowledge, checkSupplements, findPendingSections, type ReviewMaterial } from "./index"

const config = { provider: "openai" as const, apiKey: "test", model: "test", ollamaUrl: "", customEndpoint: "", maxContextSize: 128_000 }
const text = [
  "# 接口", "说明。", "",
  "## 【待确认】方法签名", "版本一：`get(String id)`", "```java", "# 不是标题", "```", "版本二：`get(String id, boolean filter)`", "",
  "### 来源", "两份文档。", "",
  "## 使用", "正常内容。",
  "## 【待确认】", "缺主题。",
].join("\n")

describe("待确认标识", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("嵌套标识保留父子事项的完整证据和行号", () => {
    // 子节不能覆盖尚未结束的父节，父节证据应包含整个子节。
    const nested = "## 【待确认】父事项\n父级证据\n### 【待确认】子事项\n子级证据\n## 正常章节\n正文"
    expect(findPendingSections(nested, 10)).toEqual([
      { title: "父事项", startLine: 10, endLine: 13, text: nested.split("\n").slice(0, 4).join("\n") },
      { title: "子事项", startLine: 12, endLine: 13, text: "### 【待确认】子事项\n子级证据" },
    ])
  })

  it("按标题层级截取整节，忽略代码块中的井号并保留真实行号", () => {
    const sections = findPendingSections(text, 10)
    expect(sections.map(({ title, startLine, endLine }) => ({ title, startLine, endLine }))).toEqual([
      { title: "方法签名", startLine: 13, endLine: 21 },
      { title: "未命名待确认事项", startLine: 25, endLine: 26 },
    ])
    expect(sections[0].text).toContain("### 来源")
    expect(sections[0].text).not.toContain("## 使用")
  })

  it("标识段落直接转待确认，模型对同段落的冲突不重复复核；对照材料不扫描", async () => {
    const page: ReviewMaterial = { id: "page", path: "wiki/a.md", revision: "r1", text, startLine: 1, endLine: 17, role: "page" }
    const related: ReviewMaterial = { id: "rel", path: "wiki/b.md", revision: "r2", text: "## 【待确认】别人\n内容", startLine: 1, endLine: 2, role: "related" }
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ issues: [{ type: "contradiction", title: "签名冲突", description: "两版本", evidence: [{ id: "page", quote: "版本一：`get(String id)`" }, { id: "page", quote: "版本二：`get(String id, boolean filter)`" }] }] }))
      callbacks.onDone()
    })
    const result = await checkKnowledge({ materials: [page, related], targetPaths: ["wiki/a.md"], policy: "", outputLanguage: "zh", llmConfig: config })

    expect(result.status).toBe("complete")
    expect(result.issues).toEqual([])
    expect(result.pending!.map((finding) => finding.title)).toEqual(["待确认：方法签名", "待确认：未命名待确认事项"])
    expect(result.pending![0].evidence[0]).toMatchObject({ path: "wiki/a.md", revision: "r1", startLine: 4 })
    expect(streamChat).toHaveBeenCalledTimes(1)
  })

  it("模型检查失败时标识段落仍转人工", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => { callbacks.onError(new Error("网络错误")) })
    const page: ReviewMaterial = { id: "page", path: "wiki/a.md", revision: "r1", text, startLine: 1, endLine: 17, role: "page" }
    const result = await checkKnowledge({ materials: [page], policy: "", outputLanguage: "zh", llmConfig: config })

    expect(result.status).not.toBe("complete")
    expect(result.pending).toHaveLength(2)
  })
})

describe("待补充标识", () => {
  beforeEach(() => { vi.resetAllMocks() })
  const doc = ["# 页", "## 【待确认】签名", "两版本。", "## 【待补充】附件地址", "原文未给出。", "### 细节", "缺版本。", "## 正文", "内容。"].join("\n")
  const page: ReviewMaterial = { id: "page", path: "wiki/a.md", revision: "r1", text: doc, startLine: 1, endLine: 9, role: "page" }

  it("两种标识互不混淆", () => {
    expect(findPendingSections(doc).map((s) => s.title)).toEqual(["签名"])
    expect(findPendingSections(doc, 1, "【待补充】").map((s) => [s.title, s.startLine, s.endLine])).toEqual([["附件地址", 4, 7]])
  })

  it("待补充转知识补充建议，不进入待确认；模型对同段落的建议不重复", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ issues: [{ type: "suggestion", title: "缺附件", description: "缺", evidence: [{ id: "page", quote: "原文未给出。" }] }] }))
      callbacks.onDone()
    })
    const result = await checkSupplements({ materials: [page], policy: "", outputLanguage: "zh", llmConfig: config })
    expect(result.status).toBe("complete")
    expect(result.issues.map((issue) => [issue.type, issue.subtype, issue.title])).toEqual([["suggestion", "待补充标识", "待补充：附件地址"]])
    expect(result.pending).toBeUndefined()
  })

  it("模型失败时待补充标识仍保留", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => { callbacks.onError(new Error("网络错误")) })
    const result = await checkSupplements({ materials: [page], policy: "", outputLanguage: "zh", llmConfig: config })
    expect(result.status).not.toBe("complete")
    expect(result.issues.map((issue) => issue.title)).toEqual(["待补充：附件地址"])
  })
})
