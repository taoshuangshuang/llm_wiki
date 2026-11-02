/** 场景化验证真实入库到最终磁盘文件，不拆分验证原入库的内部步骤。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { realFs, createTempProject, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
import { parseFrontmatter } from "@/lib/frontmatter"
import { streamChat } from "@/lib/llm-client"

vi.mock("@/commands/fs", () => realFs)
vi.mock("@/lib/llm-client", () => ({ streamChat: vi.fn() }))

import { autoIngest } from "@/lib/ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"

const schema = '## Business Modules\n```json\n{"version":1,"modules":[{"id":"query","name":"Query","description":"Query knowledge"},{"id":"parser","name":"Parser","description":"Parser knowledge"}]}\n```'
const oldPage = "---\ntype: concept\ntitle: Parser\nsources: [other.md]\ntags: [SQL, module/obsolete]\n---\n# Parser\nOld evidence covers query execution."
const incoming = "---\ntype: concept\ntitle: Parser\nsources: [incoming.md]\ntags: [AST, module/parser]\n---\n# Parser\nAdditional evidence covers syntax parsing."
const merged = `${incoming}\nOld evidence covers query execution.`
let project: Awaited<ReturnType<typeof createTempProject>> | undefined
let classificationInputs: string[] = []
let generationCalls = 0

beforeEach(async () => {
  vi.clearAllMocks()
  classificationInputs = []
  generationCalls = 0
  project = await createTempProject("business-modules-ingest")
  await writeFileRaw(`${project.path}/schema.md`, schema)
  await writeFileRaw(`${project.path}/raw/sources/incoming.md`, "Evidence for syntax parsing.")
  await writeFileRaw(`${project.path}/wiki/concepts/parser.md`, oldPage)
  useWikiStore.setState({
    project: { id: "test", name: "Test", path: project.path },
    outputLanguage: "English",
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false },
  })
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    let response = "Analysis of syntax parsing."
    if (system.startsWith("核对新知识页和候选页")) {
      response = JSON.stringify({ decisions: JSON.parse(String(messages[1].content)).candidates.map((page: { path: string }) => ({ path: page.path, verdict: "same" })) })
    } else if (system.includes("业务模块分类器")) {
      const input = String(messages[1].content)
      classificationInputs.push(input)
      response = input.includes("Old evidence") ? '{"moduleIds":["query"]}' : '{"moduleIds":[]}'
    } else if (system.includes("You are merging")) {
      response = merged
    } else if (system.includes("generate wiki files")) {
      generationCalls++
      response = `---FILE: wiki/concepts/parser.md---\n${incoming}\n---END FILE---`
    }
    callbacks.onToken(response)
    callbacks.onDone()
  })
})

afterEach(async () => { await project?.cleanup(); project = undefined })

describe("业务模块完整入库契约", () => {
  it("多来源页面合并后按最终正文分类，保留原主题标签和来源，移除旧业务标签", async () => {
    const config = { ...useWikiStore.getState().llmConfig, model: "test", apiKey: "test", maxContextSize: 128000 }
    await autoIngest(project!.path, `${project!.path}/raw/sources/incoming.md`, config)
    const saved = await readFileRaw(`${project!.path}/wiki/concepts/parser.md`)
    expect(parseFrontmatter(saved).frontmatter).toMatchObject({
      type: "concept", title: "Parser", tags: ["SQL", "AST", "module/query"], sources: ["other.md", "incoming.md"],
    })
    expect(saved).toContain("Old evidence")
    expect(saved).toContain("Additional evidence")
    expect(classificationInputs.some((input) => input.includes("Old evidence") && input.includes("Additional evidence"))).toBe(true)

  })
  it("未改源文档重新入库时保持生成缓存，仍纠正磁盘页面的旧分类", async () => {
    const config = { ...useWikiStore.getState().llmConfig, model: "test", apiKey: "test", maxContextSize: 128000 }
    const source = `${project!.path}/raw/sources/incoming.md`
    await autoIngest(project!.path, source, config)
    const path = `${project!.path}/wiki/concepts/parser.md`
    const previous = await readFileRaw(path)
    await writeFileRaw(path, previous.replace("module/query", "module/unclassified"))
    await autoIngest(project!.path, source, config)
    const saved = await readFileRaw(path)
    expect(generationCalls).toBe(1)
    expect(parseFrontmatter(saved).frontmatter?.tags).toEqual(["SQL", "AST", "module/query"])
    expect(parseFrontmatter(saved).body).toBe(parseFrontmatter(previous).body)
  })
})
