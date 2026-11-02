import { inspectWikiReferences } from "./wiki-reference-maintenance"
/** Wiki 按最具体业务模块组织公共检查；内容覆盖始终留在入库流程。 */
import { listDirectory, readFile, fileExists } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { reviewIdFor, useReviewStore, type ReviewItem } from "@/stores/review-store"
import { parseModuleCatalog, type ModuleCatalog } from "@/features/business-modules/catalog"
import { readPageModuleIds } from "@/features/business-modules/page-tags"
import { contentRevision } from "./content-revision"
import { loadProjectSchema } from "./project-schema"
import { loadProjectIngestPrompts } from "./ingest-prompts"
import { loadReviewItems, saveReviewItems } from "./persist"
import { checkFormat, checkKnowledge, checkSupplements, prepareReviewMaterials, type ReviewMaterial, type ReviewFinding } from "./review-checks"
import { isReviewContentPath } from "./review-checks/types"
import { reviewMaterialSegments } from "./review-checks/segments"
import { reviewRetrievalContext } from "./ingest-review-materials"
import { repairWikiReviewIssues } from "./wiki-review-repair"
import { loadWikiReviewCheckpoints, checkpointDependenciesCurrent, saveWikiModuleCheckpoint, type WikiModuleCheckpoint } from "./wiki-review-checkpoints"
import type { RetrievalResult } from "./evidence-retrieval"

export interface WikiReviewProgress { completed: number; total: number; detail: string }
export interface WikiReviewReport { status: "complete" | "partial" | "incomplete" | "cancelled"; items: ReviewItem[]; reasons: string[]; changedPages?: string[] }

/** 读取一次页面正文；未分类和直属父节点的页面均单独分组，不重复聚合祖先。 */
export async function loadWikiReviewBatches(projectPath: string, signal?: AbortSignal): Promise<{ batches: { moduleId: string; name: string; pages: ReviewMaterial[] }[]; pages: ReviewMaterial[]; errors: string[] }> {
  const rawCatalog = await loadProjectSchema(projectPath, "classification")
  const parsedCatalog = parseModuleCatalog(rawCatalog)
  if (!parsedCatalog && rawCatalog.trim()) throw new Error("业务模块配置缺少有效章节，未执行检查")
  const catalog = parsedCatalog ?? parseModuleCatalog('## Business Modules\n```json\n{"version":1,"modules":[]}\n```')!
  const errors: string[] = []
  const pages: ReviewMaterial[] = []
  const groups = new Map<string, ReviewMaterial[]>()
  const root = `${projectPath}/wiki`
  const directories = [root]
  const visited = new Set<string>()
  for (let index = 0; index < directories.length; index++) {
    signal?.throwIfAborted()
    const directory = directories[index]
    if (visited.has(directory)) continue
    if (visited.size >= 10000 || directory.slice(root.length).split("/").length > 65) { errors.push(`扫描范围超限：${directory}`); continue }
    visited.add(directory)
    try {
      for (const file of await listDirectory(directory, { maxDepth: 1 })) {
        if (!file.path.startsWith(`${root}/`)) continue
        if (file.is_dir) { directories.push(file.path); continue }
        const path = file.path.slice(projectPath.length + 1)
        if (!isReviewContentPath(path) || path === "wiki/schema.md") continue
        try {
          const text = await readFile(file.path)
          const page: ReviewMaterial = { id: `after-${pages.length}`, path, text, revision: await contentRevision(text), role: "page", startLine: 1, endLine: text.split("\n").length }
          pages.push(page)
          for (const id of readPageModuleIds(text, catalog)) { const members = groups.get(id) ?? []; members.push(page); groups.set(id, members) }
        } catch (error) { errors.push(`页面未读取：${path}：${String(error)}`) }
      }
    } catch (error) { errors.push(`目录未读取：${directory}：${String(error)}`) }
  }
  return { pages, errors, batches: moduleBatches(groups, catalog) }
}

function moduleBatches(groups: Map<string, ReviewMaterial[]>, catalog: ModuleCatalog) {
  const batches: { moduleId: string; name: string; pages: ReviewMaterial[] }[] = []
  for (const [id, pages] of groups) {
    const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path))
    for (let offset = 0; offset < sorted.length; offset += 50) batches.push({ moduleId: id, name: catalog.byId.get(id)?.name ?? "未分类", pages: sorted.slice(offset, offset + 50) })
  }
  return batches
}

async function findingItem(finding: ReviewFinding): Promise<ReviewItem> {
  const identity = `${finding.type}\0${[...finding.affectedPages].sort().join("|")}\0${finding.evidence.map((entry) => entry.text).sort().join("|")}`
  const logicalId = (await contentRevision(identity)).slice(7)
  const evidenceVersion = (await contentRevision(JSON.stringify(finding.evidence.map(({ path, revision, text }) => ({ path, revision, text })).sort((a, b) => a.path.localeCompare(b.path))))).slice(7)
  const item: ReviewItem = { ...finding, schemaVersion: 2, logicalId, evidenceVersion, id: "", options: [], resolved: false, createdAt: Date.now() }
  item.id = reviewIdFor(item)
  return item
}

/** 执行公共三项检查。检索以标题和完整介绍构造查询，事实检查消费实际正文。 */
export async function runWikiReview(projectPath: string, config: LlmConfig, signal?: AbortSignal, onProgress?: (progress: WikiReviewProgress) => void, onItems?: (items: ReviewItem[]) => void): Promise<WikiReviewReport> {
  const items = new Map<string, ReviewItem>()
  const reasons: string[] = []
  const changedPages = new Set<string>()
  const restoredItemIds = new Set<string>()
  const automaticVersions = new Map<string, string>()
  const onChanged = (paths: string[], revisions: Record<string, string> = {}) => {
    for (const path of paths) { changedPages.add(path); if (revisions[path]) automaticVersions.set(path, revisions[path]) }
  }
  const report = (): WikiReviewReport => ({ status: signal?.aborted ? "cancelled" : reasons.length ? items.size ? "partial" : "incomplete" : "complete", items: [...items.values()], reasons, changedPages: [...changedPages] })
  try {
    const loaded = await loadWikiReviewBatches(projectPath, signal)
    reasons.push(...loaded.errors)
    const schema = await loadProjectSchema(projectPath, "generation")
    const prompts = await loadProjectIngestPrompts(projectPath)
    const purpose = await fileExists(`${projectPath}/purpose.md`) ? await readFile(`${projectPath}/purpose.md`) : ""
    const knownPaths = loaded.pages.map((page) => page.path)
    const policy = `${prompts.backgroundReview}\n${prompts.review}`
    const common = { policy, llmConfig: config, outputLanguage: useWikiStore.getState().outputLanguage, signal }
    const checkpoints = await loadWikiReviewCheckpoints(projectPath)
    const batches = await Promise.all(loaded.batches.map(async (batch) => ({ ...batch,
      key: await contentRevision(JSON.stringify({ moduleId: batch.moduleId, paths: batch.pages.map((page) => page.path) })),
    })))
    // 续跑以批次完成状态为准；全库、规则及正文变化不回退已经保存的进度。
    const completed = new Set(batches.filter((batch) => checkpoints.modules[batch.key]?.status === "complete"
      && Array.isArray(checkpoints.modules[batch.key].items)).map((batch) => batch.key))
    let processed = completed.size
    const oldItems = await loadReviewItems(projectPath)
    const handled = new Set(oldItems.filter((item) => item.resolved || item.hidden || item.dismissed).map((item) => item.id))
    const accept = (entries: ReviewItem[]) => {
      for (const item of entries) if (!handled.has(item.id)) items.set(item.id, item)
      // 页面按当前累计快照展示，不必等待整轮检查；恢复旧事项也走同一入口。
      onItems?.([...items.values()])
    }
    for (const batch of batches) if (completed.has(batch.key)) {
      const previous = checkpoints.modules[batch.key]
      accept(previous.items)
      for (const item of previous.items) restoredItemIds.add(item.id)
    }
    if (processed) onProgress?.({ completed: processed, total: batches.length, detail: `已恢复完成批次：${processed}/${batches.length}` })
    const referenceIssues = await inspectWikiReferences(projectPath, loaded.pages)
    const format = checkFormat({ pages: loaded.pages, schema, signal, referenceIssues })
    if (loaded.pages.length && format.status !== "complete") reasons.push(format.reason ?? "格式检查未完成")
    const formatItems = await Promise.all(format.issues.map(async (issue): Promise<ReviewItem> => {
      const evidence = loaded.pages.filter((page) => issue.pages.includes(page.path))
      const item = await findingItem({ type: "suggestion", title: issue.description, description: issue.description, evidence, affectedPages: issue.pages })
      if (issue.manual) { item.subtype = "失效引用"; item.repair = { status: "unresolved", reason: "缺失引用交人工确认，不自动补页或改写目标" } }
      item.type = "structure"; item.logicalId = (await contentRevision(`structure\0${issue.pages.join("|")}\0${issue.description}`)).slice(7); item.id = reviewIdFor(item)
      return item
    }))
    accept(await repairWikiReviewIssues(projectPath, "format", formatItems, config, schema, knownPaths, signal, onChanged))
    for (const batch of batches) {
      signal?.throwIfAborted()
      const { key } = batch
      if (completed.has(key)) continue
      onProgress?.({ completed: processed, total: batches.length, detail: `正在检查：${batch.name}（${batch.pages.length} 篇）` })
      const moduleItems = new Map<string, ReviewItem>()
      const acceptModule = (entries: ReviewItem[]) => { accept(entries); for (const entry of entries) moduleItems.set(entry.id, entry) }
      let checkpoint: WikiModuleCheckpoint | undefined
      try {
        // 格式或前一模块的自动整理可能改变正文，开始本批前刷新完整快照。
        const targets = await Promise.all(batch.pages.map(async (page) => { const text = await readFile(`${projectPath}/${page.path}`); return { ...page, text, revision: await contentRevision(text), endLine: text.split("\n").length } }))
        checkpoint = { executionId: crypto.randomUUID(), moduleId: batch.moduleId, name: batch.name, status: "running",
          members: targets.map(({ path, revision }) => ({ path, revision })), dependencies: [], items: [], updatedAt: Date.now() }
        await saveWikiModuleCheckpoint(projectPath, key, checkpoint)
        const retrieved: RetrievalResult[] = []
        for (let offset = 0; offset < targets.length; offset += 8) retrieved.push(await prepareReviewMaterials({
          projectPath, targets: targets.slice(offset, offset + 8), signal,
          scope: { corpus: "wiki", excludePaths: targets.map((page) => page.path) },
          budget: { timeLimitMs: 60_000, candidateLimit: 320, queryLimit: 32, contextCharLimit: Math.max(40_000, Math.min(160_000, Math.floor(config.maxContextSize / 4))) },
        }))
        for (const result of retrieved) if (result.status !== "completed" || result.targetResults.some((target) => ["incomplete", "not_run"].includes(target.status))) reasons.push(`${batch.name}：相关知识召回未完成`)
        const refs = [...new Map(retrieved.flatMap((result) => result.evidence).filter((entry) => !targets.some((page) => page.path === entry.path)).map((entry) => [entry.id, { id: entry.id, path: entry.path, text: entry.text, revision: entry.revision, ...entry.range, role: "related" as const }])).values()]
        // 保留同一路径的不同消费版本，不能用后来的片段覆盖旧版本并误判完成。
        const consumed = [...new Map([...targets, ...refs].map(({ path, revision }) => [`${path}\0${revision}`, { path, revision }])).values()]
        const context = { projectPurpose: purpose, retrieval: retrieved.map(reviewRetrievalContext) }
        const segments = reviewMaterialSegments([...targets, ...refs], config.maxContextSize, policy.length + JSON.stringify(context).length)
        const knowledgeItems: ReviewItem[] = []
        let complete = retrieved.every((result) => result.status === "completed" && !result.targetResults.some((target) => ["incomplete", "not_run"].includes(target.status)))
        if (new Set(consumed.map((entry) => entry.path)).size !== consumed.length) {
          complete = false
          reasons.push(`${batch.name}：检查材料已变化，召回包含同一页面的不同版本`)
        }
        for (const segment of segments) {
          const targetPaths = segment.filter((page) => page.role === "page").map((page) => page.path)
          const result = await checkKnowledge({ ...common, materials: segment, targetPaths, context })
          if (result.status !== "complete") { complete = false; reasons.push(`${batch.name}：${result.reason ?? "已有知识检查未完成"}`) }
          knowledgeItems.push(...await Promise.all(result.issues.map(findingItem)))
          for (const finding of result.pending ?? []) {
            const item = await findingItem(finding)
            item.type = "confirm"; item.logicalId = (await contentRevision(`confirm\0${item.logicalId}`)).slice(7); item.id = reviewIdFor(item)
            knowledgeItems.push(item)
          }
        }
        // 只有本批关系检查完整时才自动整理，避免遗漏冲突的部分材料触发合并。
        acceptModule(complete ? await repairWikiReviewIssues(projectPath, "knowledge", knowledgeItems, config, schema, knownPaths, signal, onChanged) : knowledgeItems)
        // 补充检查消费自动整理后的正文，不沿用修改前的片段。
        for (const segment of segments) {
          const refreshed = await Promise.all(segment.map(async (page) => {
            const text = await readFile(`${projectPath}/${page.path}`)
            if (await contentRevision(text) === page.revision) return page
            return { ...page, text, revision: await contentRevision(text), startLine: 1, endLine: text.split("\n").length }
          }))
          const result = await checkSupplements({ ...common, materials: refreshed, targetPaths: refreshed.filter((page) => page.role === "page").map((page) => page.path), context })
          if (result.status !== "complete") { complete = false; reasons.push(`${batch.name}：${result.reason ?? "知识补充检查未完成"}`) }
          acceptModule(await Promise.all(result.issues.map(findingItem)))
        }

        checkpoint.members = targets.map(({ path, revision }) => ({ path, revision: automaticVersions.get(path) ?? revision }))
        checkpoint.dependencies = consumed.map(({ path, revision }) => ({ path, revision: automaticVersions.get(path) ?? revision }))
        if (!await checkpointDependenciesCurrent(projectPath, checkpoint.dependencies)) { complete = false; reasons.push(`${batch.name}：检查材料已变化，模块未标记完成`) }
        checkpoint.status = complete && !signal?.aborted && !loaded.errors.length ? "complete" : "incomplete"
        checkpoint.items = [...moduleItems.values()]
        checkpoint.reason = checkpoint.status === "complete" ? undefined : "模块存在未完成检查或证据变化"
        checkpoint.updatedAt = Date.now()
        await saveWikiModuleCheckpoint(projectPath, key, checkpoint, true)
        checkpoints.modules[key] = checkpoint
      } catch (error) {
        if (checkpoint) {
          checkpoint.status = "incomplete"; checkpoint.reason = error instanceof Error ? error.message : String(error)
          checkpoint.items = [...moduleItems.values()]; checkpoint.updatedAt = Date.now()
          await saveWikiModuleCheckpoint(projectPath, key, checkpoint, true)
        }
        signal?.throwIfAborted()
        reasons.push(`${batch.name}：${error instanceof Error ? error.message : String(error)}`)
      }
      onProgress?.({ completed: ++processed, total: batches.length, detail: `已检查：${batch.name}` })
    }
    // 只发布仍对应当前版本的证据；自动整理后的失败事项保留实际状态说明。
    // 已完成批次只恢复事项；旧证据变更或文件删除时标记历史，不回退任务进度。
    for (const item of items.values()) for (const entry of item.evidence ?? []) {
      let current = false
      try { current = await contentRevision(await readFile(`${projectPath}/${entry.path}`)) === entry.revision }
      catch { /* 页面可能已经删除；旧事项仍保留为历史记录。 */ }
      if (!current) {
        item.historical = true
        if (!restoredItemIds.has(item.id)) reasons.push(`消费证据已变化：${entry.path}`)
        break
      }
    }
    const changedVersions = new Map<string, string>()
    for (const path of changedPages) changedVersions.set(path, await contentRevision(await readFile(`${projectPath}/${path}`)))
    const retired = (changedPages.size ? await loadReviewItems(projectPath) : []).filter((item) => !items.has(item.id) && item.evidence?.some((entry) =>
      !["before", "source"].includes(entry.snapshot?.side ?? "") && changedVersions.has(entry.path) && changedVersions.get(entry.path) !== entry.revision,
    )).map((item) => ({ ...item, historical: true }))
    await saveReviewItems(projectPath, [...retired, ...items.values()])
    const saved = await loadReviewItems(projectPath)
    for (const item of saved) if (item.resolved || item.hidden || item.dismissed) items.delete(item.id)
    if (useWikiStore.getState().project?.path === projectPath) useReviewStore.getState().setItems(saved)
  } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)) }
  onItems?.([...items.values()])
  return report()
}
