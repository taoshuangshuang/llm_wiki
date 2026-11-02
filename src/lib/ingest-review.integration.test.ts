import { referenceContextFromFiles } from "@/test-helpers/reference-context"
/** 统一后台审阅的输入输出契约：失败可重试，写入结果和人工状态不回退。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string, args) => command === "wiki_reference_context" ? referenceContextFromFiles(args) : command === "retrieval_config" ? { effective: { keyword: true, vector: true, indexPage: true, graph: false } } : undefined) }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))

import { streamChat } from "./llm-client"
import { retrieveEvidence, type RetrievalResult } from "./evidence-retrieval"
import { beginIngestRun, commitIngestPage, contentRevision, loadIngestRun, updateIngestRun } from "./ingest-run"
import { runIngestReview } from "./ingest-review"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { beginLlmObservation } from "./llm-observer"
import { readSourceProcessLog } from "./ingest-process-log"
import { inspectIngestContent } from "./ingest-acceptance"
import { DEFAULT_INGEST_PROMPTS } from "./ingest-prompts"

let project: Awaited<ReturnType<typeof createTempProject>>
const page = "wiki/concepts/cache.md"
const markdown = "---\ntype: concept\ntitle: 缓存\nsources: [a.md]\n---\n# 缓存\n原始事实。"

beforeEach(async () => {
  vi.clearAllMocks()
  project = await createTempProject("background-review")
  await writeFileRaw(`${project.path}/schema.md`, "# Schema")
  useWikiStore.setState({ project: { id: "review", path: project.path, name: "review" } })
  useReviewStore.setState({ items: [] })
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
    callbacks.onToken(String(messages[0].content).includes("你是知识库后台审阅器") ? '{"issues":[]}' : '{"summary":"核对完成","issues":[]}')
    callbacks.onDone()
  })
  vi.mocked(retrieveEvidence).mockResolvedValue({ status: "completed", evidence: [], relations: [], targetResults: [], execution: { configVersion: "test", queries: [], channelStates: [], warnings: [], budgetReached: [], elapsedMs: 0, usage: { candidates: 0, queries: 1, contextChars: 0, readChars: 0 } } })
})
afterEach(async () => { vi.restoreAllMocks(); await project.cleanup() })

async function prepared(source = "原始事实。") {
  const run = await beginIngestRun(project.path, "review", "raw/sources/a.md", "a.md", source)
  await commitIngestPage(project.path, run.runId, page, null, markdown, "unit", "create")
  await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "complete" })
  return run
}

describe("统一后台审阅", () => {
  it("格式检查将未生成的引用转待审阅，不进入模型自动修复，重复审阅不重复建项", async () => {
    const run = await prepared()
    await commitIngestPage(project.path, run.runId, page, markdown, `${markdown}\n[[未生成的X]] [[未生成的X]]`, "missing-reference", "maintenance")
    const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }
    await runIngestReview(project.path, run.runId, config)
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.review?.steps.format.status).toBe("complete")
    expect(saved.review?.stepItems.format).toHaveLength(1)
    expect(saved.review?.stepItems.format[0]).toMatchObject({ type: "structure", subtype: "失效引用", repair: { status: "unresolved" } })
    expect(saved.repairAttempts ?? []).toHaveLength(0)
    await runIngestReview(project.path, run.runId, config)
    expect((await loadIngestRun(project.path, run.runId)).review?.stepItems.format).toHaveLength(1)
  })

  it("合并候选快照不同于当前页时仍发布有效审阅结论", async () => {
    const run = await prepared()
    const candidate = markdown.replace("原始事实。", "合并前的候选事实。")
    await updateIngestRun(project.path, run.runId, (state) => {
      state.events.push({ id: "failed-merge", at: 0, kind: "merge", path: page,
        reason: "合并质量校验失败", outcome: "保留旧页与新稿", reviewRequired: true,
        candidateSnapshots: { [page]: candidate } })
    })

    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })

    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe("complete")
    expect(saved.reviewError).toBeUndefined()
    expect(useReviewStore.getState().items).toMatchObject([{ type: "merge", historical: false,
      evidence: expect.arrayContaining([expect.objectContaining({ text: candidate,
        snapshot: { runId: run.runId, side: "candidate", eventId: "failed-merge" } })]) }])
    expect(await readFileRaw(`${project.path}/${page}`)).toBe(markdown)
  })

  it("版本依据不足转人工确认，检查完成且重跑不重复调用模型", async () => {
    const run = await prepared()
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const system = String(messages[0].content)
      const input = JSON.parse(String(messages[1].content))
      callbacks.onToken(JSON.stringify(system.includes("事实适用范围复核器")
        ? { incomplete: true, reason: "缺少接口适用版本", missingContext: ["版本范围"] }
        : input.task?.includes("只允许 type=contradiction|duplicate")
          ? { issues: [{ type: "contradiction", title: "版本条件待确认", description: "核对适用范围",
            evidence: [{ id: "after-0", quote: "原始事实。" }, { id: "after-0", quote: "原始事实。" }] }] }
          : { summary: "完成", issues: [] }))
      callbacks.onDone()
    })
    const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }
    await runIngestReview(project.path, run.runId, config)

    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe("complete")
    expect(saved.review!.steps.knowledge.status).toBe("complete")
    expect(saved.reviewError).toBeUndefined()
    expect(useReviewStore.getState().items).toMatchObject([{ type: "confirm", historical: false, resolved: false,
      description: expect.stringContaining("版本范围") }])
    const calls = vi.mocked(streamChat).mock.calls.length
    await runIngestReview(project.path, run.runId, config)
    expect(streamChat).toHaveBeenCalledTimes(calls)
    expect(useReviewStore.getState().items).toHaveLength(1)
  })

  it("后台审阅把真实页面标题单独交给共享召回，同时保留完整页面材料", async () => {
    const run = await prepared()
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    const request = vi.mocked(retrieveEvidence).mock.calls.find(([entry]) => entry.scene === "review")?.[0]
    expect(request?.targets).toEqual([{ id: "page-0", path: page, title: "缓存", text: "原始事实。" }])
    expect(request?.scope?.excludePaths).toContain(page)
  })

  it.each([false, true])("合并目标不确定仅记日志，候选快照保留，候选后续变化=%s时保留历史证据", async (changed) => {
    const run = await prepared()
    const candidatePath = "wiki/concepts/related.md"
    const candidate = "# 候选旧页\n需要人工核对的既有事实。"
    await writeFileRaw(`${project.path}/${candidatePath}`, candidate)
    await updateIngestRun(project.path, run.runId, (state) => {
      state.events.push({
        id: "uncertain-target", at: 0, kind: "merge", path: page,
        reason: "无法确定唯一合并目标", outcome: "保留原候选，另存独立页面",
        details: "候选主题无法确认：旧页讲缓存，新页讲持久化；原始响应已保存。",
        candidates: [candidatePath], candidateSnapshots: { [candidatePath]: candidate },
      })
    })
    if (changed) await writeFileRaw(`${project.path}/${candidatePath}`, "# 后续人工修改")
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    expect(useReviewStore.getState().items.filter((entry) => entry.type === "merge")).toEqual([])
    expect((await loadIngestRun(project.path, run.runId)).events[0].candidateSnapshots).toEqual({ [candidatePath]: candidate })
    // 审阅只发布证据，不自动合并、覆盖或回退任一页面。
    expect(await readFileRaw(`${project.path}/${page}`)).toBe(markdown)
    expect(await readFileRaw(`${project.path}/${candidatePath}`)).toBe(changed ? "# 后续人工修改" : candidate)
  })

  it("153 条正文链接只保留诊断记录，不补读源页或因关系预算阻塞审阅", async () => {
    const run = await prepared()
    const existingPath = "wiki/concepts/existing.md"
    const existing = "检索已经提供的正文证据。"
    await writeFileRaw(`${project.path}/${existingPath}`, existing)
    const retrieval = await retrieveEvidence({ projectPath: project.path, scene: "review", targets: [] })
    retrieval.evidence = [{
      id: "existing-evidence", targetIds: ["page-0"], path: existingPath, title: "已有页面", revision: await contentRevision(existing),
      text: existing, range: { startLine: 1, endLine: 1 }, headingPath: [], ranks: {}, retrievalSources: [], relationIds: [],
    }]
    // 真实文件构造超过旧版 64 条关系、32 个源页及 16K 字符限制的场景。
    // 这些文字没有被检索选为正文证据，不应因存在链接就再次读取或传给模型。
    const nearbyText = "仅存在于关联源页的文字，参见 [[已有页面]]。".repeat(100)
    const relatedContent = `# 关联页\n\n${nearbyText}\n`
    const revision = await contentRevision(relatedContent)
    const relatedPaths = Array.from({ length: 55 }, (_, index) => `wiki/topics/related-${index}.md`)
    for (const path of relatedPaths) await writeFileRaw(`${project.path}/${path}`, relatedContent)
    retrieval.relations = Array.from({ length: 153 }, (_, index) => ({
      id: `relation-${index}`, fromPath: relatedPaths[index % relatedPaths.length], fromRevision: revision,
      toPath: existingPath, targetText: "已有页面", kind: "wikilink" as const, range: { startLine: 3, endLine: 3 },
      nearbyText, resolution: "resolved" as const, usedForRecall: false,
    }))
    vi.mocked(retrieveEvidence).mockResolvedValue(retrieval)
    const read = vi.spyOn(realFs, "readFile")

    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })

    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe("complete")
    expect(saved.reviewError).toBeUndefined()
    expect(saved.review?.retrieval).toEqual(retrieval)
    expect(read.mock.calls.filter(([path]) => relatedPaths.some((relative) => path === `${project.path}/${relative}`))).toEqual([])
    const checks = vi.mocked(streamChat).mock.calls.map(([, messages]) => JSON.parse(String(messages[1].content)))
      .filter((input) => input.projectPurpose !== undefined)
    expect(checks).toHaveLength(2)
    for (const input of checks) {
      expect(input.materials.map((entry: { id: string }) => entry.id)).toEqual(["after-0", "existing-evidence"])
      expect(input).not.toHaveProperty("relations")
      expect(JSON.stringify(input)).not.toContain(nearbyText)
    }
    expect(await readFileRaw(`${project.path}/${page}`)).toBe(markdown)
  })

  it("大量关系只保留在检索记录中，统一知识审阅仍收到完整目标正文及原有证据片段", async () => {
    const run = await prepared()
    const existingPath = "wiki/concepts/existing.md"
    const existing = "已有页面的原始事实。"
    await writeFileRaw(`${project.path}/${existingPath}`, existing)
    const retrieval = await retrieveEvidence({ projectPath: project.path, scene: "review", targets: [] })
    retrieval.evidence = [{
      id: "existing-evidence", targetIds: ["page-0"], path: existingPath, title: "已有页面", revision: await contentRevision(existing),
      text: existing, range: { startLine: 1, endLine: 1 }, headingPath: [], ranks: {}, retrievalSources: [], relationIds: ["relation-0"],
    }]
    retrieval.targetResults = [{ targetId: "page-0", status: "matched", evidenceIds: ["existing-evidence"] }]
    // 模拟多个召回页面携带的长路径及版本字段：关系本身已超过整个模型上下文。
    retrieval.relations = Array.from({ length: 265 }, (_, index) => ({
      id: `relation-${index}`, fromPath: `wiki/topics/${"关联页面".repeat(80)}-${index}.md`, fromRevision: `sha256:${"a".repeat(64)}`,
      toPath: existingPath, targetText: "已有页面", kind: "related" as const, resolution: "resolved" as const, usedForRecall: false,
    }))
    expect(JSON.stringify(retrieval.relations).length).toBeGreaterThan(128_000)
    vi.mocked(retrieveEvidence).mockResolvedValue(retrieval)

    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })

    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe("complete")
    const checks = vi.mocked(streamChat).mock.calls.map(([, messages]) => ({
      system: String(messages[0].content), input: JSON.parse(String(messages[1].content)),
    })).filter(({ input }) => input.projectPurpose !== undefined)
    expect(checks).toHaveLength(2)
    for (const { system, input } of checks) {
      expect(input).not.toHaveProperty("relations")
      expect(JSON.stringify(input)).not.toContain("relation-0")
      expect(system).not.toContain("关系 evidenceIds")
      expect(input.materials).toMatchObject([
        { id: "after-0", path: page, text: markdown },
        { id: "existing-evidence", path: existingPath, text: existing, startLine: 1, endLine: 1 },
      ])
      expect(input.targetResults).toEqual(retrieval.targetResults)
    }
    // 模型输入的精简不能删除持久化的检索关系、证据映射或正文链接。
    expect(saved.review?.retrieval?.relations).toEqual(retrieval.relations)
    expect(saved.review?.retrieval?.evidence).toEqual(retrieval.evidence)
  })

  it.each([false, true])("检索正文中的事实可正常引用，发布时识别后续变更：%s", async (changedAfterRead) => {
    const run = await prepared()
    const existingPath = "wiki/interfaces/service.md"
    const existing = "# 接口说明\n\n原始事实有误，参见 [[缓存]]。\n"
    await writeFileRaw(`${project.path}/${existingPath}`, existing)
    const retrieval = await retrieveEvidence({ projectPath: project.path, scene: "review", targets: [] })
    vi.mocked(retrieveEvidence).mockResolvedValue({ ...retrieval, evidence: [{
      id: "service-evidence", targetIds: ["page-0"], path: existingPath, title: "接口说明", revision: await contentRevision(existing),
      text: "原始事实有误，参见 [[缓存]]。", range: { startLine: 3, endLine: 3 }, headingPath: [], ranks: {}, retrievalSources: [], relationIds: ["relation-2045"],
    }], relations: [{
      id: "relation-2045", fromPath: existingPath, fromRevision: await contentRevision(existing), toPath: page,
      targetText: "缓存", kind: "wikilink", range: { startLine: 3, endLine: 3 },
      nearbyText: "原始事实有误，参见 [[缓存]]。", resolution: "resolved", usedForRecall: true,
    }] })
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const system = String(messages[0].content)
      const input = JSON.parse(String(messages[1].content))
      if (system.includes("事实适用范围复核器")) {
        callbacks.onToken('{"sameSubject":true,"sameVersion":true,"sameConditions":true,"incompatible":true,"explainedDifference":false}')
      } else if (input.task?.includes("只允许 type=contradiction|duplicate")) {
        // 模拟模型发现检索正文中的相反主张；只引用正式提供的正文编号。
        const material = input.materials.find((entry: { path: string }) => entry.path === existingPath)
        expect(material).toBeDefined()
        expect(input).not.toHaveProperty("relations")
        callbacks.onToken(JSON.stringify({ issues: [{ type: "contradiction", title: "事实不一致", description: "双方对同一事实的主张相反", evidence: [
          { id: "after-0", quote: "原始事实。" }, { id: material.id, quote: "原始事实有误，参见 [[缓存]]。" },
        ] }] }))
        // 核验后仍可能有人编辑源页；旧证据只能发布为历史记录。
        if (changedAfterRead) await writeFileRaw(`${project.path}/${existingPath}`, `${existing}\n人工更新。`)
      } else callbacks.onToken('{"summary":"完成","issues":[]}')
      callbacks.onDone()
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe(changedAfterRead ? "partial" : "complete")
    expect(useReviewStore.getState().items).toMatchObject([{ type: "contradiction", historical: changedAfterRead, evidence: [
      { path: page }, { path: existingPath, startLine: 3, endLine: 3, revision: await contentRevision(existing) },
    ] }])
    expect(saved.review?.retrieval?.evidence.some((entry) => entry.path === existingPath)).toBe(true)
    expect(await readFileRaw(`${project.path}/${existingPath}`)).toBe(changedAfterRead ? `${existing}\n人工更新。` : existing)
  })

  it.each(["unknown-id", "changed-quote"])("引用校验失败 %s 时反馈具体原因和有效编号，重试按实际输入重新计算预算", async (invalid) => {
    const run = await prepared()
    let attempts = 0
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      if (input.task?.includes("只允许 type=suggestion")) {
        attempts++
        if (attempts === 2) {
          expect(input.retry).toMatchObject({ allowedMaterialIds: ["after-0"] })
          expect(input.retry.error).toContain(invalid === "unknown-id" ? "relation-fake" : "after-0")
          expect(input.retry.error).toContain(invalid === "unknown-id" ? "不存在" : "逐字")
        }
        callbacks.onToken(JSON.stringify({ issues: [{ type: "suggestion", title: "需要核对", description: "核对原始事实", evidence: [{
          id: attempts === 1 && invalid === "unknown-id" ? "relation-fake" : "after-0",
          quote: attempts === 1 && invalid === "changed-quote" ? "模型改写的事实。" : "原始事实。",
        }] }] }))
      } else callbacks.onToken('{"summary":"完成","issues":[]}')
      callbacks.onDone()
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })
    expect(attempts).toBe(2)
    expect((await loadIngestRun(project.path, run.runId)).reviewStatus).toBe("complete")
    expect(useReviewStore.getState().items).toMatchObject([{ type: "suggestion", evidence: [{ id: "after-0", text: "原始事实。" }] }])
    for (const [, messages, , , overrides] of vi.mocked(streamChat).mock.calls) {
      const chars = messages.reduce((sum, message) => sum + String(message.content).length, 0)
      expect(overrides?.max_tokens).toBe(Math.floor((128_000 - chars - 1_024) / 4))
    }
  })

  it("两次伪造证据编号仍被拒绝，不能因重试而放宽证据检查", async () => {
    const run = await prepared()
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      callbacks.onToken(input.task?.includes("只允许 type=suggestion") ? JSON.stringify({ issues: [{ type: "suggestion", title: "伪造证据", description: "无依据的主张", evidence: [{ id: "fake", quote: "原始事实。" }] }] }) : '{"summary":"完成","issues":[]}')
      callbacks.onDone()
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.review?.knowledgeChecks?.suggestion.status).toBe("incomplete")
    expect(saved.reviewStatus).toBe("incomplete")
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("全库检索触及时间预算时，引用合法也不把审阅误标为全部完成", async () => {
    const run = await prepared()
    const input = await retrieveEvidence({ projectPath: project.path, scene: "review", targets: [] })
    vi.mocked(retrieveEvidence).mockResolvedValue({ ...input, status: "partial", execution: { ...input.execution, budgetReached: ["timeLimit"] } })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe("incomplete")
    expect(saved.review?.steps.knowledge).toMatchObject({ status: "incomplete" })
    expect(saved.review?.steps.knowledge.reason).toContain("检索超时")
    expect(saved.review?.batches?.[0].retrieval?.execution.budgetReached).toContain("timeLimit")
    expect(saved.writeStatus).toBe("complete")
    expect(await readFileRaw(`${project.path}/${page}`)).toBe(markdown)
  })

  it.each([0, 2_000])("内容、冲突与全库检查按实际输入分配输出空间，不截掉材料：额外 %i 行", async (lines) => {
    const run = await prepared("原始事实。\n" + "补充事实。\n".repeat(lines))
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 })
    expect((await loadIngestRun(project.path, run.runId)).reviewStatus).toBe("complete")
    const calls = vi.mocked(streamChat).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const [, messages, , , overrides] of calls) {
      const inputChars = messages.reduce((sum, message) => sum + String(message.content).length, 0)
      expect(overrides?.max_tokens).toBe(Math.floor((128_000 - inputChars - 1_024) / 4))
      expect(overrides?.max_tokens).toBeGreaterThan(8_192)
      expect(String(messages[1].content)).toContain("原始事实。")
    }
  })

  it("完整材料预检与实际请求使用同一预算，空间不足时不发送请求或静默截断来源", async () => {
    const options = {
      projectPath: project.path, sourceIdentity: "a.md", sourcePath: "raw/sources/a.md", sourceContent: "原始事实。",
      schema: "# Schema", purpose: "整理事实", writtenPaths: [page], prompts: DEFAULT_INGEST_PROMPTS,
      llmConfig: { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 },
      pageSnapshot: { pages: { [page]: markdown }, knownPagePaths: [page] },
    }
    await inspectIngestContent(options)
    const [, messages] = vi.mocked(streamChat).mock.calls[0]
    const inputChars = messages.reduce((sum, message) => sum + String(message.content).length, 0)
    vi.mocked(streamChat).mockClear()
    options.llmConfig.maxContextSize = inputChars + 1_024 + 4_096
    expect((await inspectIngestContent(options)).error).toBeUndefined()
    const call = vi.mocked(streamChat).mock.calls[0]
    expect(call[4]?.max_tokens).toBe(1_024)
    expect(JSON.parse(String(call[1][1].content))).toMatchObject({ sourceScope: "complete", source: "原始事实。\n" })
    vi.mocked(streamChat).mockClear()
    options.llmConfig.maxContextSize -= 4
    expect((await inspectIngestContent(options)).error).toContain("上下文容量不足")
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("旧协议提示只保留运行记录，不论是否有页面快照都不发布为合并问题", async () => {
    const run = await prepared()
    await updateIngestRun(project.path, run.runId, (state) => {
      for (const path of [page, "wiki/faqs/uncommitted.md"]) state.events.push({
        id: path, at: 0, kind: "merge", path,
        reason: "旧合并返回未明确内容歧义，需后台复核", outcome: "保留模型合并稿并交后台复核",
      })
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    const saved = await loadIngestRun(project.path, run.runId)
    expect(useReviewStore.getState().items).toEqual([])
    expect(saved.events).toHaveLength(2)
    expect(saved.reviewStatus).toBe("complete")
    expect(saved.review?.steps.merge).toBeUndefined()
  })

  it("历史合并事件不因升级自动生成待办或第五项检查", async () => {
    const run = await prepared()
    await updateIngestRun(project.path, run.runId, (state) => {
      state.events.push({ id: "uncommitted", at: 0, kind: "merge", path: "wiki/faqs/uncommitted.md", reason: "合并返回正文过短", outcome: "采用本次生成稿" })
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    const saved = await loadIngestRun(project.path, run.runId)
    expect(useReviewStore.getState().items).toEqual([])
    expect(saved.review?.steps.merge).toBeUndefined()
    expect(saved.reviewStatus).toBe("complete")
  })

  it("模型输入输出和审阅结果追加到来源日志，原有请求统计仍准确", async () => {
    const run = await prepared()
    vi.mocked(streamChat).mockImplementation(async (config, messages, callbacks) => {
      // 模拟真实传输层的观测回调，验证诊断观测与业务统计能同时生效。
      const observation = beginLlmObservation(config, messages)
      await observation?.request("https://example.test/chat", { messages })
      const output = String(messages[0].content).includes("你是知识库后台审阅器") ? '{"issues":[]}' : '{"summary":"核对完成","issues":[]}'
      observation?.token(output)
      callbacks.onToken(output)
      observation?.done({ truncated: false })
      callbacks.onDone()
      await observation?.finish(false)
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    const saved = await loadIngestRun(project.path, run.runId)
    const records = (await readSourceProcessLog(project.path, run.sourcePath)).text.trim().split("\n").map((line) => JSON.parse(line))
    const calls = records.filter((entry) => entry.event === "llm-start")
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((entry) => entry.runId === run.runId && entry.data.messages.length > 0)).toBe(true)
    expect(calls.some((entry) => entry.stage === "background-review")).toBe(true)
    expect(records.some((entry) => entry.event === "llm-output")).toBe(true)
    expect(records.some((entry) => entry.data?.name === "review-result.json")).toBe(true)
    expect(saved.review?.statistics?.requests).toBe(calls.length)
    expect(saved.review?.statistics?.failedRequests).toBe(0)
    expect(saved.reviewStatus).toBe("complete")
  })

  it("初筛误报版本差异时，按双方实际适用范围复核后不发布冲突", async () => {
    const run = await beginIngestRun(project.path, "review", "raw/sources/a.md", "a.md", "珊瑚引擎 V7 并发上限为 17。")
    const before = markdown.replace("原始事实。", "珊瑚引擎 V6 并发上限为 9。")
    const after = markdown.replace("原始事实。", "珊瑚引擎 V6 并发上限为 9。\n珊瑚引擎 V7 并发上限为 17。")
    await writeFileRaw(`${project.path}/${page}`, before)
    await commitIngestPage(project.path, run.runId, page, before, after, "unit", "merge")
    await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "complete" })
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const system = String(messages[0].content)
      const input = JSON.parse(String(messages[1].content))
      if (system.includes("事实适用范围复核器")) callbacks.onToken('{"sameSubject":true,"sameVersion":false,"sameConditions":true,"incompatible":false,"explainedDifference":true}')
      else if (input.task?.includes("只允许 type=contradiction")) callbacks.onToken(JSON.stringify({ issues: [{ type: "contradiction", subtype: "覆盖前后", title: "上限不同", description: "两个数值不一致", evidence: [{ id: "after-0", quote: "珊瑚引擎 V6 并发上限为 9。" }, { id: "after-0", quote: "珊瑚引擎 V7 并发上限为 17。" }] }] }))
      else callbacks.onToken(system.includes("你是知识库后台审阅器") ? '{"issues":[]}' : '{"summary":"完成","issues":[]}')
      callbacks.onDone()
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    expect(useReviewStore.getState().items.filter((item) => item.type === "contradiction")).toEqual([])
    expect((await loadIngestRun(project.path, run.runId)).reviewStatus).toBe("complete")
    const verification = vi.mocked(streamChat).mock.calls.find(([, messages]) => String(messages[0].content).includes("事实适用范围复核器"))!
    const inputChars = verification[1].reduce((sum, message) => sum + String(message.content).length, 0)
    expect(verification[4]?.max_tokens).toBe(Math.floor((128_000 - inputChars - 1_024) / 4))
  })

  it.each([
    { type: "duplicate", subtype: undefined }, { type: "suggestion", subtype: undefined },
  ])("$type $subtype：分项审阅发布可定位事项，重跑不丢人工处理状态", async ({ type, subtype }) => {
    const run = await prepared()
    const existingPath = "wiki/concepts/old.md"
    await writeFileRaw(`${project.path}/${existingPath}`, "原始事实。")
    const retrieval = await retrieveEvidence({ projectPath: project.path, scene: "review", targets: [] })
    vi.mocked(retrieveEvidence).mockResolvedValue({ ...retrieval, evidence: [{ id: "existing", targetIds: ["page-0"], path: existingPath, title: "旧知识", revision: await contentRevision("原始事实。"), text: "原始事实。", headingPath: [], range: { startLine: 1, endLine: 1 }, ranks: { "page-0": 1 }, retrievalSources: [], relationIds: [] }] })
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      const evidence = [{ id: "after-0", quote: "原始事实。" }, ...(type === "duplicate" ? [{ id: "existing", quote: "原始事实。" }] : [])]
      callbacks.onToken(input.task?.includes(`只允许 type=${type === "duplicate" ? "contradiction|duplicate" : type}`) ? JSON.stringify({ issues: [{ type, subtype, title: "待核查事项", description: "有逐字材料支持的判断", evidence }] }) : '{"summary":"核对完成","issues":[]}')
      callbacks.onDone()
    })
    const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }
    await runIngestReview(project.path, run.runId, config)
    expect((await loadIngestRun(project.path, run.runId)).reviewStatus).toBe("complete")
    const item = useReviewStore.getState().items[0]
    expect(item).toMatchObject({ type, schemaVersion: 2 })
    expect(item.subtype).toBe(subtype)
    expect(item.evidence?.every((entry) => entry.revision.startsWith("sha256:") && entry.startLine > 0)).toBe(true)
    useReviewStore.getState().resolveItem(item.id, "已核查")
    await runIngestReview(project.path, run.runId, config)
    expect(useReviewStore.getState().items).toMatchObject([{ id: item.id, resolved: true, resolvedAction: "已核查" }])
  })

  it("一份报告维护所有检查，不写旧 acceptance 目录，重跑不重复检查已完成步骤", async () => {
    const run = await prepared()
    const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 }
    await runIngestReview(project.path, run.runId, config)
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.writeStatus).toBe("complete")
    expect(saved.reviewStatus).toBe("complete")
    expect(Object.keys(saved.review!.steps)).toEqual(["format", "content", "knowledge", "supplement"])
    expect(Object.keys(saved.review!.batches![0].checks)).toEqual(["existing-knowledge", "suggestion"])
    // 正常路径只有覆盖、已有知识联合初筛、知识补充三次请求。
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(3)
    expect(await realFs.fileExists(`${project.path}/.llm-wiki/acceptance`)).toBe(false)
    const calls = vi.mocked(streamChat).mock.calls.length
    await runIngestReview(project.path, run.runId, config)
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(calls)
  })

  it("旧版关系补读的检查点重试时重新审阅，旧报告保留为历史", async () => {
    const run = await prepared()
    const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 }
    await runIngestReview(project.path, run.runId, config)
    const saved = await loadIngestRun(project.path, run.runId)
    const oldRulesRevision = await contentRevision(JSON.stringify({ engineVersion: 5, ...saved.review!.rules }))
    // 模拟旧版任务：分项检查虽已完成，整体仍因额外补读触限而未完成。
    await updateIngestRun(project.path, run.runId, (state) => {
      state.reviewStatus = "incomplete"
      state.reviewError = "全库检索partial：reviewRelationRanges；reviewRelationContext；reviewRelationPages"
      state.review!.model!.rulesRevision = oldRulesRevision
      state.review!.steps.knowledge = { status: "incomplete", reason: state.reviewError }
    })
    vi.mocked(streamChat).mockClear()

    await runIngestReview(project.path, run.runId, config)

    const retried = await loadIngestRun(project.path, run.runId)
    expect(retried.reviewStatus).toBe("complete")
    expect(retried.reviewError).toBeUndefined()
    expect(retried.review?.model?.rulesRevision).not.toBe(oldRulesRevision)
    expect(retried.reviewHistory?.some((review) => review.model?.rulesRevision === oldRulesRevision)).toBe(true)
    const knowledgeCalls = vi.mocked(streamChat).mock.calls.filter(([, messages]) => JSON.parse(String(messages[1].content)).projectPurpose !== undefined)
    expect(knowledgeCalls).toHaveLength(2)
    expect(await readFileRaw(`${project.path}/${page}`)).toBe(markdown)
  })

  it("全库关闭时保留已检查结果，不发布 confirm，也不声称全部通过", async () => {
    const run = await prepared()
    vi.mocked(retrieveEvidence).mockResolvedValueOnce({ ...await retrieveEvidence({ projectPath: project.path, scene: "review", targets: [] }), status: "disabled" } as RetrievalResult)
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    const saved = await loadIngestRun(project.path, run.runId)
    expect(saved.reviewStatus).toBe("incomplete")
    expect(saved.review!.steps.content.status).toBe("complete")
    expect(saved.review!.steps.knowledge.status).toBe("incomplete")
    expect(useReviewStore.getState().items).toEqual([])
    expect(await readFileRaw(`${project.path}/${page}`)).toBe(markdown)
  })

  it("部分写入不将尚待补写的来源报为遗漏，合并事件仍可独立发布", async () => {
    const run = await prepared()
    await updateIngestRun(project.path, run.runId, (state) => {
      state.writeStatus = "partial"
      state.events.push({ id: "event", at: 0, kind: "merge", path: page, reason: "合并返回正文过短", outcome: "采用本次生成稿", reviewRequired: true })
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    expect((await loadIngestRun(project.path, run.runId)).review!.steps.content).toMatchObject({ status: "not-applicable" })
    expect(useReviewStore.getState().items).toMatchObject([{ type: "merge", schemaVersion: 2, runIds: [run.runId], outcome: "采用本次生成稿" }])
  })

  it("消费正文失效后只保存历史证据，不作为当前问题发布", async () => {
    const run = await prepared()
    await updateIngestRun(project.path, run.runId, (state) => { state.events.push({ id: "event", at: 0, kind: "merge", path: page, reason: "合并质量问题", outcome: "已另存", reviewRequired: true }) })
    await writeFileRaw(`${project.path}/${page}`, `${markdown}\n后续人工编辑。`)
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    expect(useReviewStore.getState().items[0].historical).toBe(true)
    expect((await loadIngestRun(project.path, run.runId)).reviewStatus).toBe("partial")
    expect(await readFileRaw(`${project.path}/${page}`)).toContain("后续人工编辑")
  })
  it("类型错误在协议阶段纠正一次，不让重复检查直接失败", async () => {
    const run = await prepared()
    let duplicateAttempts = 0
    const normal = vi.mocked(streamChat).getMockImplementation()!
    vi.mocked(streamChat).mockImplementation(async (...args) => {
      const [, messages, callbacks] = args
      const input = JSON.parse(String(messages[1].content))
      if (input.task?.includes("只允许 type=contradiction|duplicate")) {
        duplicateAttempts++
        if (duplicateAttempts === 1) callbacks.onToken(JSON.stringify({ issues: [{ type: "suggestion", title: "错误类型", description: "应纠正协议", evidence: [{ id: "after-0", quote: "原始事实。" }] }] }))
        else callbacks.onToken('{"issues":[]}')
        callbacks.onDone()
      } else await normal(...args)
    })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, maxContextSize: 128000 })
    expect(duplicateAttempts).toBe(2)
    expect((await loadIngestRun(project.path, run.runId)).review?.steps.knowledge.status).toBe("complete")
  })

})
