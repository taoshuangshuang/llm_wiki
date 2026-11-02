/** 冲突审阅消费完整材料：覆盖表格上下文丢失、复核无法判断和真正冲突的发布契约。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))

import { streamChat } from "./llm-client"
import { retrieveEvidence } from "./evidence-retrieval"
import { beginIngestRun, commitIngestPage, loadIngestRun, updateIngestRun } from "./ingest-run"
import { runIngestReview } from "./ingest-review"
import { readSourceProcessLog } from "./ingest-process-log"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"

const target = "wiki/designs/test-design.md"
// 保留真实故障的必要结构：版本名称是被测因素的取值，表头和设计说明决定比较对象。
const body = `# 组合测试设计
## 因素定义
| 因素1：实体类型 | 因素2：实体表版本 |
| --- | --- |
| 水平1：普通实体 | 水平1：table_v4 |
| 水平2：扩展实体 | 水平2：其他版本 |
| 水平3：引用实体 | 水平2：table_v5 |
## 组合数量
- 因素2：2个水平
## 待确认事项
实际水平数尚需核对，不应直接将 table_v4 与 table_v5 当成两份文档的版本。
`
const markdown = `---\ntype: design\ntitle: 组合测试设计\nsources: [a.md]\n---\n${body}`
const issue = {
  type: "contradiction", title: "因素2水平数量表述不一致", description: "同一测试设计的因素表与组合数说明需核对",
  evidence: [{ id: "after-0", quote: "| 水平3：引用实体 | 水平2：table_v5 |" }, { id: "after-0", quote: "- 因素2：2个水平" }],
}
const positive = { sameSubject: true, sameVersion: true, sameConditions: true, incompatible: true, explainedDifference: false }
let project: Awaited<ReturnType<typeof createTempProject>>

beforeEach(async () => {
  vi.clearAllMocks()
  project = await createTempProject("conflict-context")
  await writeFileRaw(`${project.path}/schema.md`, "# 页面规则")
  useWikiStore.setState({ project: { id: "context", path: project.path, name: "context" } })
  useReviewStore.setState({ items: [] })
  vi.mocked(retrieveEvidence).mockResolvedValue({ status: "completed", evidence: [], relations: [], targetResults: [], execution: { configVersion: "test", queries: [], channelStates: [], warnings: [], budgetReached: [], elapsedMs: 0, usage: { candidates: 0, queries: 0, contextChars: 0, readChars: 0 } } })
})
afterEach(async () => { vi.restoreAllMocks(); await project.cleanup() })

async function prepare() {
  const run = await beginIngestRun(project.path, "context", "raw/sources/a.md", "a.md", body)
  await commitIngestPage(project.path, run.runId, target, null, markdown, "design", "create")
  await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "complete" })
  return run
}

describe("冲突复核的材料与诊断契约", () => {
  it.each([false, true])("同页表格获得完整上下文后，按复核结果决定是否发布冲突：%s", async (incompatible) => {
    const run = await prepare()
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      if (String(messages[0].content).includes("事实适用范围复核器")) {
        // 模拟真实故障边界：只有碎片引文时无法确定版本名是因素取值还是主张适用版本。
        const context = input.materials?.find((entry: { id: string }) => entry.id === "after-0")
        callbacks.onToken(JSON.stringify(context?.text === markdown && input.issue?.description === issue.description
          ? { ...positive, incompatible, explainedDifference: !incompatible }
          : { incomplete: true, reason: "缺少表头和测试设计上下文", missingContext: ["因素定义"] }))
      } else callbacks.onToken(JSON.stringify(String(messages[0].content).includes("本次检查仅允许 type=contradiction") ? { issues: [issue] } : { summary: "核对完成", issues: [] }))
      callbacks.onDone()
    })

    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })

    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe("complete")
    expect(saved.reviewError).toBeUndefined()
    expect(useReviewStore.getState().items.filter((item) => item.type === "contradiction")).toHaveLength(incompatible ? 1 : 0)
    expect(await readFileRaw(`${project.path}/${target}`)).toBe(markdown)
    const verification = vi.mocked(streamChat).mock.calls.find(([, messages]) => String(messages[0].content).includes("事实适用范围复核器"))!
    const input = JSON.parse(String(verification[1][1].content))
    expect(input).toMatchObject({ issue: { title: issue.title, description: issue.description }, materials: [{ id: "after-0", path: target, text: markdown, snapshot: { side: "after", runId: run.runId } }] })
    expect(input.evidence).toMatchObject(issue.evidence.map(({ id, quote }) => ({ id, quote, path: target })))
    const inputChars = verification[1].reduce((sum, message) => sum + String(message.content).length, 0)
    expect(verification[4]?.max_tokens).toBe(Math.floor((128_000 - inputChars - 1_024) / 4))
  })

  it("复核无法判断时保留具体原因和原始判定日志，不重新初筛或误标通过", async () => {
    const run = await prepare()
    let screening = 0
    let verification = 0
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      if (String(messages[0].content).includes("事实适用范围复核器")) {
        verification++
        callbacks.onToken(JSON.stringify({ incomplete: true, reason: "需要确认测试模式", missingContext: ["测试模式", "版本适用范围"] }))
      } else if (String(messages[0].content).includes("本次检查仅允许 type=contradiction")) { screening++; callbacks.onToken(JSON.stringify({ issues: [issue] })) }
      else callbacks.onToken('{"summary":"核对完成","issues":[]}')
      callbacks.onDone()
    })

    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })

    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe("partial")
    expect(saved.reviewError).toContain("需要确认测试模式")
    expect(saved.reviewError).toContain("版本适用范围")
    expect(screening).toBe(1)
    expect(verification).toBe(1)
    expect(useReviewStore.getState().items).toMatchObject([{ type: "confirm", description: expect.stringContaining("需要确认测试模式") }])
    const records = (await readSourceProcessLog(project.path, run.sourcePath)).text.trim().split("\n").map((line) => JSON.parse(line))
    expect(records).toContainEqual(expect.objectContaining({ event: "review-conflict-verification-result", data: expect.objectContaining({ status: "incomplete", result: { incomplete: true, reason: "需要确认测试模式", missingContext: ["测试模式", "版本适用范围"] } }) }))
    expect(records).toContainEqual(expect.objectContaining({ event: "review-conflict-verification-input", data: expect.objectContaining({ input: expect.objectContaining({ materials: [expect.objectContaining({ text: markdown })] }) }) }))
  })

  it.each(["null", '{"sameSubject":true}', `${JSON.stringify(positive)}\n附加说明`])("复核协议错误只修正复核响应，已定位的初筛证据不重新生成：%s", async (invalid) => {
    const run = await prepare()
    let screening = 0
    let verification = 0
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      if (String(messages[0].content).includes("事实适用范围复核器")) {
        verification++
        if (verification === 2) expect(input.retry).toBeTruthy()
        callbacks.onToken(verification === 1 ? invalid : JSON.stringify(positive))
      } else if (String(messages[0].content).includes("本次检查仅允许 type=contradiction")) { screening++; callbacks.onToken(JSON.stringify({ issues: [issue] })) }
      else callbacks.onToken('{"summary":"核对完成","issues":[]}')
      callbacks.onDone()
    })

    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })

    expect((await loadIngestRun(project.path, run.runId)).reviewStatus).toBe("complete")
    expect(screening).toBe(1)
    expect(verification).toBe(2)
    expect(useReviewStore.getState().items.filter((item) => item.type === "contradiction")).toHaveLength(1)
    const records = (await readSourceProcessLog(project.path, run.sourcePath)).text.trim().split("\n").map((line) => JSON.parse(line))
    expect(records).toContainEqual(expect.objectContaining({ event: "review-conflict-verification-result", data: expect.objectContaining({ status: "invalid-response", output: invalid }) }))
  })

  it("冲突检查纠正知识补充类型的响应，不把错误类型送入冲突复核", async () => {
    const run = await prepare()
    let existingChecks = 0
    let verifications = 0
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      if (String(messages[0].content).includes("事实适用范围复核器")) { verifications++; callbacks.onToken(JSON.stringify(positive)) }
      else if (String(messages[0].content).includes("本次检查仅允许 type=contradiction")) {
        existingChecks++
        if (existingChecks === 2) expect(input.retry.error).toContain("只允许 type=contradiction")
        callbacks.onToken(JSON.stringify({ issues: existingChecks === 1 ? [{ ...issue, type: "suggestion" }] : [] }))
      } else callbacks.onToken('{"summary":"核对完成","issues":[]}')
      callbacks.onDone()
    })

    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })

    expect((await loadIngestRun(project.path, run.runId)).reviewStatus).toBe("complete")
    expect(existingChecks).toBe(2)
    expect(verifications).toBe(0)
    expect(useReviewStore.getState().items).toEqual([])
    const records = (await readSourceProcessLog(project.path, run.sourcePath)).text.trim().split("\n").map((line) => JSON.parse(line))
    expect(records).toContainEqual(expect.objectContaining({ event: "review-parse-or-verification-error", data: expect.objectContaining({ attempt: 1 }) }))
  })
})
