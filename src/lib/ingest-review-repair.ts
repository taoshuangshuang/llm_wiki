/** 持久化的一轮自动修复、定向复查及历史候选兼容恢复。 */
import { readFile } from "@/commands/fs"
import { loadIngestRun, updateIngestRun } from "./ingest-run"

import { compareAndWriteFile, listDirectory } from "@/commands/fs"
import { normalizeReviewItems, useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { embedPage } from "./embedding"
import { extractPageTitle } from "./frontmatter"
import { contentRevision, listIngestRuns, readIngestRunSource, type IngestRepairAttempt } from "./ingest-run"
import { REPAIR_RULES, VERIFY_RULES, normalizeStructure, repairRequest } from "./review-checks/repair"
import { inspectStructure } from "./review-checks/format"
import { parseSources } from "./sources-merge"
import { withProjectLock } from "./project-mutex"
import { loadReviewItems } from "./persist"

/** 重启后只核实已持久化候选稿，不重新调用生成器，也不重放提交。 */
export async function recoverReviewRepair(projectPath: string, runId: string): Promise<Record<string, string> | undefined> {
  const run = await loadIngestRun(projectPath, runId)
  if (!run.autoRepair) return undefined
  const pages: Record<string, string> = {}
  let changed = false
  for (const [path, page] of Object.entries(run.pages)) {
    const attempt = run.autoRepair.pages[path]
    const current = await readFile(`${projectPath}/${path}`)
    pages[path] = current
    if (attempt && current === attempt.proposed && current !== attempt.before) changed = true
    // 修复之外的修改留给普通版本过期逻辑，不把它冒充本次修复结果。
    else if (current !== page.after) return undefined
  }
  const allApplied = changed && Object.entries(run.autoRepair.pages).every(([path, attempt]) => pages[path] === attempt.proposed)
  if (run.autoRepair.status === "running" || allApplied && run.autoRepair.status !== "applied") await updateIngestRun(projectPath, runId, (state) => {
    state.autoRepair!.status = allApplied ? "applied" : "failed"
    state.autoRepair!.reason = "已回读核对候选稿的实际提交状态，未重新执行修复"
    for (const [path, attempt] of Object.entries(state.autoRepair!.pages)) {
      attempt.status = pages[path] === attempt.proposed ? "applied" : "failed"
    }
  })
  return changed ? pages : undefined
}



/** 标题与分段编号不参与问题身份，覆盖问题以来源事实标识，其他问题以逐字证据标识。 */
export async function repairIssueKey(item: ReviewItem): Promise<string> {
  const evidence = (item.evidence ?? []).filter((entry) => item.type !== "coverage" || ["source", "before"].includes(entry.snapshot?.side ?? ""))
  return contentRevision(JSON.stringify({ type: item.type, pages: item.type === "suggestion" ? [] : [...item.affectedPages ?? []].sort(),
    facts: item.type === "structure" ? [item.description] : evidence.map((entry) => [item.type === "suggestion" ? "" : entry.path, entry.text.replace(/\s+/g, "")]).sort() }))
}

/** 相同事实在多个分段发现时保留一个事项并合并证据；不按模型生成的标题去重。 */
export async function deduplicateReviewIssues(items: ReviewItem[]): Promise<ReviewItem[]> {
  const result = new Map<string, ReviewItem>()
  for (const item of items) {
    const key = await repairIssueKey(item)
    const previous = result.get(key)
    if (!previous) { result.set(key, item); continue }
    previous.evidence = [...new Map([...(previous.evidence ?? []), ...(item.evidence ?? [])].map((entry) => [JSON.stringify(entry), entry])).values()]
    previous.affectedPages = [...new Set([...previous.affectedPages ?? [], ...item.affectedPages ?? []])]
  }
  return [...result.values()]
}

/** 将提交的实际结果纳入后续检查，保留原始入库前后快照供人工追溯。 */
async function captureRepairPages(projectPath: string, runId: string, attempt: IngestRepairAttempt): Promise<void> {
  for (const [path, page] of Object.entries(attempt.pages)) {
    page.actual = await readFile(`${projectPath}/${path}`)
    if (page.actual === page.proposed) page.status = "applied"
  }
  await updateIngestRun(projectPath, runId, (run) => {
    const saved = run.repairAttempts!.find((entry) => entry.id === attempt.id)!
    Object.assign(saved, attempt)
    if (!run.review) return
    let changed = false
    for (const [path, page] of Object.entries(attempt.pages)) if (page.actual === page.proposed) {
      if ((run.review.currentPages?.[path] ?? run.pages[path]?.after) !== page.actual) changed = true
      run.review.currentPages ??= Object.fromEntries(Object.values(run.pages).map((entry) => [entry.path, entry.after]))
      run.review.currentPages[path] = page.actual
      run.review.automaticRepair = true
    }
    if (!changed) return
    // 修复改变消费正文后只失效检查点，不清理修复账本或历史事项。
    delete run.review.coverageChecks
    delete run.review.corpusIdentity
    delete run.review.retrieval
    delete run.review.knowledgeChecks
    delete run.review.steps.knowledge
    delete run.review.steps.supplement
    for (const batch of run.review.batches ?? []) { batch.checks = {}; batch.status = "pending"; delete batch.dependency; delete batch.retrieval }
  })
}

/** 普通恢复只读实际文件。重要档案获批后允许一次复查，仍不生成或重放补丁。 */
export async function recoverStageRepairs(projectPath: string, runId: string, config: LlmConfig, schema: string, signal?: AbortSignal): Promise<void> {
  const run = await loadIngestRun(projectPath, runId)
  for (const attempt of run.repairAttempts ?? []) {
    if (!["running", "applied", "approval-required"].includes(attempt.status)) continue
    try {
      await captureRepairPages(projectPath, runId, attempt)
      const applied = Object.keys(attempt.pages).length > 0 && Object.values(attempt.pages).every((page) => page.actual === page.proposed)
      if (applied && !attempt.verificationStarted) await verifyRepair(projectPath, runId, attempt, config, schema, signal)
      else if (attempt.status !== "approval-required") await updateIngestRun(projectPath, runId, (state) => {
        const saved = state.repairAttempts!.find((entry) => entry.id === attempt.id)!
        saved.status = "failed"; saved.reason = "任务中断；已核实实际页面，未重新生成或重放修复，交人工核查"
      })
    } catch (error) {
      signal?.throwIfAborted()
      await updateIngestRun(projectPath, runId, (state) => {
        const saved = state.repairAttempts!.find((entry) => entry.id === attempt.id)!
        saved.status = "failed"; saved.reason = `恢复核实失败，未重放修复：${String(error)}`
      })
    }
  }
}

/** 复查意图也先持久化；调用中断不会因重启重新获得复查或修复额度。 */
async function verifyRepair(projectPath: string, runId: string, attempt: IngestRepairAttempt, config: LlmConfig, schema: string, signal?: AbortSignal): Promise<void> {
  await updateIngestRun(projectPath, runId, (state) => { state.repairAttempts!.find((entry) => entry.id === attempt.id)!.verificationStarted = true })
  attempt.verificationStarted = true
  try {
    const available = new Set<string>()
    const collect = (nodes: Awaited<ReturnType<typeof listDirectory>>) => { for (const node of nodes) { if (node.is_dir) collect(node.children ?? []); else if (node.name.endsWith(".md")) available.add(node.name.replace(/\.md$/, "")) } }
    collect(await listDirectory(`${projectPath}/wiki`))
    for (const [path, page] of Object.entries(attempt.pages)) {
      const oldSources = parseSources(page.before)
      const newSources = new Set(parseSources(page.proposed))
      if (oldSources.some((source) => !newSources.has(source))) throw new Error(`来源引用被移除：${path}`)
      const body = (text: string) => text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "")
      if (attempt.stage === "format" && body(page.before) !== body(page.proposed)) throw new Error(`格式修复改变了正文：${path}`)
      const targets = (text: string) => [...text.matchAll(/(?<!!)\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map((match) => match[1].trim().replace(/\.md$/, ""))
      const beforeTargets = new Set(targets(page.before))
      for (const target of targets(page.proposed)) if (!beforeTargets.has(target) && !available.has(target)) throw new Error(`修复引入无效引用：${path} -> ${target}`)
      if (await readFile(`${projectPath}/${path}`) !== page.proposed) throw new Error(`复查前页面版本已变化：${path}`)
      const issues = inspectStructure(path, page.proposed, schema)
      if (issues.length) throw new Error(issues.map((entry) => `${path}：${entry.description}`).join("；"))
    }
    // 正文提交后同步其向量版本，避免本次自动修复制造过期召回并阻塞下一项检查。
    const embedding = useWikiStore.getState().embeddingConfig
    if (embedding.enabled && useWikiStore.getState().project?.path === projectPath) for (const [path, page] of Object.entries(attempt.pages)) {
      const indexed = await embedPage(projectPath, path.replace(/^wiki\//, "").replace(/\.md$/, ""), extractPageTitle(page.proposed) ?? path, page.proposed, embedding, {
        commit: async (write) => withProjectLock(projectPath, async () => {
          signal?.throwIfAborted()
          if (await readFile(`${projectPath}/${path}`) !== page.proposed) return false
          await write(); return true
        }),
      })
      if (!indexed) throw new Error(`修复正文已提交，但向量索引未完成：${path}`)
    }
    const result = await repairRequest(config, VERIFY_RULES, { stage: attempt.stage, issues: attempt.issues, pages: attempt.pages, source: await readIngestRunSource(projectPath, runId), beforePages: Object.fromEntries(Object.values((await loadIngestRun(projectPath, runId)).pages).filter((page) => page.before !== null).map((page) => [page.path, page.before])) }, signal) as { passed?: boolean; reason?: string }
    if (typeof result.reason !== "string" || !result.reason.trim() || result.passed !== true) throw new Error(result.reason || "修复复查未通过或协议无效")
    for (const [path, page] of Object.entries(attempt.pages)) if (await readFile(`${projectPath}/${path}`) !== page.proposed) throw new Error(`复查期间页面版本已变化：${path}`)
    attempt.status = "verified"; attempt.reason = result.reason
  } catch (error) {
    attempt.status = "failed"; attempt.reason = `修复复查失败：${String(error)}`
  }
  await updateIngestRun(projectPath, runId, (state) => {
    Object.assign(state.repairAttempts!.find((entry) => entry.id === attempt.id)!, attempt)
    if (attempt.status === "verified" && state.review) {
      const fixedIds = new Set(attempt.issues.map((item) => item.id))
      for (const [step, items] of Object.entries(state.review.stepItems)) state.review.stepItems[step] = items.filter((item) => !fixedIds.has(item.id))
    }
  })
  signal?.throwIfAborted()
}

/** 每个阶段一次方案、一次应用、一次复查；失败保留实际提交，不回滚、不递归修复。 */
export async function repairReviewIssues(projectPath: string, runId: string, stage: IngestRepairAttempt["stage"], items: ReviewItem[], config: LlmConfig, schema: string, signal?: AbortSignal, executionId?: string): Promise<ReviewItem[]> {
  items = await deduplicateReviewIssues(items)
  const conflictedPaths = new Set(items.filter((item) => item.type === "contradiction" || item.type === "confirm").flatMap((item) => item.affectedPages ?? []))
  items = items.filter((item) => item.type !== "duplicate" || !item.affectedPages?.some((path) => conflictedPaths.has(path)))
  const run = await loadIngestRun(projectPath, runId)
  const previous = (await listIngestRuns(projectPath)).filter((entry) => entry.sourceIdentity === run.sourceIdentity && entry.sourceRevision === run.sourceRevision)
  const attempts = previous.flatMap((entry) => entry.repairAttempts ?? [])
  const local = useWikiStore.getState().project?.path === projectPath ? useReviewStore.getState().items : []
  const manual = normalizeReviewItems([...await loadReviewItems(projectPath), ...local])
  const manualKeys = new Map(await Promise.all(manual.filter((entry) => entry.resolved || entry.hidden || entry.dismissed).map(async (entry) => [await repairIssueKey(entry), entry] as const)))
  const fresh: ReviewItem[] = []
  const pending: ReviewItem[] = []
  const issueKeys: string[] = []
  for (const item of items) {
    if (item.subtype === "失效引用" || !["structure", "coverage", "duplicate"].includes(item.type)) { pending.push(item); continue }
    const key = await repairIssueKey(item)
    const old = attempts.find((attempt) => attempt.stage === stage && (attempt.issueKeys.includes(key) || attempt.issues.some((previous) => previous.type === item.type && previous.affectedPages?.some((path) => item.affectedPages?.includes(path)))))
    const handled = manualKeys.get(key) ?? manual.find((entry) => entry.id === item.id && (entry.resolved || entry.hidden || entry.dismissed))
    if (handled) { pending.push({ ...item, ...handled }); continue }
    if (run.autoRepair && (run.autoRepair.issues.some((entry) => entry.id === item.id || entry.logicalId && entry.logicalId === item.logicalId) || item.affectedPages?.some((path) => run.autoRepair!.pages[path]))) {
      pending.push({ ...item, repair: { status: "unresolved", reason: "历史问题已消耗修复额度，交人工处理" } }); continue
    }
    if (old) {
      // 成功记录不能替代本次事实判断；同页再次发现问题时保留事项，但不重置修复额度。
      const reason = old.status === "verified" ? "该页同类问题已执行并通过一轮修复；本次重新发现的问题保留交人工核查，不再次自动修改" : old.reason ?? "同一问题已消耗修复额度，交人工处理"
      pending.push({ ...item, repair: { status: "unresolved", reason }, outcome: `${reason}。页面实际状态见修复记录。` }); continue
    }
    fresh.push(item); issueKeys.push(key)
  }
  if (!fresh.length) return pending
  const attempt: IngestRepairAttempt = { id: crypto.randomUUID(), stage, inputRevision: run.sourceRevision, issueKeys, issues: fresh, status: "running", startedAt: Date.now(), pages: {} }
  // 先登记额度，再读取或调用模型；任何错误均不允许下一次普通审阅重新生成。
  await updateIngestRun(projectPath, runId, (state) => { (state.repairAttempts ??= []).push(attempt) })
  try {
    const paths = new Set(fresh.flatMap((item) => item.affectedPages ?? []))
    if (!paths.size) for (const path of Object.keys(run.pages)) paths.add(path)
    const pages: Record<string, string> = {}
    for (const path of paths) {
      if (!/^wiki\/.+\.md$/.test(path) || /[\\\x00-\x1f:]/.test(path) || path.split("/").some((part) => !part || part.startsWith("."))) throw new Error(`修复路径无效：${path}`)
      pages[path] = await readFile(`${projectPath}/${path}`)
      const expected = run.review?.currentPages?.[path] ?? run.pages[path]?.after ?? fresh.flatMap((item) => item.evidence ?? []).find((entry) => entry.path === path)?.revision
      if (expected && expected !== pages[path] && expected !== await contentRevision(pages[path])) throw new Error(`生成修复前页面已变化：${path}`)
    }
    const beforePages = Object.fromEntries(Object.values(run.pages).filter((page) => page.before !== null).map((page) => [page.path, page.before]))
    const normalized = Object.entries(pages).map(([path, content]) => ({ path, content: normalizeStructure(content) }))
    const deterministic = stage === "format" && normalized.every((entry) => !inspectStructure(entry.path, entry.content, schema).length)
    const plan = deterministic ? { reason: "程序规范化来源和相关链接列表，保留正文", changes: normalized } : await repairRequest(config, REPAIR_RULES, { stage, issues: fresh, pages, beforePages, source: await readIngestRunSource(projectPath, runId), schema }, signal) as { reason?: string; changes?: { path: string; content: string }[] }
    if (typeof plan.reason !== "string" || !plan.reason.trim() || !Array.isArray(plan.changes) || !plan.changes.length) throw new Error(plan.reason || "未生成有效修复方案")
    for (const change of plan.changes) {
      if (!Object.prototype.hasOwnProperty.call(pages, change.path) || typeof change.content !== "string" || !change.content.trim() || attempt.pages[change.path]) throw new Error("修复方案含无效、重复或未授权路径")
      const problems = inspectStructure(change.path, change.content, schema)
      if (problems.length) throw new Error(problems.map((entry) => entry.description).join("；"))
      if (change.content !== pages[change.path]) attempt.pages[change.path] = { before: pages[change.path], proposed: change.content, status: "proposed" }
    }
    if (!Object.keys(attempt.pages).length) throw new Error("修复方案没有实际修改")
    attempt.reason = plan.reason
    await updateIngestRun(projectPath, runId, (state) => { Object.assign(state.repairAttempts!.find((entry) => entry.id === attempt.id)!, attempt) })
    await withProjectLock(projectPath, async () => {
      signal?.throwIfAborted()
      const current = await loadIngestRun(projectPath, runId)
      if (executionId && current.reviewExecutionId !== executionId) throw new Error("审阅执行已被替代，未提交修复")
      for (const [path, before] of Object.entries(pages)) if (await readFile(`${projectPath}/${path}`) !== before) throw new Error(`提交修复前页面已变化：${path}`)
      for (const [path, page] of Object.entries(attempt.pages)) {
        signal?.throwIfAborted()
        try { await compareAndWriteFile(projectPath, path, page.before, page.proposed); page.status = "applied" }
        catch (error) {
          if (String(error).includes("FILE_APPROVAL_REQUIRED")) { page.status = "approval-required"; attempt.status = "approval-required" }
          else { page.status = "failed"; throw error }
        }
      }
    })
    await captureRepairPages(projectPath, runId, attempt)
    if (attempt.status === "approval-required") {
      attempt.reason = "重要档案候选稿等待人工审核；原文未被覆盖，批准后只复查、不重做修复"
    } else {
      attempt.status = "applied"
      await verifyRepair(projectPath, runId, attempt, config, schema, signal)
    }
  } catch (error) {
    attempt.status = "failed"; attempt.reason = String(error)
    // 即使响应丢失也回读实际页面，不宣称没有变化。
    try { await captureRepairPages(projectPath, runId, attempt) } catch (readError) { attempt.reason += `；实际状态核实失败：${String(readError)}` }
  }
  await updateIngestRun(projectPath, runId, (state) => { Object.assign(state.repairAttempts!.find((entry) => entry.id === attempt.id)!, attempt) })
  signal?.throwIfAborted()
  if ((attempt as IngestRepairAttempt).status === "verified") return pending
  const changed = Object.entries(attempt.pages).filter(([, page]) => page.actual === page.proposed).map(([path]) => path)
  const failures: ReviewItem[] = []
  for (const item of fresh) {
    const evidence = await Promise.all((item.evidence ?? []).map(async (entry) => {
      const page = attempt.pages[entry.path]
      // 初始证据保存在 attempt.issues；卡片上的消费正文跟随已确认提交，避免失败事项被误作历史隐藏。
      if (!page || page.actual !== page.proposed) return entry
      return { path: entry.path, revision: await contentRevision(page.actual), text: page.actual, startLine: 1, endLine: page.actual.split("\n").length }
    }))
    failures.push({ ...item, evidence, repair: { status: "unresolved", reason: attempt.reason ?? attempt.status },
      outcome: `已尝试一轮修复。${attempt.reason}。${changed.length ? `已改变页面：${changed.join("、")}；保留提交结果和前后快照，未回退` : "未确认有页面改变；实际状态见修复记录"}` })
  }
  return [...pending, ...failures]
}
