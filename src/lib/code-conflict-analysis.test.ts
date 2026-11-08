/** 验证从 Wiki 冲突到源码核验的完整输入输出，以及证据失效边界。 */
import { beforeEach, describe, expect, it, vi } from "vitest"
const files = vi.hoisted(() => new Map<string, string>())
vi.mock("@/commands/fs", () => ({
  fileExists: async (path: string) => files.has(path),
  readFile: async (path: string) => { if (!files.has(path)) throw new Error("文件缺失"); return files.get(path)! },
}))
vi.mock("@/commands/code-evidence", () => ({ collectCodeEvidence: vi.fn(), verifyCodeEvidence: vi.fn() }))
vi.mock("./project-schema", () => ({ loadProjectSchema: vi.fn() }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
import { collectCodeEvidence, verifyCodeEvidence } from "@/commands/code-evidence"
import { loadProjectSchema } from "./project-schema"
import { streamChat } from "./llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { contentRevision } from "./content-revision"
import { createCodeConflictAnalyzer, analyzeReviewCode } from "./code-conflict-analysis"
import { checkKnowledge } from "./review-checks/knowledge"

const catalog = '## Business Modules\n```json\n{"version":1,"modules":[{"id":"api","name":"API","description":"API范围","children":[{"id":"query","name":"查询","description":"查询范围"}]}]}\n```'
const markdown = '---\ntags: [module/query]\n---\n# 查询\n## 【待确认】规则差异\n一处说启用，一处说停用。\n'
const source = "class Engine {\n  boolean enabled() { return true; }\n}"
const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }
let quote = "return true;"
let material: { id: string; path: string; revision: string; text: string; startLine: number; endLine: number }

beforeEach(async () => {
  vi.resetAllMocks()
  files.clear()
  quote = "return true;"
  files.set("/p/code-sources.json", JSON.stringify({ version: 1, moduleBindings: {
    api: { repository: "/repo/api" }, query: { paths: ["src/query"], pathsRepository: "/repo/api" },
  } }))
  files.set("/p/wiki/rules.md", markdown)
  vi.mocked(loadProjectSchema).mockResolvedValue(catalog)
  material = { id: "page", path: "wiki/rules.md", revision: await contentRevision(markdown), text: markdown, startLine: 1, endLine: markdown.split("\n").length }
  vi.mocked(collectCodeEvidence).mockResolvedValue({
    repository: "/repo/api", commit: "fixed-commit", branch: "current", dirty: true, configRevision: "config-v1", notes: [],
    evidence: [{ path: "src/query/Engine.java", revision: "sha256:code", startLine: 1, endLine: 3, text: source, via: "codegraph" }],
  })
  vi.mocked(verifyCodeEvidence).mockResolvedValue(true)
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    const system = String(messages[0].content)
    const response = system.includes("规划源码检索词") ? { queries: ["Engine"] }
      : system.startsWith("根据文档主张") ? {
        status: "complete", summary: "当前实现返回 true，历史适用版本待确认。",
        findings: [{ description: "当前源码提供启用结果。", citations: [{ id: "code-0-0", quote }] }],
      } : { issues: [] }
    callbacks.onToken(JSON.stringify(response)); callbacks.onDone()
  })
})

async function review() {
  return checkKnowledge({
    materials: [material], llmConfig: config, outputLanguage: "Chinese", policy: "",
    analyzeCode: createCodeConflictAnalyzer("/p", config),
  })
}

describe("冲突源码核验", () => {
  it("普通冲突通过适用范围复核后自动附加源码核验", async () => {
    const text = '---\ntags: [module/query]\n---\n一处说启用。\n一处说停用。'
    files.set("/p/wiki/rules.md", text)
    material = { ...material, revision: await contentRevision(text), text, endLine: text.split("\n").length }
    const original = vi.mocked(streamChat).getMockImplementation()!
    vi.mocked(streamChat).mockImplementation(async (config, messages, callbacks, signal, overrides) => {
      const system = String(messages[0].content)
      if (system.startsWith("你是知识库后台审阅器")) callbacks.onToken(JSON.stringify({ issues: [{
        type: "contradiction", title: "规则冲突", description: "同一条件下结论相反",
        evidence: [{ id: "page", quote: "一处说启用。" }, { id: "page", quote: "一处说停用。" }],
      }] }))
      else if (system.startsWith("你是事实适用范围复核器")) callbacks.onToken(JSON.stringify({
        sameSubject: true, sameVersion: true, sameConditions: true, incompatible: true, explainedDifference: false, declaredDifference: false,
      }))
      else return original(config, messages, callbacks, signal, overrides)
      callbacks.onDone()
    })
    const result = await review()
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].codeAnalysis?.status).toBe("complete")
    expect(result.pending).toBeUndefined()
  })

  it("待确认段落自动使用继承仓库和子模块范围，保存源码与提交依据", async () => {
    const result = await review()
    expect(result.status).toBe("complete")
    expect(result.pending).toHaveLength(1)
    expect(result.pending?.[0].codeAnalysis).toMatchObject({
      status: "complete",
      repositories: [{ repository: "/repo/api", commit: "fixed-commit", dirty: true }],
      findings: [{ citations: [{ id: "code-0-0", quote: "return true;" }] }],
    })
    expect(collectCodeEvidence).toHaveBeenCalledExactlyOnceWith("/p", "/repo/api", ["Engine"], ["src/query"])
    expect(verifyCodeEvidence).toHaveBeenCalledTimes(1)
    expect(result.issues).toEqual([])
  })

  it("模型引用不存在的代码时保留失败和已取证片段", async () => {
    quote = "return false;"
    const result = await review()
    expect(result.pending?.[0].codeAnalysis).toMatchObject({ status: "failed", summary: "源码引用不在实际消费的证据内" })
    expect(result.pending?.[0].codeAnalysis?.evidence).toHaveLength(1)
  })

  it("核验期间源码变化时拒绝发布成功结论", async () => {
    vi.mocked(verifyCodeEvidence).mockResolvedValue(false)
    const result = await review()
    expect(result.pending?.[0].codeAnalysis?.status).toBe("stale")
    expect(result.pending?.[0].codeAnalysis?.findings).toEqual([])
  })

  it("旧审阅项引文已过期时不启动检索或模型请求", async () => {
    files.set("/p/wiki/rules.md", markdown + "外部修改")
    const result = await analyzeReviewCode("/p", {
      title: "规则差异", description: "需确认",
      evidence: [{ path: material.path, revision: material.revision, text: "一处说启用", startLine: 6, endLine: 6 }],
    }, config)
    expect(result?.status).toBe("stale")
    expect(collectCodeEvidence).not.toHaveBeenCalled()
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("未保存源码绑定时保留原审阅结果", async () => {
    files.delete("/p/code-sources.json")
    const result = await review()
    expect(result.pending).toHaveLength(1)
    expect(result.pending?.[0].codeAnalysis).toBeUndefined()
    expect(collectCodeEvidence).not.toHaveBeenCalled()
  })
})
