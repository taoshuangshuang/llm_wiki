/** Wiki 检查的自动处理账本；共用入库修复及复核规则，不创建入库任务。 */
import { fileExists, readFile, writeFileAtomic, compareAndWriteFile } from "@/commands/fs"
import type { ReviewItem } from "@/stores/review-store"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { loadReviewItems } from "./persist"
import { contentRevision } from "./content-revision"
import { withProjectLock } from "./project-mutex"
import { parseSources } from "./sources-merge"
import { embedPage } from "./embedding"
import { extractPageTitle } from "./frontmatter"
import { inspectStructure } from "./review-checks/format"
import { normalizeStructure, repairRequest, REPAIR_RULES, VERIFY_RULES } from "./review-checks/repair"

interface Attempt {
  id: string
  issues: ReviewItem[]
  keys: string[]
  status: "running" | "verified" | "failed"
  reason?: string
  pages: Record<string, { before: string; proposed: string }>
}
interface Ledger { version: 1; attempts: Attempt[] }

async function issueKey(issue: ReviewItem): Promise<string> {
  return contentRevision(JSON.stringify({ type: issue.type, description: issue.type === "structure" ? issue.description : undefined, pages: [...issue.affectedPages ?? []].sort(), evidence: (issue.evidence ?? []).map((entry) => [entry.path, entry.revision, entry.text]).sort() }))
}

/** 一次方案、一次提交和独立复核。失败保留实际状态，重复运行不重放方案。 */
export async function repairWikiReviewIssues(
  projectPath: string, stage: "format" | "knowledge", items: ReviewItem[], config: LlmConfig, schema: string,
  knownPaths: string[], signal?: AbortSignal, onChanged?: (paths: string[], revisions?: Record<string, string>) => void,
): Promise<ReviewItem[]> {
  const ledgerPath = `${projectPath}/.llm-wiki/wiki-review-repairs.json`
  const conflicts = new Set(items.filter((item) => item.type === "contradiction" || item.type === "confirm").flatMap((item) => item.affectedPages ?? []))
  const manual = await loadReviewItems(projectPath)
  const pending: ReviewItem[] = []
  const fresh: ReviewItem[] = []
  const keys: string[] = []
  let ledger!: Ledger
  await withProjectLock(projectPath, async () => {
    ledger = await fileExists(ledgerPath) ? JSON.parse(await readFile(ledgerPath)) : { version: 1, attempts: [] }
    if (ledger.version !== 1 || !Array.isArray(ledger.attempts)) throw new Error("Wiki 自动处理记录无效，未执行修改")
    for (const item of items) {
      if (manual.some((old) => old.id === item.id && (old.resolved || old.dismissed || old.hidden))) continue
      if (item.subtype === "失效引用" || !["structure", "duplicate"].includes(item.type)) { pending.push(item); continue }
      if (item.type === "duplicate" && item.affectedPages?.some((path) => conflicts.has(path))) continue
      const key = await issueKey(item)
      let old = ledger.attempts.find((attempt) => attempt.keys.includes(key))
      // 部分提交产生的新版本不刷新同一组问题的额度；人工另行修改的版本可重新检查。
      if (!old) for (const attempt of ledger.attempts) {
        const previous = attempt.issues?.find((entry) => entry.type === item.type && (item.type !== "structure" || entry.description === item.description) && [...entry.affectedPages ?? []].sort().join("\0") === [...item.affectedPages ?? []].sort().join("\0"))
        if (!previous) continue
        let onlyRecordedVersions = true
        for (const entry of item.evidence ?? []) {
          const page = attempt.pages[entry.path]
          const versions = page ? [await contentRevision(page.before), await contentRevision(page.proposed)] : (previous.evidence ?? []).filter((evidence) => evidence.path === entry.path).map((evidence) => evidence.revision)
          if (!versions.includes(entry.revision)) { onlyRecordedVersions = false; break }
        }
        if (onlyRecordedVersions) { old = attempt; break }
      }
      if (old) { pending.push({ ...item, repair: { status: "unresolved", reason: old.reason ?? "已尝试自动处理，未重放写入，请人工核查" } }); continue }
      keys.push(key); fresh.push(item)
    }
    if (fresh.length) {
      ledger.attempts.push({ id: crypto.randomUUID(), keys, issues: fresh, status: "running", pages: {} })
      await writeFileAtomic(ledgerPath, JSON.stringify(ledger))
    }
  })
  if (!fresh.length) return pending
  const attempt = ledger.attempts[ledger.attempts.length - 1]
  const saveAttempt = async () => {
    const current: Ledger = JSON.parse(await readFile(ledgerPath))
    const index = current.attempts.findIndex((entry) => entry.id === attempt.id)
    if (index < 0) throw new Error("自动处理记录已变化")
    current.attempts[index] = attempt
    await writeFileAtomic(ledgerPath, JSON.stringify(current))
  }
  try {
    signal?.throwIfAborted()
    const paths = [...new Set(fresh.flatMap((item) => item.affectedPages ?? []))]
    const pages: Record<string, string> = {}
    // 生成前核对全部消费证据，避免依据旧版本自动修改。
    for (const item of fresh) for (const evidence of item.evidence ?? []) {
      if (!knownPaths.includes(evidence.path) || await contentRevision(await readFile(`${projectPath}/${evidence.path}`)) !== evidence.revision) throw new Error(`检查证据已变化：${evidence.path}`)
    }
    for (const path of paths) {
      if (!knownPaths.includes(path)) throw new Error(`未授权修改路径：${path}`)
      pages[path] = await readFile(`${projectPath}/${path}`)
    }
    const normalized = Object.entries(pages).map(([path, text]) => ({ path, content: normalizeStructure(text) }))
    const deterministic = stage === "format" && normalized.every((page) => !inspectStructure(page.path, page.content, schema).length)
    const plan = deterministic ? { reason: "规范化列表格式，保留正文", changes: normalized }
      : await repairRequest(config, REPAIR_RULES, { stage, issues: fresh, pages, beforePages: pages, source: "", schema }, signal) as { reason: string; changes: { path: string; content: string }[] }
    if (!plan.reason || !Array.isArray(plan.changes) || !plan.changes.length) throw new Error("没有有效自动处理方案")
    for (const change of plan.changes) {
      if (!(change.path in pages) || typeof change.content !== "string" || !change.content.trim() || attempt.pages[change.path]) throw new Error("方案包含无效或重复路径")
      const problems = inspectStructure(change.path, change.content, schema)
      if (problems.length) throw new Error(problems.map((issue) => issue.description).join("；"))
      if (parseSources(pages[change.path]).some((source) => !parseSources(change.content).includes(source))) throw new Error("修复删除了来源引用")
      if (stage === "format" && body(pages[change.path]) !== body(change.content)) throw new Error("格式修复改变了正文")
      const beforeLinks = links(pages[change.path])
      for (const link of links(change.content)) if (!beforeLinks.includes(link) && !knownPaths.some((path) => path === `wiki/${link}.md` || path.split("/").pop() === `${link}.md`)) throw new Error(`修复引入无效引用：${link}`)
      if (change.content !== pages[change.path]) attempt.pages[change.path] = { before: pages[change.path], proposed: change.content }
    }
    if (!Object.keys(attempt.pages).length) throw new Error("方案没有实际修改")
    attempt.reason = plan.reason
    await withProjectLock(projectPath, async () => {
      signal?.throwIfAborted()
      const manualNow = [...await loadReviewItems(projectPath), ...(useWikiStore.getState().project?.path === projectPath ? useReviewStore.getState().items : [])]
      if (manualNow.some((item) => fresh.some((issue) => issue.id === item.id) && (item.resolved || item.hidden || item.dismissed))) throw new Error("事项已由人工处理，未提交自动修改")
      for (const [path, text] of Object.entries(pages)) if (await readFile(`${projectPath}/${path}`) !== text) throw new Error(`提交前页面已变化：${path}`)
      await saveAttempt()
      for (const [path, page] of Object.entries(attempt.pages)) { signal?.throwIfAborted(); await compareAndWriteFile(projectPath, path, page.before, page.proposed) }
    })
    const embedding = useWikiStore.getState().embeddingConfig
    if (embedding.enabled && useWikiStore.getState().project?.path === projectPath) for (const [path, page] of Object.entries(attempt.pages)) {
      const indexed = await embedPage(projectPath, path.replace(/^wiki\//, "").replace(/\.md$/, ""), extractPageTitle(page.proposed) ?? path, page.proposed, embedding, {
        commit: async (write) => withProjectLock(projectPath, async () => {
          signal?.throwIfAborted()
          if (await readFile(`${projectPath}/${path}`) !== page.proposed) return false
          await write(); return true
        }),
      })
      if (!indexed) throw new Error(`正文已提交，但索引未同步：${path}`)
    }
    const verification = await repairRequest(config, VERIFY_RULES, { stage, issues: fresh, pages: attempt.pages, source: "", beforePages: pages }, signal) as { passed?: boolean; reason?: string }
    if (verification.passed !== true || !verification.reason?.trim()) throw new Error(verification.reason || "关键事实保留复核未通过")
    for (const [path, page] of Object.entries(attempt.pages)) if (await readFile(`${projectPath}/${path}`) !== page.proposed) throw new Error(`复核期间页面已变化：${path}`)
    attempt.status = "verified"; attempt.reason = verification.reason
  } catch (error) {
    attempt.status = "failed"; attempt.reason = error instanceof Error ? error.message : String(error)
  }
  await withProjectLock(projectPath, saveAttempt)
  const changed: string[] = []
  const revisions: Record<string, string> = {}
  for (const [path, page] of Object.entries(attempt.pages)) if (await readFile(`${projectPath}/${path}`) === page.proposed) { changed.push(path); revisions[path] = await contentRevision(page.proposed) }
  onChanged?.(changed, revisions)
  signal?.throwIfAborted()
  if (attempt.status === "verified") return pending
  const failed = await Promise.all(fresh.map(async (item) => ({ ...item,
    evidence: await Promise.all((item.evidence ?? []).map(async (entry) => {
      const page = attempt.pages[entry.path]
      if (!page || await readFile(`${projectPath}/${entry.path}`) !== page.proposed) return entry
      return { path: entry.path, revision: await contentRevision(page.proposed), text: page.proposed, startLine: 1, endLine: page.proposed.split("\n").length }
    })),
    repair: { status: "unresolved" as const, reason: attempt.reason ?? "自动处理未完成" }, outcome: "已尝试一轮自动处理；实际修改与原文保存在 Wiki 修复记录中，未自动回滚。",
  })))
  return [...pending, ...failed]
}

function body(text: string): string { return text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "") }
function links(text: string): string[] { return [...text.matchAll(/(?<!!)\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map((match) => match[1].replace(/\.md$/, "")) }
