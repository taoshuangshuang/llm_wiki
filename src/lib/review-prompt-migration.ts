/** 版本化提示词迁移：先预览，保存前核对版本，保留用户原文件与备份。 */
import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { DEFAULT_INGEST_PROMPTS, loadProjectIngestPrompts, PROMPT_FILES, type IngestPrompts } from "./ingest-prompts"
import { contentRevision } from "./ingest-run"
import { withProjectLock } from "./project-mutex"

const TARGET = "prompts/07-01-统一后台审阅.md"
export interface ReviewPromptMigration {
  revision: string
  original: string
  current: string
  proposed: string
  needsManualReview: boolean
  /** 各节点逐份展示差异，经人工选择填入草稿，绝不覆盖项目原规则。 */
  changes: { key: keyof IngestPrompts; name: string; current: string; proposed: string }[]
}

export async function previewReviewPromptMigration(projectPath: string): Promise<ReviewPromptMigration> {
  const policies = await loadProjectIngestPrompts(projectPath)
  const current = await fileExists(`${projectPath}/${TARGET}`) ? await readFile(`${projectPath}/${TARGET}`) : ""
  const original = policies.reviewTemplate
  const needsManualReview = original !== DEFAULT_INGEST_PROMPTS.reviewTemplate
  const proposed = current && current !== DEFAULT_INGEST_PROMPTS.backgroundReview ? current : DEFAULT_INGEST_PROMPTS.backgroundReview
  const keys: (keyof IngestPrompts)[] = ["pageMatchTemplate", "mergeTemplate", "merge", "acceptance", "review", "backgroundReview"]
  const changes = keys.filter((key) => policies[key] !== DEFAULT_INGEST_PROMPTS[key]).map((key) => ({ key, name: PROMPT_FILES[key].name, current: policies[key], proposed: DEFAULT_INGEST_PROMPTS[key] }))
  return { changes, revision: await contentRevision(JSON.stringify([original, current])), original, current, proposed, needsManualReview }
}

/** 用户审核后的新规则独立保存；旧模板始终保留，不自动判断哪些自定义规则可丢弃。 */
export async function applyReviewPromptMigration(projectPath: string, expectedRevision: string, content: string): Promise<string> {
  if (!content.includes("contract: review-v2") || /\{\{[^}]+\}\}/.test(content)) throw new Error("新规则必须声明 contract: review-v2；旧占位符材料由 user JSON 提供，请将其改为文字规则")
  return withProjectLock(`prompt-migration\0${projectPath}`, async () => {
    const preview = await previewReviewPromptMigration(projectPath)
    if (preview.revision !== expectedRevision) throw new Error("提示词已变化，请重新预览后保存")
    if (preview.needsManualReview && content === DEFAULT_INGEST_PROMPTS.backgroundReview) throw new Error("旧模板含自定义规则，请将需要保留的业务规则迁入新规则后保存")
    const backup = `${projectPath}/.llm-wiki/prompt-backups/${crypto.randomUUID()}`
    await createDirectory(backup)
    await writeFileAtomic(`${backup}/旧审阅模板.md`, preview.original)
    if (preview.current) await writeFileAtomic(`${backup}/统一后台审阅.md`, preview.current)
    await createDirectory(`${projectPath}/prompts`)
    await writeFileAtomic(`${projectPath}/${TARGET}`, content)
    return backup
  })
}
