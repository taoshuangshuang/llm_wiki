/** 使用真实原文和页面验证检索输入边界及全篇预算，不调用模型或向量服务。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => realFs)
import { generateBatchedDrafts } from "./ingest-batches"
import { prepareIngestCandidateContext } from "./ingest-context"
import { useWikiStore } from "@/stores/wiki-store"

let project: Awaited<ReturnType<typeof createTempProject>>
beforeEach(async () => { project = await createTempProject("ingest-recall") })
afterEach(async () => { await project.cleanup() })

function analysis(topic: string, keywords: string[], start = 3, end = 3): string {
  return `---KNOWLEDGE UNITS---\n${JSON.stringify([{ topic, keywords, sourceStartLine: start, sourceEndLine: end }])}\n---END KNOWLEDGE UNITS---`
}
async function recall(source: string, result: string) {
  return prepareIngestCandidateContext(project.path, `${project.path}/raw/sources/new.md`, "new.md", source, result,
    { ...useWikiStore.getState().embeddingConfig, enabled: false })
}

describe("知识单元与关键词驱动检索", () => {
  it("原文元信息、空标题和导航保留为证据，不独立检索；关键词不拆两字符", async () => {
    const source = "# 技术说明\n\n连接池使用 maxPoolSize。\n\n创建时间：2026年10月\n\n## 名词解释\n\n## 应用场景\n\n## 相关内容\n链接：性能调优"
    await writeFileRaw(`${project.path}/wiki/concepts/连接池.md`, "# 连接池\nmaxPoolSize 控制连接数量。")
    await writeFileRaw(`${project.path}/wiki/concepts/噪声.md`, "# 应用场景\n名词解释 创建时间 性能调优 2026年10月")
    await writeFileRaw(`${project.path}/wiki/concepts/错误匹配.md`, "# 连接\n池的介绍")
    const result = await recall(source, analysis("连接池", ["连接池", "maxPoolSize"]))
    expect([...result.pages.keys()]).toEqual(["wiki/concepts/连接池.md"])
    const evidence = result.units.filter((unit) => unit.id.startsWith("source-"))
    expect(evidence.every((unit) => !unit.query && !unit.candidatePaths.length)).toBe(true)
    expect(evidence.map((unit) => unit.text).join("\n")).toContain("创建时间：2026年10月")
    expect(evidence.map((unit) => unit.text).join("\n")).toContain("## 应用场景")
  })

  it("多个主题召回后，全篇最多十页，历史来源关联页优先保留", async () => {
    for (let index = 0; index < 24; index++) {
      await writeFileRaw(`${project.path}/wiki/concepts/主题${index}.md`, `# 主题${index}\n专用标识${index}。`)
    }
    const associated = "wiki/concepts/来源旧页.md"
    await writeFileRaw(`${project.path}/${associated}`, "---\nsources: [new.md]\n---\n已撤回的旧主题。")
    const units = Array.from({ length: 24 }, (_, index) => ({ topic: `主题${index}`, keywords: [`专用标识${index}`], sourceStartLine: 1, sourceEndLine: 1 }))
    const result = await recall("完整原文", `---KNOWLEDGE UNITS---\n${JSON.stringify(units)}\n---END KNOWLEDGE UNITS---`)
    expect(result.pages.size).toBe(10)
    expect(result.pages.has(associated)).toBe(true)
    expect(result.units.every((unit) => unit.candidatePaths.every((path) => result.pages.has(path)))).toBe(true)
  })

  it("历史来源关联页超预算时显式提示，不能丢弃修订复核对象", async () => {
    for (let index = 0; index < 11; index++) {
      await writeFileRaw(`${project.path}/wiki/concepts/旧页${index}.md`, "---\nsources: [new.md]\n---\n历史事实。")
    }
    const result = await recall("新版本原文", analysis("新版本", ["新版本"], 1, 1))
    expect(result.pages.size).toBe(11)
    expect(result.warnings).toEqual([expect.stringContaining("超过候选预算")])
  })
})


it("分批核对只消费当前知识单元的候选，完整输出包含各单元的覆盖结果", async () => {
  const pages = new Map([["wiki/concepts/连接池.md", "连接池旧知识"], ["wiki/concepts/事务.md", "事务旧知识"]])
  const units = [
    { id: "one", text: "连接池新知识", query: "连接池", candidatePaths: ["wiki/concepts/连接池.md"] },
    { id: "two", text: "事务新知识", query: "事务", candidatePaths: ["wiki/concepts/事务.md"] },
  ]
  const seen: string[][] = []
  const output = await generateBatchedDrafts({
    source: units.map((unit) => unit.text).join("\n"), analysis: "主题分析", materialBudget: 8000, outputBudget: 4000,
    context: { units, pages, knownPaths: [...pages.keys()], warnings: [] },
    understand: async (_source, candidates) => { seen.push([...candidates.keys()]); return { targets: [...candidates.keys()], createNew: false } },
    request: async (input) => ({ text: `---UNCHANGED: ${[...input.pages.keys()][0]}---` }),
    parse: () => [],
  })
  expect(seen).toEqual(units.map((unit) => unit.candidatePaths))
  for (const path of pages.keys()) expect(output).toContain(`---UNCHANGED: ${path}---`)
})
