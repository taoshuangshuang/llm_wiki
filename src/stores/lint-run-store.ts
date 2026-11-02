/** Wiki 检查会话按项目保存在页面外；切换视图不结束任务。 */
import { create } from "zustand"

export interface LintRunState {
  running: boolean
  paused: boolean
  pausing: boolean
  phase: "structural" | "semantic"
  runSemantic: boolean
  hasRun: boolean
  progress: { completed: number; total: number } | null
  detail: string | null
  error: string | null
}
export const DEFAULT_LINT_RUN: LintRunState = { running: false, paused: false, pausing: false, phase: "structural", runSemantic: false, hasRun: false, progress: null, detail: null, error: null }

export const useLintRunStore = create<{
  runs: Record<string, LintRunState>
  update: (path: string, patch: Partial<LintRunState>) => void
}>((set) => ({
  runs: {},
  update: (path, patch) => set((state) => ({ runs: { ...state.runs, [path]: { ...(state.runs[path] ?? DEFAULT_LINT_RUN), ...patch } } })),
}))
