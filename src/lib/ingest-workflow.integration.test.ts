/** 入库重构的完整输入输出契约：使用真实临时目录，仅替换模型和向量服务。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))

import { streamChat } from "./llm-client"
import { autoIngest, executeIngestWrites } from "./ingest"
import { useChatStore } from "@/stores/chat-store"
import { parseSources } from "./sources-merge"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { listIngestedSourceIdentities } from "./ingest-cache"

let project: Awaited<ReturnType<typeof createTempProject>>
let generationInput: string
let generationOutput: string
let acceptanceInputs: Record<string, unknown>[]
let generationInputs: string[]
let handleAcceptance: ((input: Record<string, unknown>) => object) | undefined
let handleDraft: ((input: string) => string | Promise<string>) | undefined
const oldPath = "wiki/concepts/连接池.md"
const oldBody = "# 连接池\n\n连接失败时必须释放连接，错误码 POOL_CLOSED。"
const completeBody = `${oldBody}\n\n最大连接数由 maxPoolSize 配置，默认值为 20。`

function page(body: string, sources = "old.md"): string {
  return `---\ntype: concept\ntitle: 连接池\ncreated: 2025-01-02\nsources: [${sources}]\ntags: [database]\nrelated: []\n---\n${body}`
}

beforeEach(async () => {
  project = await createTempProject("ingest-workflow")
  generationInput = ""
  generationOutput = `---FILE: ${oldPath}---\n${page(completeBody, "new.md")}\n---END FILE---`
  acceptanceInputs = []
  generationInputs = []
  handleDraft = undefined
  handleAcceptance = undefined
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  useWikiStore.setState({
    project: { id: "workflow", name: "workflow", path: project.path },
    outputLanguage: "auto",
    sourceWatchConfig: { ...useWikiStore.getState().sourceWatchConfig, generateSourceSummary: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false },
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
  })
  await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| Type | Directory | Description |\n| concept | wiki/concepts/ | 概念 |\n")
  await writeFileRaw(`${project.path}/wiki/index.md`, "# Wiki Index\n\n- [[连接池]]\n")
  await writeFileRaw(`${project.path}/raw/sources/new.md`, "# 连接池\n\n最大连接数由 maxPoolSize 配置，默认值为 20。")
  await writeFileRaw(`${project.path}/${oldPath}`, page(oldBody))
  vi.mocked(streamChat).mockReset().mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0]?.content ?? "")
    const input = messages.map((message) => String(message.content)).join("\n")
    if (input.includes('"task":"规划长材料变更')) {
      const data = JSON.parse(String(messages[1].content))
      callbacks.onToken(JSON.stringify({ targets: data.candidates, createNew: false }))
    } else if (input.includes('"task":"核对语义相似页面')) {
      const data = JSON.parse(String(messages[1].content))
      callbacks.onToken(JSON.stringify({ decisions: data.candidates.map((candidate: { path: string }) => ({ path: candidate.path, verdict: "same" })) }))
    } else if (input.includes('"task":"结构规范和内容覆盖审阅')) {
      const data = JSON.parse(String(messages[1].content))
      acceptanceInputs.push(data)
      callbacks.onToken(JSON.stringify(handleAcceptance?.(data) ?? { summary: "事实保留完整", issues: [] }))
    } else if (system.startsWith("You are identifying high-value")) {
      callbacks.onToken("")
    } else if (system.startsWith("You are merging ")) {
      // 完整更新稿已经生成；如果仍执行旧的二次合并，外部服务失败也不应成为必要步骤。
      callbacks.onError(new Error("不得对完整更新稿再次调用正文合并"))
      return
    } else if (input.includes("Stage 1 Analysis") || system.includes("wiki generation assistant")) {
      generationInput = input
      generationInputs.push(input)
      callbacks.onToken(await (handleDraft?.(input) ?? generationOutput))
    } else {
      callbacks.onToken("## 知识单元\n- 连接池：补充 maxPoolSize 默认值，保留来源中的精确参数。")
    }
    callbacks.onDone({ finishReason: "stop", truncated: false })
  })
})

afterEach(async () => { await project.cleanup() })

describe("知识单元前置检索与完整更新稿", () => {
  it("关闭向量时仍在生成前读取旧正文，直接写入完整更新稿并保留双方来源", async () => {
    await autoIngest(project.path, `${project.path}/raw/sources/new.md`, useWikiStore.getState().llmConfig)

    expect(generationInput).toContain("POOL_CLOSED")
    expect(generationInput).toContain(oldPath)
    const actual = await readFileRaw(`${project.path}/${oldPath}`)
    expect(actual).toContain(completeBody)
    expect(parseSources(actual)).toEqual(["old.md", "new.md"])
    expect(actual).toContain("created: 2025-01-02")
  })

  it("明确无变更仍记录来源、审阅覆盖页并显示成功，保留原正文", async () => {
    await writeFileRaw(`${project.path}/${oldPath}`, page(completeBody))
    generationOutput = `---UNCHANGED: ${oldPath}---`
    let outcome: unknown
    await autoIngest(project.path, `${project.path}/raw/sources/new.md`, useWikiStore.getState().llmConfig,
      undefined, undefined, undefined, { onResult: (result) => { outcome = result } })

    const actual = await readFileRaw(`${project.path}/${oldPath}`)
    expect(actual).toContain(completeBody)
    expect(parseSources(actual)).toEqual(["old.md", "new.md"])
    expect(outcome).toMatchObject({ outcome: "unchanged", coveredPaths: [oldPath] })
    expect(await listIngestedSourceIdentities(project.path)).toContain("new.md")
    expect(acceptanceInputs[0].pages).toHaveProperty(oldPath)
    expect(useActivityStore.getState().items[0]).toMatchObject({ status: "done" })
  })

  it("入库维护完整页面目录，历史页面不因最近更新上限而从 index.md 消失", async () => {
    await writeFileRaw(`${project.path}/wiki/concepts/历史约束.md`, page("# 历史约束\n\n必须保留的独立主题。", "history.md"))
    await autoIngest(project.path, `${project.path}/raw/sources/new.md`, useWikiStore.getState().llmConfig)

    const index = await readFileRaw(`${project.path}/wiki/index.md`)
    expect(index).toContain("[[历史约束]]")
    expect(index).toContain("[[连接池]]")
  })

  it("长旧页分批读取和生成，保留尾部事实且不发送超预算请求", async () => {
    const longBody = `${oldBody}\n\`\`\`java\n${"    enforcePoolLimit(); // 原有连接池约束\n".repeat(1500)}\`\`\`\n尾部独有约束 TAIL_POOL_REQUIRED。\n`
    await writeFileRaw(`${project.path}/${oldPath}`, page(longBody))
    handleDraft = (input) => {
      const marker = "## 已检索的相关知识页面（完整正文）\n"
      const jsonLine = input.split(marker)[1]?.split("\n").find((line) => line.startsWith('{"units":'))
      const existing = jsonLine ? JSON.parse(jsonLine).pages[oldPath] : undefined
      if (input.includes("正文分片 JSON 协议")) {
        const body = String(existing).split("---\n").slice(2).join("---\n")
        return JSON.stringify({ body })
      }
      return `---FILE: ${oldPath}---\n${existing ?? page(completeBody)}\n---END FILE---`
    }
    handleAcceptance = (input) => ({ summary: input.pageScope ? "连接池事实及对应片段定位。".repeat(180) : "分层汇总确认保留完整", issues: [] })
    const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 30000 }
    await autoIngest(project.path, `${project.path}/raw/sources/new.md`, config)

    expect(generationInputs.length).toBeGreaterThan(1)
    expect(Math.max(...generationInputs.map((input) => input.length))).toBeLessThan(config.maxContextSize)
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toContain(longBody)
    expect(acceptanceInputs.flatMap((input) => Object.values(input.pages as Record<string, string>)).join("\n"))
      .toContain("TAIL_POOL_REQUIRED")
    expect(acceptanceInputs.filter((input) => input.evidenceScope === "partial").length).toBeGreaterThan(0)
    expect(Math.max(...acceptanceInputs.map((input) => JSON.stringify(input).length))).toBeLessThan(config.maxContextSize)
  })

  it("切换文档再返回原讨论时，保存仍使用该会话的来源及用户要求", async () => {
    const chat = useChatStore.getState()
    const a = chat.createConversation()
    chat.setIngestSource(`${project.path}/raw/sources/new.md`)
    chat.addMessageToConversation(a, "user", "本次保留 POOL_CLOSED，补充最大连接数。")
    const b = chat.createConversation()
    await writeFileRaw(`${project.path}/raw/sources/other.md`, "# 其他文档\n\n不得用于连接池讨论。")
    chat.setIngestSource(`${project.path}/raw/sources/other.md`)
    chat.addMessageToConversation(b, "user", "其他文档的无关要求。")
    chat.setActiveConversation(a)

    await executeIngestWrites(project.path, useWikiStore.getState().llmConfig)

    expect(generationInput).toContain("本次保留 POOL_CLOSED")
    expect(generationInput).not.toContain("其他文档的无关要求")
    expect(parseSources(await readFileRaw(`${project.path}/${oldPath}`))).toEqual(["old.md", "new.md"])
  })

  it("生成期间旧页被修改时重新读取生成，保留用户刚写入的事实", async () => {
    let edited = false
    handleDraft = async (input) => {
      if (!edited) {
        edited = true
        await writeFileRaw(`${project.path}/${oldPath}`, page(`${oldBody}\n用户补充 MANUAL_POOL_NOTE。`))
      }
      const body = input.includes("MANUAL_POOL_NOTE") ? `${completeBody}\n用户补充 MANUAL_POOL_NOTE。` : completeBody
      return `---FILE: ${oldPath}---\n${page(body, "new.md")}\n---END FILE---`
    }
    await autoIngest(project.path, `${project.path}/raw/sources/new.md`, useWikiStore.getState().llmConfig)
    expect(generationInputs.length).toBeGreaterThan(1)
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toContain("MANUAL_POOL_NOTE")
  })
  it("生成命中漏召回的旧路径时先补读重生成，再保留原有事实", async () => {
    const hidden = "wiki/concepts/独立历史页.md"
    await writeFileRaw(`${project.path}/${hidden}`, "---\ntype: concept\ntitle: 独立历史页\nsources: [legacy.md]\n---\n# 独立历史页\nKEEP_HIDDEN_FACT。")
    handleDraft = (input) => `---FILE: ${hidden}---\n${page(input.includes("KEEP_HIDDEN_FACT")
      ? "# 独立历史页\nKEEP_HIDDEN_FACT。\n新事实。" : "# 独立历史页\n新事实。", "new.md").replace("title: 连接池", "title: 独立历史页")}\n---END FILE---`
    await autoIngest(project.path, `${project.path}/raw/sources/new.md`, useWikiStore.getState().llmConfig)
    expect(generationInputs.length).toBeGreaterThan(1)
    expect(await readFileRaw(`${project.path}/${hidden}`)).toContain("KEEP_HIDDEN_FACT")
  })

  it("批次中完整文件后又出现未闭合文件时不提交任何分片稿", async () => {
    const longBody = `${oldBody}\n${"原有约束\n".repeat(5000)}`
    await writeFileRaw(`${project.path}/${oldPath}`, page(longBody))
    handleDraft = () => generationOutput + "\n---FILE: wiki/concepts/未完成.md---\n半份内容"
    await expect(autoIngest(project.path, `${project.path}/raw/sources/new.md`, {
      ...useWikiStore.getState().llmConfig, maxContextSize: 30000,
    })).rejects.toThrow("截断")
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toBe(page(longBody))
  })

  it("删除当前文档讨论后回到普通会话，不沿用已删除会话的来源", () => {
    const chat = useChatStore.getState()
    const ordinary = chat.createConversation()
    const discussion = chat.createConversation()
    chat.setIngestSource(`${project.path}/raw/sources/new.md`)
    // 只保留本测试的两条会话，确保删除后的当前会话明确。
    useChatStore.setState((state) => ({ conversations: state.conversations.filter((item) => [ordinary, discussion].includes(item.id)) }))
    chat.deleteConversation(discussion)
    expect(useChatStore.getState()).toMatchObject({ activeConversationId: ordinary, ingestSource: null, mode: "chat" })
  })

  it("页面正文中的无变更协议示例不会被误当完成指令", async () => {
    generationOutput = `---FILE: ${oldPath}---\n${page(`${completeBody}\n\n协议示例：\n\`\`\`text\n---UNCHANGED: ${oldPath}---\n\`\`\``)}\n---END FILE---`
    await autoIngest(project.path, `${project.path}/raw/sources/new.md`, useWikiStore.getState().llmConfig)
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toContain(`---UNCHANGED: ${oldPath}---`)
  })

  it("长材料开启来源摘要时，知识批次与摘要分别生成并保留双方结果", async () => {
    useWikiStore.setState({ sourceWatchConfig: { ...useWikiStore.getState().sourceWatchConfig, generateSourceSummary: true } })
    const longBody = `${oldBody}\n${"连接池旧约束不得丢失。\n".repeat(1000)}`
    await writeFileRaw(`${project.path}/${oldPath}`, page(longBody))
    handleDraft = (input) => {
      if (input.includes("本批次只处理来源摘要")) {
        return "---FILE: wiki/sources/new.md---\n---\ntype: source\ntitle: 来源摘要\nsources: [new.md]\n---\n# 来源摘要\nmaxPoolSize 默认值为20。\n---END FILE---"
      }
      const jsonLine = input.split("## 已检索的相关知识页面（完整正文）\n")[1]?.split("\n").find((line) => line.startsWith('{"units":'))
      const existing = JSON.parse(jsonLine!).pages[oldPath]
      if (input.includes("正文分片 JSON 协议")) {
        const part = input.match(/目标固定 .+ 的第 (\d+)\/(\d+) 片/)
        return part?.[1] === part?.[2] ? JSON.stringify({ body: `${String(existing).split("---\n").slice(2).join("---\n")}\nmaxPoolSize 默认值为20。` })
          : JSON.stringify({ unchanged: true })
      }
      return `---FILE: ${oldPath}---\n${existing}\n---END FILE---`
    }
    await autoIngest(project.path, `${project.path}/raw/sources/new.md`, useWikiStore.getState().llmConfig)
    expect(await readFileRaw(`${project.path}/${oldPath}`)).toContain(longBody)
    expect(await readFileRaw(`${project.path}/wiki/sources/new.md`)).toContain("maxPoolSize 默认值为20")
    expect(generationInputs.some((input) => input.includes("你负责已有知识页的正文片段整理"))).toBe(true)
    expect(generationInputs.some((input) => input.includes("本批次只处理来源摘要"))).toBe(true)
  })

})
