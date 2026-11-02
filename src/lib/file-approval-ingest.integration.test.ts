/** 验证入库遇到真实后端的“待审核”协议时，保留原文且不生成备用覆盖草稿。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

const proposals = vi.hoisted(() => ({ contents: [] as string[] }))
vi.mock("@/commands/fs", () => ({
  ...realFs,
  compareAndWriteFile: async (projectPath: string, relativePath: string, expected: string | null, contents: string) => {
    if (relativePath === "wiki/concepts/source.md") {
      proposals.contents.push(contents)
      throw "FILE_APPROVAL_REQUIRED: Important file 'wiki/concepts/source.md' is unchanged; proposal is pending human review."
    }
    await realFs.compareAndWriteFile(projectPath, relativePath, expected, contents)
  },
  writeFile: async (path: string, contents: string) => {
    if (path.endsWith("/wiki/concepts/source.md")) {
      proposals.contents.push(contents)
      throw "FILE_APPROVAL_REQUIRED: Important file 'wiki/concepts/source.md' is unchanged; proposal is pending human review."
    }
    await realFs.writeFile(path, contents)
  },
}))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))

import { autoIngest } from "./ingest"
import { streamChat } from "./llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"

let project: Awaited<ReturnType<typeof createTempProject>>
const original = "---\ntype: concept\ntitle: Source\nsources: [source.md]\n---\n# Source\n\n保留人工确认的正文。"

beforeEach(async () => {
  proposals.contents = []
  project = await createTempProject("file-approval-ingest")
  await writeFileRaw(`${project.path}/raw/sources/source.md`, "用于入库的资料正文。")
  await writeFileRaw(`${project.path}/wiki/concepts/source.md`, original)
  useWikiStore.setState({
    project: { id: "approval-test", name: "approval-test", path: project.path },
    outputLanguage: "auto",
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false },
    mineruConfig: { ...useWikiStore.getState().mineruConfig, enabled: false },
  })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const generated = "---FILE: wiki/concepts/source.md---\n---\ntype: concept\ntitle: Source\nsources: [source.md]\n---\n# Source\n\n这是需要人工审核的新正文。\n---END FILE---"
    const system = String(messages[0].content)
    const response = system.startsWith("核对新知识页和候选页")
      ? JSON.stringify({ decisions: JSON.parse(String(messages[1].content)).candidates.map((page: { path: string }) => ({ path: page.path, verdict: "same" })) })
      : system.includes("generate wiki files") ? generated : "资料分析结果。"
    callbacks.onToken(response)
    callbacks.onDone()
  })
})

afterEach(async () => { await project.cleanup() })

describe("重要档案入库审核边界", () => {
  it("保留原始知识页、只提交生成的草稿，并在入库结果中明确要求审核", async () => {
    const config = { ...useWikiStore.getState().llmConfig, model: "test", apiKey: "test", maxContextSize: 128000 }
    await expect(autoIngest(project.path, `${project.path}/raw/sources/source.md`, config)).rejects.toThrow("FILE_APPROVAL_REQUIRED:")
    expect(await readFileRaw(`${project.path}/wiki/concepts/source.md`)).toBe(original)
    expect(proposals.contents).toHaveLength(1)
    expect(proposals.contents[0]).toContain("需要人工审核的新正文")
    // 重要档案的人工审批沿用专用队列，不误报成普通页面复用待审阅事项。
    expect(useReviewStore.getState().items.some((item) => item.type === "duplicate")).toBe(false)
    // 待审核不视为完整入库，不写成功缓存，避免批准前就显示资料已经完整落盘。
    expect(await fileExists(`${project.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
  })
})
