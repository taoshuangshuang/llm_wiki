import { inspectWikiReferences } from "./wiki-reference-maintenance"
/** 统一后台审阅：内部检查只返回证据化事项，由一次持久化提交发布。 */
import { fileExists, listDirectory, readFile } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { reviewIdFor, useReviewStore, type ReviewEvidence, type ReviewItem } from "@/stores/review-store"
import { contentRevision, loadIngestRun, readIngestRunSource, updateIngestRun, type IngestRun } from "./ingest-run"
import { inspectIngestContent } from "./ingest-acceptance"
import { checkFormat, checkKnowledge, checkSupplements, type ReviewMaterial } from "./review-checks"
import { locateReviewQuote } from "./review-checks/evidence"
import { reviewMaterialSegments } from "./review-checks/segments"
import { MODEL_RULES } from "./review-checks/model"
import { DEFAULT_INGEST_PROMPTS, loadProjectIngestPrompts } from "./ingest-prompts"
import { loadProjectSchema } from "./project-schema"
import { beginLlmObservation, observeLlmCalls, withLlmStage } from "./llm-observer"
import { IngestDiagnostics } from "./ingest-diagnostics"
import { reviewRetrievalContext } from "./ingest-review-materials"
import { loadReviewItems, saveReviewItems } from "./persist"
import { withProjectLock } from "./project-mutex"
import { assertIngestSnapshotsUnchanged } from "./ingest-write-guard"
import { recoverReviewRepair, recoverStageRepairs, repairReviewIssues, deduplicateReviewIssues } from "./ingest-review-repair"
import { withIngestPipeline } from "./ingest-pipeline"
import { ensureReviewBatchPlan, reviewBatchError, reviewCorpusIdentity, retrieveReviewBatch, retrievalEvidenceCurrent } from "./ingest-review-batches"
import type { FileNode } from "@/types/wiki"

type NewReview = Omit<ReviewItem, "id" | "resolved" | "createdAt">
type Material = ReviewMaterial
const STEPS = ["format", "content", "knowledge", "supplement"] as const
const MAX_REVIEW_REQUESTS = 16

/** 相同证据的复查复用身份；正文实质变化产生新发生版本，标题不参与身份。 */
async function makeReview(run: IngestRun, item: NewReview, identity: string): Promise<ReviewItem> {
  const logicalId = (await contentRevision(`${item.type}\0${item.subtype ?? ""}\0${identity}`)).slice(7)
  const evidenceVersion = (await contentRevision(JSON.stringify((item.evidence ?? []).map(({ path, text, snapshot }) => ({ path, text, side: snapshot?.side })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))))).slice(7)
  const result: ReviewItem = {
    ...item, schemaVersion: 2, logicalId, evidenceVersion, runIds: [run.runId], resolved: false, createdAt: Date.now(), id: "",
    sourcePath: run.sourcePath, options: [{ label: "已审阅", action: "acknowledge", kind: "acknowledge" }],
  }
  result.id = reviewIdFor(result)
  return result
}

async function materialsFor(run: IngestRun, source: string): Promise<Material[]> {
  const materials: Material[] = [{ id: "source", path: run.sourcePath, revision: run.sourceRevision, text: source, startLine: 1, endLine: source.split("\n").length, snapshot: { runId: run.runId, side: "source" } }]
  for (const [index, page] of Object.values(run.pages).entries()) {
    materials.push({ id: `after-${index}`, path: page.path, revision: page.revision, text: page.after, startLine: 1, endLine: page.after.split("\n").length, ...(run.review?.currentPages ? {} : { snapshot: { runId: run.runId, side: "after" as const } }) })
    if (page.before !== null) materials.push({ id: `before-${index}`, path: page.path, revision: await contentRevision(page.before), text: page.before, startLine: 1, endLine: page.before.split("\n").length, snapshot: { runId: run.runId, side: "before" } })
  }
  return materials
}

async function wikiPaths(projectPath: string): Promise<string[]> {
  const result: string[] = []
  const collect = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.is_dir) collect(node.children ?? [])
      else if (node.name.endsWith(".md")) result.push(node.path.slice(projectPath.length + 1))
    }
  }
  collect(await listDirectory(`${projectPath}/wiki`))
  return result
}

/** 发布前核对实际消费版本；旧快照仍保留，但不能当作当前页的结论。 */
export async function hasCurrentReviewEvidence(projectPath: string, run: IngestRun): Promise<boolean> {
  try {
    if (run.review?.revision !== run.revision) return false
    const snapshots = new Map([
      ...Object.values(run.pages).map((page): [string, string] => [page.path, page.after]),
      ...Object.entries(run.review?.currentPages ?? {}),
    ])
    const evidence = [...(run.review?.retrieval?.evidence ?? []), ...(run.review?.batches ?? []).flatMap((batch) => batch.retrieval?.evidence ?? []), ...Object.values(run.review?.stepItems ?? {}).flatMap((items) => items.flatMap((item) => item.evidence ?? []))]
    for (const entry of evidence.filter((entry) => !("snapshot" in entry && entry.snapshot) && entry.path.startsWith("wiki/"))) {
      if (await contentRevision(await readFile(`${projectPath}/${entry.path}`)) !== entry.revision) return false
    }
    await assertIngestSnapshotsUnchanged(projectPath, snapshots)
    return true
  } catch { return false }
}

/** 显式取消仍保留已完成检查的有效事项；取消状态与人工处理状态分别保存。 */
export async function publishInterruptedIngestReview(projectPath: string, runId: string): Promise<void> {
  await withProjectLock(projectPath, async () => {
    const run = await loadIngestRun(projectPath, runId)
    if (!run.review || run.reviewStatus !== "cancelled") return
    const historical = !await hasCurrentReviewEvidence(projectPath, run)
    const items = Object.values(run.review.stepItems).flat().map((item) => ({ ...item, historical }))
    if (!items.length) return
    await saveReviewItems(projectPath, items)
    if (useWikiStore.getState().project?.path === projectPath) useReviewStore.getState().addItems(items)
    await updateIngestRun(projectPath, runId, (state) => { if (state.review && state.reviewStatus === "cancelled") state.review.issueIds = items.map((item) => item.id) })
  })
}

const activeReviewControllers = new Map<string, AbortController>()

/** 取消当前逻辑执行；忽略取消的网络响应只能保留在原诊断中。 */
export function abortIngestReviewExecution(projectPath: string, runId?: string): void {
  if (runId) activeReviewControllers.get(`${projectPath}\0${runId}`)?.abort()
  else for (const [key, controller] of activeReviewControllers) if (key.startsWith(`${projectPath}\0`)) controller.abort()
}

/** 执行一次 run 的检查并保存每一步结果；可单独重试失败检查，不重新生成页面。 */
export async function runIngestReview(projectPath: string, runId: string, config: LlmConfig, signal?: AbortSignal, executionId = crypto.randomUUID(), pipelineLease?: symbol): Promise<void> {
  return withIngestPipeline(async () => {
    const controller = new AbortController()
    const key = `${projectPath}\0${runId}`
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) controller.abort()
    activeReviewControllers.set(key, controller)
    let rejectAborted!: (error: unknown) => void
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
    const onAbort = () => rejectAborted(new DOMException("审阅已取消", "AbortError"))
    controller.signal.addEventListener("abort", onAbort, { once: true })
    try {
      controller.signal.throwIfAborted()
      const run = await loadIngestRun(projectPath, runId)
      const diagnostics = new IngestDiagnostics(projectPath, run.sourcePath, config, "background-review")
      diagnostics.process.bindRun(runId, run.attempt)
      const execution = diagnostics.run(controller.signal, async () => {
        diagnostics.event("review-start", { executionId, revision: run.revision, steps: run.review?.steps })
        try { await executeIngestReview(projectPath, runId, diagnostics.config, controller.signal, executionId, diagnostics) }
        finally {
          try { await diagnostics.save("review-result.json", await loadIngestRun(projectPath, runId)) }
          catch (error) { diagnostics.event("review-result-unavailable", { error: String(error) }) }
        }
      })
      await Promise.race([execution, aborted])
    } finally {
      signal?.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", onAbort)
      if (activeReviewControllers.get(key) === controller) activeReviewControllers.delete(key)
    }
  }, signal, pipelineLease)
}

/** 日志只旁观实际执行，检查顺序、累计预算和发布规则保持在原实现内。 */
async function executeIngestReview(projectPath: string, runId: string, config: LlmConfig, signal: AbortSignal | undefined, executionId: string, diagnostics: IngestDiagnostics): Promise<void> {
  signal?.throwIfAborted()
  const started = Date.now()
  const statistics = { requests: 0, inputChars: 0, outputChars: 0, failedRequests: 0, elapsedMs: 0 }
  let attemptRequests = 0
  const diagnosticConfig = config
  config = observeLlmCalls(config, (call) => {
    const { messages } = call
    if (attemptRequests++ >= MAX_REVIEW_REQUESTS) throw new Error("审阅达到本次执行的累计模型请求预算，剩余检查未完成")
    const observation = beginLlmObservation(withLlmStage(diagnosticConfig, call.stage), messages, call.overrides)
    statistics.requests++
    statistics.inputChars += JSON.stringify(messages).length
    return {
      request: async (url, body) => { await observation?.request(url, body) },
      httpStatus: (status) => { observation?.httpStatus(status) },
      rawResponse: (text) => { observation?.rawResponse(text) },
      token: (text) => { statistics.outputChars += text.length; observation?.token(text) },
      done: (completion) => { if (completion?.truncated) statistics.failedRequests++; observation?.done(completion) },
      error: (error) => { statistics.failedRequests++; observation?.error(error) },
      finish: async (aborted) => { await observation?.finish(aborted) },
    }
  })
  let run = await loadIngestRun(projectPath, runId)
  // 当前问题复核使用另存的消费快照，原 run 的写入前后正文永不被重试改写。
  if (run.review?.currentPages) for (const [path, content] of Object.entries(run.review.currentPages)) {
    // 历史事件可能引用未提交的候选页；仅在本次消费材料中补入当前页，不改写原运行快照。
    run.pages[path] = { ...run.pages[path], path, before: run.review.automaticRepair ? run.pages[path]?.before ?? null : null, after: content, revision: await contentRevision(content), unitIds: run.pages[path]?.unitIds ?? [], mode: run.pages[path]?.mode ?? "maintenance" }
  }
  const source = await readIngestRunSource(projectPath, runId)
  const [schema, prompts, paths] = await Promise.all([loadProjectSchema(projectPath, "generation"), loadProjectIngestPrompts(projectPath), wikiPaths(projectPath)])
  const purpose = await fileExists(`${projectPath}/purpose.md`) ? await readFile(`${projectPath}/purpose.md`) : ""
  let materials = await materialsFor(run, source)
  const rules = { schema, purpose, system: MODEL_RULES, background: prompts.backgroundReview, filter: prompts.review, content: prompts.acceptance }
  await diagnostics.save("review-input.json", { materials, rules, outputLanguage: useWikiStore.getState().outputLanguage })
  const { apiKey: _key, ...modelConfig } = config
  const rulesRevision = await contentRevision(JSON.stringify({ engineVersion: 14, ...rules, modelConfig, outputLanguage: useWikiStore.getState().outputLanguage }))
  const corpusIdentity = await reviewCorpusIdentity(projectPath)
  signal?.throwIfAborted()
  await updateIngestRun(projectPath, runId, (state) => {
    signal?.throwIfAborted()
    state.reviewStatus = "running"
    state.reviewExecutionId = executionId
    if (!state.review || state.review.revision !== state.revision || state.review.model?.rulesRevision !== rulesRevision) {
      if (state.review) (state.reviewHistory ??= []).push(structuredClone(state.review))
      state.review = { revision: state.revision, steps: {}, stepItems: {}, issueIds: [], updatedAt: Date.now(), currentPages: state.review?.currentPages, automaticRepair: state.review?.automaticRepair }
    }
    // 兼容旧记录，但不再按自动修复的快速发布标记跳过审阅。
    delete state.review.localRepairVerified
    if (!corpusIdentity || state.review.corpusIdentity !== corpusIdentity) {
      if (state.review.corpusIdentity && corpusIdentity && state.review.corpusIdentity !== corpusIdentity) (state.reviewHistory ??= []).push(structuredClone(state.review))
      delete state.review.steps.knowledge
      if (state.review.batches) for (const batch of state.review.batches) { batch.status = "pending"; batch.dependency = undefined }
    }
    state.review.corpusIdentity = corpusIdentity
    state.review.model = { provider: config.provider, model: config.model, rulesRevision }
    state.review.rules = rules
    if (state.review.statistics) Object.assign(statistics, state.review.statistics)
  })
  await recoverStageRepairs(projectPath, runId, config, schema, signal)
  await refreshMaterials()
  await ensureReviewBatchPlan(projectPath, run, rulesRevision)
  async function refreshMaterials(): Promise<void> {
    run = await loadIngestRun(projectPath, runId)
    for (const [path, after] of Object.entries(run.review?.currentPages ?? {})) {
      run.pages[path] = { path, before: run.pages[path]?.before ?? null, after, revision: await contentRevision(after), unitIds: run.pages[path]?.unitIds ?? [], mode: run.pages[path]?.mode ?? "maintenance" }
    }
    materials = await materialsFor(run, source)
  }
  const previousElapsed = statistics.elapsedMs
  // 崩溃后的修复只回读候选稿，随后重新检查实际页面，不再次生成或提交。
  if (run.autoRepair && !run.review?.currentPages) {
    const recoveredPages = await recoverReviewRepair(projectPath, runId)
    if (recoveredPages) {
      await prepareRepairRecheck(projectPath, runId, recoveredPages, executionId)
      return executeIngestReview(projectPath, runId, diagnosticConfig, signal, executionId, diagnostics)
    }
  }
  for (const step of STEPS) {
    signal?.throwIfAborted()
    const current = await loadIngestRun(projectPath, runId)
    if (current.reviewExecutionId !== executionId) { diagnostics.event("review-superseded", { executionId, currentExecutionId: current.reviewExecutionId }); return }
    if (current.review?.steps[step]?.status === "complete") { diagnostics.event("review-step-skipped", { step, reason: "沿用已完成检查" }); continue }
    attemptRequests = 0
    const stepStarted = Date.now()
    diagnostics.event("review-step-start", { step })
    let items: ReviewItem[] = []
    let status: "complete" | "incomplete" | "not-applicable" = "complete"
    let reason: string | undefined
    try {
      if (step === "format") {
        const pages = materials.filter((entry) => entry.id.startsWith("after-"))
        const referenceIssues = await inspectWikiReferences(projectPath, pages)
        const result = checkFormat({ pages, schema, signal, referenceIssues })
        if (result.status !== "complete") throw new Error(result.reason ?? "格式检查未完成")
        for (const issue of result.issues) {
          const page = run.pages[issue.pages[0]]
          items.push(await makeReview(run, { type: "structure", ...(issue.manual ? { subtype: "失效引用", repair: { status: "unresolved" as const, reason: "缺失引用交人工确认，不自动补页或改写目标" } } : {}), title: issue.description, description: issue.description, affectedPages: [page.path], evidence: materials.filter((entry) => entry.path === page.path && entry.id.startsWith("after-")), options: [] }, `${page.path}\0${issue.description}`))
        }
      } else if (step === "content") {
        if (run.review?.currentPages && !run.review.automaticRepair) { status = "not-applicable"; reason = "当前页已由后续操作修改；原来源转换的校验保留原版本报告" }
        else if (run.writeStatus !== "complete") { status = "not-applicable"; reason = "来源入库未完成，尚待补写的内容不判遗漏" }
        else {
          const result = await inspectIngestContent({ projectPath, sourceIdentity: run.sourceIdentity, sourcePath: run.sourcePath, sourceContent: source, schema, purpose, writtenPaths: Object.keys(run.pages), llmConfig: config, prompts, signal, coverageChecks: current.review?.coverageChecks,
            onCoverageStart: () => { attemptRequests = 0 },
            onCoverageSegment: async (id, result) => { await updateIngestRun(projectPath, runId, (state) => { if (state.review && state.reviewExecutionId === executionId) (state.review.coverageChecks ??= {})[id] = result }) },
            beforePages: Object.fromEntries(Object.values(run.pages).filter((page) => page.before !== null).map((page) => [page.path, page.before!])),
            pageSnapshot: { pages: Object.fromEntries(Object.values(run.pages).map((page) => [page.path, page.after])), knownPagePaths: paths } })
          for (const issue of result.rounds.flatMap((round) => round.issues).filter((issue) => issue.kind === "coverage")) {
            const origin = materials.find((entry) => (entry.id === "source" || entry.id.startsWith("before-")) && locateReviewQuote(entry.text, issue.sourceEvidence))
            if (!origin) throw new Error("内容校验来源或旧页证据无法定位")
            const range = locateReviewQuote(origin.text, issue.sourceEvidence)!
            const evidence: ReviewEvidence[] = [{ ...origin, text: issue.sourceEvidence, ...range }]
            for (const path of issue.pages) {
              const page = materials.find((entry) => entry.path === path && entry.id.startsWith("after-"))
              if (page) evidence.push(page)
            }
            items.push(await makeReview(run, { type: "coverage", title: issue.description, description: issue.description, evidence, affectedPages: issue.pages, options: [] }, `${issue.pages.slice().sort().join("|")}\0${issue.sourceEvidence}`))
          }
          if (result.error) { status = "incomplete"; reason = result.error }
        }
      } else {
        const result = await executeKnowledgeBatches(projectPath, run, materials, config, prompts, purpose, signal, executionId, diagnostics, await reviewCorpusIdentity(projectPath), () => { attemptRequests = 0 }, () => ({ ...statistics, elapsedMs: previousElapsed + Date.now() - started }), step)
        items = result.items; status = result.status; reason = result.reason
      }
    } catch (error) {
      signal?.throwIfAborted()
      status = "incomplete"
      reason = error instanceof Error ? error.message : String(error)
    }
    if (step !== "supplement" && items.length) {
      attemptRequests = 0
      try {
        items = await repairReviewIssues(projectPath, runId, step, items, config, schema, signal, executionId)
        await refreshMaterials()
        await ensureReviewBatchPlan(projectPath, run, rulesRevision)
      } catch (error) {
        signal?.throwIfAborted()
        status = "incomplete"
        reason = [reason, `自动处理未完成：${String(error)}`].filter(Boolean).join("；")
        items = items.map((item) => ({ ...item, repair: { status: "unresolved", reason: reason! } }))
      }
    }
    if (step === "content") for (const event of run.events.filter((entry) => entry.kind === "merge" && entry.reviewRequired)) {
      // 合并候选来自事件固定快照，与当前文件不同不代表审阅消费的当前页面已变化。
      const candidateEvidence: ReviewEvidence[] = await Promise.all(Object.entries(event.candidateSnapshots ?? {}).map(async ([path, text]) => ({ path, text, revision: await contentRevision(text), startLine: 1, endLine: text.split("\n").length,
        snapshot: { runId: run.runId, side: "candidate", eventId: event.id } })))
      if (!candidateEvidence.length && !materials.some((entry) => entry.path === event.path)) {
        status = "incomplete"; reason = [reason, `实际合并失败缺少页面证据：${event.path}`].filter(Boolean).join("；"); continue
      }
      items.push(await makeReview(run, { type: "merge", title: `合并失败：${event.path}`, description: [event.reason, event.details].filter(Boolean).join("\n"), outcome: event.outcome, evidence: [...materials.filter((entry) => entry.path === event.path), ...candidateEvidence], affectedPages: [...new Set([...(event.path ? [event.path] : []), ...candidateEvidence.map((entry) => entry.path)])], options: [] }, event.id))
    }
    items = await deduplicateReviewIssues(items)
    diagnostics.event("review-step-finish", { step, status, reason, items, elapsedMs: Date.now() - stepStarted })
    await updateIngestRun(projectPath, runId, (state) => {
      if (state.review?.revision !== run.revision || state.reviewExecutionId !== executionId) return
      state.review.steps[step] = { status, reason }
      state.review.stepItems[step] = items
      state.review.updatedAt = Date.now()
      state.review.statistics = { ...statistics, elapsedMs: previousElapsed + Date.now() - started }
    })
  }
  await withProjectLock(projectPath, async () => {
    signal?.throwIfAborted()
    const current = await loadIngestRun(projectPath, runId)
    if (!current.review || current.revision !== run.revision || current.reviewExecutionId !== executionId) return
    const historical = !await hasCurrentReviewEvidence(projectPath, current)
    const items = [...new Map(Object.values(current.review.stepItems).flat().map((item) => [item.id, { ...item, historical }])).values()]
    const currentIds = new Set(items.map((item) => item.id))
    const repairedIds = new Set((current.repairAttempts ?? []).filter((entry) => entry.status === "verified").flatMap((entry) => entry.issues.map((item) => item.id)))
    const retired = historical ? [] : (await loadReviewItems(projectPath)).filter((item) => repairedIds.has(item.id) && !currentIds.has(item.id)).map((item) => ({ ...item, historical: true }))

    const localResolutions = useWikiStore.getState().project?.path === projectPath
      ? useReviewStore.getState().items.filter((item) => item.resolutionUpdatedAt) : []
    await saveReviewItems(projectPath, [...retired, ...items, ...localResolutions])
    // 回读后端合并结果，保留外部客户端的人工处理状态和历史兼容字段。
    if (useWikiStore.getState().project?.path === projectPath) useReviewStore.getState().setItems(await loadReviewItems(projectPath))
    await updateIngestRun(projectPath, runId, (state) => {
      if (!state.review || state.reviewExecutionId !== executionId) return
      state.review.issueIds = items.map((item) => item.id)
      state.review.statistics = { ...statistics, elapsedMs: previousElapsed + Date.now() - started }
      const incomplete = historical || Object.values(state.review.steps).some((step) => step.status === "incomplete")
      state.reviewStatus = incomplete ? (items.length ? "partial" : "incomplete") : "complete"
      state.reviewRequested = false
      if (historical) state.reviewError = "审阅消费的页面已变化，结论保留为历史，需复核当前版本"
      else if (incomplete) state.reviewError = Object.values(state.review.steps).filter((step) => step.status === "incomplete").map((step) => step.reason).filter(Boolean).join("；")
      else delete state.reviewError
    })
  })
}

/** 每批独立预算和检查点；失败批次本轮不自重试，后续批次仍会执行。 */
async function executeKnowledgeBatches(
  projectPath: string, run: IngestRun, materials: Material[], config: LlmConfig,
  prompts: Awaited<ReturnType<typeof loadProjectIngestPrompts>>, purpose: string,
  signal: AbortSignal | undefined, executionId: string, diagnostics: IngestDiagnostics,
  corpusIdentity: string | undefined, resetBudget: () => void, statistics: () => NonNullable<NonNullable<IngestRun["review"]>["statistics"]>, stage: "knowledge" | "supplement",
): Promise<{ items: ReviewItem[]; status: "complete" | "incomplete"; reason?: string }> {
  if (prompts.reviewTemplate !== DEFAULT_INGEST_PROMPTS.reviewTemplate && prompts.backgroundReview === DEFAULT_INGEST_PROMPTS.backgroundReview) throw new Error("自定义旧审阅模板需迁移到后台审阅输入协议；原文件已保留，请在设置中预览并保存迁移规则")
  if (!prompts.backgroundReview.includes("contract: review-v2")) throw new Error("后台审阅提示词缺少 contract: review-v2；原文件已保留")
  const batches = (await loadIngestRun(projectPath, run.runId)).review?.batches ?? []
  if (!batches.length) return { items: [], status: "incomplete", reason: "没有实际知识页，未建立空审阅批次" }
  const reasons: string[] = []
  const collected: ReviewItem[] = []
  const checks = stage === "knowledge" ? [{
    id: "existing-knowledge", types: ["contradiction", "duplicate"],
    task: "一次检查本次实际页面及检索所得相关正文的事实冲突与实质重复；覆盖单页内部、同批页面之间及本批与已有知识之间。冲突保留双方证据，重复说明整页或局部范围、独立用途和独有内容；有事实分歧时只报冲突，不通过去重决定事实取舍",
  }] : [{ id: "suggestion", types: ["suggestion"], task: "一次核对必要的知识补充建议，合并缺页与研究的同一未知。只报直接影响当前主题理解或使用的重要未知；一般信息不全、缺源码验证、缺独立概念页不报。已标未知且无新关键影响证据不重复报告" }]

  for (const batch of batches) {
    signal?.throwIfAborted()
    if ((await loadIngestRun(projectPath, run.runId)).reviewExecutionId !== executionId) throw new Error("审阅执行已失效")
    const reusable = Boolean(batch.retrieval && (corpusIdentity ? batch.dependency === corpusIdentity : stage === "supplement") && await retrievalEvidenceCurrent(projectPath, batch.retrieval))
    if (reusable && batch.retrieval?.status === "completed" && checks.every((check) => Object.entries(batch.checks).some(([id]) => id === check.id || id.startsWith(`${check.id}:`)) && Object.entries(batch.checks).filter(([id]) => id === check.id || id.startsWith(`${check.id}:`)).every(([, saved]) => saved.status === "complete"))) { collected.push(...Object.entries(batch.checks).filter(([id]) => checks.some((check) => id === check.id || id.startsWith(`${check.id}:`))).flatMap(([, check]) => check.items)); continue }
    resetBudget()
    const started = Date.now()
    const beforeStatistics = statistics()
    const savedStatistics = batch.statistics ?? { requests: 0, inputChars: 0, outputChars: 0, failedRequests: 0 }
    if (!reusable) batch.checks = {}
    batch.status = "running"
    batch.attempts++
    delete batch.error
    const save = async () => {
      signal?.throwIfAborted()
      await updateIngestRun(projectPath, run.runId, (state) => {
        if (!state.review || state.reviewExecutionId !== executionId) throw new Error("审阅执行已失效")
        const latest = statistics()
        batch.statistics = { requests: savedStatistics.requests + latest.requests - beforeStatistics.requests, inputChars: savedStatistics.inputChars + latest.inputChars - beforeStatistics.inputChars, outputChars: savedStatistics.outputChars + latest.outputChars - beforeStatistics.outputChars, failedRequests: savedStatistics.failedRequests + latest.failedRequests - beforeStatistics.failedRequests }
        state.review.statistics = latest
        state.review.activeBatchId = batch.batchId
        const index = state.review.batches!.findIndex((entry) => entry.batchId === batch.batchId)
        if (index < 0) throw new Error("审阅批次计划已变化")
        state.review.batches![index] = structuredClone(batch)
        state.review.stepItems[stage] = [...collected, ...Object.entries(batch.checks).filter(([id]) => checks.some((check) => id === check.id || id.startsWith(`${check.id}:`))).flatMap(([, check]) => check.items)]
      })
    }
    await save()
    diagnostics.event("review-batch-start", { batchId: batch.batchId, index: batch.index, total: batches.length, pageRefs: batch.pageRefs, attempt: batch.attempts })
    try {
      const retrieval = stage === "supplement" && batch.retrieval ? batch.retrieval : await retrieveReviewBatch(projectPath, run, batch, reusable, diagnostics.process, Math.max(40_000, Math.min(160_000, Math.floor((config.maxContextSize ?? 128_000) / 4))))
      signal?.throwIfAborted()
      // 证据变化会使消费它的模型结论失效；成功目标的检索断点仍保留。
      if (JSON.stringify(batch.retrieval?.evidence) !== JSON.stringify(retrieval.evidence)) batch.checks = {}
      if (retrieval.status === "completed" && retrieval.targetResults.some((target) => target.status === "incomplete" || target.status === "not_run")) retrieval.status = "partial"
      batch.retrieval = retrieval
      batch.dependency = corpusIdentity
      await save()
      const failures: string[] = retrieval.status === "completed" ? [] : [reviewBatchError(batch, batches.length, retrieval)]
      if (!["disabled", "failed"].includes(retrieval.status)) {
        const inputs = [...materials.filter((entry) => entry.id.startsWith("after-") && batch.pageRefs.some((ref) => ref.path === entry.path)),
          ...retrieval.evidence.map((entry) => ({ id: entry.id, path: entry.path, revision: entry.revision, text: entry.text, ...entry.range }))]
        const context = { projectPurpose: purpose, ...reviewRetrievalContext(retrieval) }
        // 小批次保持一次检查；超出容量时固定分段，每段都保存消费范围及独立结果。
        const segments = reviewMaterialSegments(inputs, config.maxContextSize, prompts.backgroundReview.length + prompts.review.length + JSON.stringify(context).length)
        for (const check of checks) for (const [index, segment] of segments.entries()) {
          const checkId = segments.length === 1 ? check.id : `${check.id}:segment-${index + 1}`
          if (batch.checks[checkId]?.status === "complete") continue
          let items: ReviewItem[] = []
          let error: string | undefined
          try {
            const checkOptions = {
              llmConfig: config, task: `${check.task}。本次只允许 type=${check.types.join("|")}；检索范围有限，不宣称穷尽全库。`,
              materials: segment, policy: `${prompts.backgroundReview}\n${prompts.review}`, signal, context,
              outputLanguage: useWikiStore.getState().outputLanguage, processLog: diagnostics.process, checkId,
              targetPaths: segment.filter((entry) => entry.id.startsWith("after-")).map((entry) => entry.path),
            }
            const result = stage === "knowledge"
              ? await checkKnowledge({ ...checkOptions, onScopeCheck: async (verdict, evidence) => {
                await updateIngestRun(projectPath, run.runId, (state) => { if (state.review && state.reviewExecutionId === executionId) (state.review.scopeChecks ??= []).push({ verdict, evidence }) })
              } })
              : await checkSupplements(checkOptions)
            signal?.throwIfAborted()
            const findings = result.issues
            if (findings.some((issue) => !check.types.includes(issue.type))) throw new Error("审阅响应类型超出本次检查范围")
            for (const issue of findings) items.push(await makeReview(run, { ...issue, options: [] }, `${issue.affectedPages.slice().sort().join("|")}\0${issue.evidence.map((entry) => entry.text).sort().join("|")}`))
            for (const issue of result.pending ?? []) items.push(await makeReview(run, { ...issue, type: "confirm", options: [] }, `confirm\0${issue.affectedPages.slice().sort().join("|")}\0${issue.evidence.map((entry) => entry.text).sort().join("|")}`))
            if (result.status !== "complete") { error = result.reason ?? "知识检查未完成"; failures.push(`${checkId}：${error}`) }
          } catch (failure) {
            signal?.throwIfAborted()
            error = failure instanceof Error ? failure.message : String(failure)
            failures.push(`${checkId}：${error}`)
          }
          batch.checks[checkId] = { status: error ? "incomplete" : "complete", items, reason: error, materialRefs: segment.map(({ path, revision, startLine, endLine }) => ({ path, revision, startLine, endLine })) }
          await save()
        }
      }
      batch.status = failures.length ? "incomplete" : "complete"
      batch.error = failures.length ? failures.join("；") : undefined
    } catch (error) {
      signal?.throwIfAborted()
      batch.status = "incomplete"
      batch.error = error instanceof Error ? error.message : String(error)
    }
    batch.elapsedMs += Date.now() - started
    await save()
    if (batch.error) reasons.push(batch.error)
    collected.push(...Object.entries(batch.checks).filter(([id]) => checks.some((check) => id === check.id || id.startsWith(`${check.id}:`))).flatMap(([, check]) => check.items))
    diagnostics.event("review-batch-finish", { batchId: batch.batchId, index: batch.index, status: batch.status, error: batch.error, elapsedMs: batch.elapsedMs })
  }
  await updateIngestRun(projectPath, run.runId, (state) => {
    if (!state.review || state.reviewExecutionId !== executionId) return
    delete state.review.activeBatchId
    // 单批保留旧 API/MCP 字段；多批消费版本及分项结果以 batches 为准。
    if (batches.length === 1) {
      state.review.retrieval = batches[0].retrieval
      state.review.knowledgeChecks = batches[0].checks
    }
  })
  return { items: [...new Map(collected.map((item) => [item.id, item])).values()], status: reasons.length ? "incomplete" : "complete", reason: reasons.length ? reasons.join("；") : undefined }
}

/** 旧版已经落盘的修复结果仅作为审阅材料，不再恢复或继续修复任务。 */
async function prepareRepairRecheck(projectPath: string, runId: string, pages: Record<string, string>, executionId: string): Promise<void> {
  await updateIngestRun(projectPath, runId, (state) => {
    if (state.reviewExecutionId !== executionId) throw new Error("审阅任务已被替代，停止历史结果核查")
    if (state.review) (state.reviewHistory ??= []).push(structuredClone(state.review))
    state.review = {
      revision: state.revision, steps: {}, stepItems: {}, issueIds: [], updatedAt: Date.now(),
      currentPages: pages, automaticRepair: true, statistics: state.review?.statistics,
      model: state.review?.model, rules: state.review?.rules,
    }
  })
}
