/** 按模块持久化检查点；续跑按批次完成状态恢复进度，未完成批次读取当前文件重跑。 */
import { fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import type { ReviewItem } from "@/stores/review-store"
import { contentRevision } from "./content-revision"
import { withProjectLock } from "./project-mutex"

export interface WikiModuleCheckpoint {
  executionId: string
  moduleId: string
  name: string
  status: "running" | "complete" | "incomplete"
  members: { path: string; revision: string }[]
  dependencies: { path: string; revision: string }[]
  items: ReviewItem[]
  reason?: string
  updatedAt: number
}
interface Checkpoints { version: 1; modules: Record<string, WikiModuleCheckpoint> }
const checkpointPath = (projectPath: string) => `${projectPath}/.llm-wiki/wiki-review-checkpoints.json`

export async function loadWikiReviewCheckpoints(projectPath: string): Promise<Checkpoints> {
  if (!await fileExists(checkpointPath(projectPath))) return { version: 1, modules: {} }
  const value = JSON.parse(await readFile(checkpointPath(projectPath))) as Checkpoints
  if (value?.version !== 1 || !value.modules || typeof value.modules !== "object" || Array.isArray(value.modules)) throw new Error("Wiki 模块检查点格式无效，未复用旧结果")
  return value
}

/** 依赖页面即使没有产生问题也必须核对，空问题列表不代表没有消费证据。 */
export async function checkpointDependenciesCurrent(projectPath: string, dependencies: { path: string; revision: string }[]): Promise<boolean> {
  const current = new Map<string, string>()
  for (const entry of dependencies) {
    if (!entry.path.startsWith("wiki/") || entry.path.split("/").some((part) => part === ".." || part === ".") || /[\\\x00-\x1f]/.test(entry.path)) return false
    try {
      if (!current.has(entry.path)) current.set(entry.path, await contentRevision(await readFile(`${projectPath}/${entry.path}`)))
      if (current.get(entry.path) !== entry.revision) return false
    }
    catch { return false }
  }
  return true
}

/** 按记录合并写回；旧执行不能覆盖后来启动的同一模块。 */
export async function saveWikiModuleCheckpoint(projectPath: string, key: string, entry: WikiModuleCheckpoint, finishing = false): Promise<void> {
  await withProjectLock(projectPath, async () => {
    const current = await loadWikiReviewCheckpoints(projectPath)
    if (finishing && current.modules[key]?.executionId !== entry.executionId) throw new Error(`模块检查已被新的执行替代：${entry.name}`)
    current.modules[key] = entry
    await writeFileAtomic(checkpointPath(projectPath), JSON.stringify(current))
  })
}
