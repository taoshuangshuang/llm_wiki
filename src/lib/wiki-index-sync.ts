import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { embedAllPages } from "@/lib/embedding"
import { normalizePath } from "@/lib/path-utils"
import type { EmbeddingConfig } from "@/stores/wiki-store"

const FILE_CHANGE_DEBOUNCE_MS = 60_000
const RECONCILE_INTERVAL_MS = 60 * 60_000

/**
 * Wiki 文件是事实来源。监听所有正文变动，串行增量核对；模型失败后定时重试。
 * 不依赖来源文件自动入库开关，也不依赖每个写入调用方主动维护向量库。
 */
export async function startWikiIndexSync(projectPath: string, cfg: EmbeddingConfig): Promise<() => void> {
  const vectorEnabled = cfg.enabled && Boolean(cfg.model)
  const pp = normalizePath(projectPath)
  let stopped = false
  let running = false
  let nextSyncAt: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const armTimer = (delay: number) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void run() }, delay)
  }
  const run = async () => {
    if (running || stopped || !vectorEnabled) return
    const remaining = (nextSyncAt ?? 0) - Date.now()
    if (remaining > 0) {
      armTimer(remaining)
      return
    }
    nextSyncAt = undefined
    running = true
    try {
      await embedAllPages(pp, cfg)
    } catch (error) {
      // embedAllPages 已将错误放入共享状态，设置页可见；下轮继续重试。
      console.warn("[wiki-index] Incremental sync failed:", error)
    } finally {
      running = false
      // 同步期间又发生修改，也从最后一次事件起等待完整的静默窗口。
      // 如果窗口已结束，当前批次完成后立即补跑，始终避免并发覆盖。
      if (!stopped && nextSyncAt !== undefined && timer === undefined) {
        armTimer(Math.max(0, nextSyncAt - Date.now()))
      }
    }
  }
  const scheduleAfterFileChange = () => {
    if (stopped || !vectorEnabled) return
    nextSyncAt = Date.now() + FILE_CHANGE_DEBOUNCE_MS
    armTimer(FILE_CHANGE_DEBOUNCE_MS)
  }
  const requestReconciliation = () => {
    // 启动和每小时查漏均不能提前执行或重置正在等待的文件变更同步。
    if (stopped || running || timer !== undefined || !vectorEnabled) return
    void run()
  }
  const unlisten = await listen<string>("embedding://wiki-changed", ({ payload }) => {
    if (normalizePath(payload) === pp) scheduleAfterFileChange()
  })
  let watcherId: string | undefined
  try {
    watcherId = await invoke<string>("start_wiki_index_watcher", { projectPath: pp })
  } catch (error) {
    // 原生监听不可用仍可定时追平，不影响索引按钮及页面编辑。
    console.warn("[wiki-index] Watcher unavailable; using periodic reconciliation:", error)
  }
  const interval = setInterval(requestReconciliation, RECONCILE_INTERVAL_MS)
  requestReconciliation()
  return () => {
    stopped = true
    unlisten()
    clearInterval(interval)
    if (timer !== undefined) clearTimeout(timer)
    if (watcherId) void invoke("stop_wiki_index_watcher", { watcherId }).catch(console.warn)
  }
}
