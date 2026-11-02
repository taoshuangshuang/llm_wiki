/** 对话原始材料交接到文件上传使用的同一队列；交接凭据由后端持久化，失败时保留以便重试。 */
import { invoke } from "@tauri-apps/api/core"
import { readFile } from "@/commands/fs"
import { enqueueBatch, getQueue, type IngestTask } from "@/lib/ingest-queue"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

interface ConversationIngest {
  id: string
  sourcePath: string
  requestedPath: string
}

/** 凭据在交接期间保留，队列确认落盘后才确认；重启后保留已失败或已取消任务的状态。 */
export async function transferConversationIngests(project: WikiProject): Promise<void> {
  const projectPath = normalizePath(project.path)
  const jobs = await invoke<ConversationIngest[]>("list_conversation_ingests", { projectPath })
  for (const job of jobs) {
    const current = useWikiStore.getState().project
    if (current?.id !== project.id || normalizePath(current.path) !== projectPath) return
    let persisted: IngestTask[] = []
    try {
      persisted = JSON.parse(await readFile(`${projectPath}/.llm-wiki/ingest-queue.json`)) as IngestTask[]
    } catch {
      // 队列文件首次创建前不存在；由公共队列完成创建和持久化，失败则不确认凭据。
    }
    // 同时核对内存与落盘记录，避免项目尚未恢复队列时误确认旧快照中的任务。
    const alreadyQueued = persisted.some((task) => task.projectId === project.id &&
      normalizePath(task.sourcePath) === job.sourcePath && task.status !== "done" &&
      getQueue().some((active) => active.projectId === project.id && active.id === task.id))
    if (!alreadyQueued) {
      await enqueueBatch(project.id, [{
        sourcePath: job.sourcePath,
        folderContext: `对话确认的知识材料。建议页面路径：${job.requestedPath}；是否复用已有页面由公共入库规则决定。`,
      }])
    }
    await invoke("acknowledge_conversation_ingest", { projectPath, id: job.id })
  }
}

/** 独立于资料目录自动监控；仅处理当前项目，其他项目的凭据留到打开该项目后处理。 */
export function startConversationIngestWatcher(): () => void {
  let stopped = false
  let running = false
  const poll = async (): Promise<void> => {
    const project = useWikiStore.getState().project
    if (stopped || running || !project) return
    running = true
    try {
      await transferConversationIngests(project)
    } catch (error) {
      console.error("对话入库交接失败，原始材料与凭据已保留：", error)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => { void poll() }, 2_000)
  void poll()
  return () => { stopped = true; clearInterval(timer) }
}
