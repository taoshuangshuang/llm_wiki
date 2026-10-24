import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { IngestTask } from "@/lib/ingest-queue"

const state = vi.hoisted(() => ({ tasks: [] as IngestTask[], selected: false }))

// 服务端渲染不运行 effect，因此直接展开面板以检查用户可见的操作入口。
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>()
  return {
    ...react,
    useState: (initial: unknown) => react.useState(
      initial === false ? true
        : initial instanceof Set && state.selected ? new Set(state.tasks.map((task) => task.id))
          : initial,
    ),
  }
})
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/lib/ingest-queue", () => ({
  getQueue: () => state.tasks,
  getQueueSummary: () => ({
    total: state.tasks.length, completed: 0,
    pending: state.tasks.filter((task) => task.status === "pending").length,
    processing: state.tasks.filter((task) => task.status === "processing").length,
    failed: state.tasks.filter((task) => task.status === "failed").length,
    cancelled: state.tasks.filter((task) => task.status === "cancelled").length,
  }),
  retryTask: vi.fn(), retryAllStoppedTasks: vi.fn(), retryTasks: vi.fn(),
  cancelTask: vi.fn(), cancelTasks: vi.fn(), cancelAllTasks: vi.fn(),
  removeStoppedTasks: vi.fn(), movePendingTask: vi.fn(),
  pauseProcessing: vi.fn(), resumeProcessing: vi.fn(),
}))

import { ActivityPanel } from "./activity-panel"

beforeEach(() => { state.tasks = []; state.selected = false })

function task(status: IngestTask["status"]): IngestTask {
  return {
    id: status, projectId: "project", sourcePath: `${status}.md`, folderContext: "",
    status, addedAt: 1, error: status === "failed" ? "验收未通过" : null, retryCount: 0,
  }
}

describe("摄取队列删除入口", () => {
  it.each(["failed", "cancelled"] as const)("%s 记录同时提供重试和删除", (status) => {
    state.tasks = [task(status)]
    const html = renderToStaticMarkup(<ActivityPanel />)
    expect(html).toContain('title="common.retry"')
    expect(html).toContain('title="activity.removeStoppedTask"')
  })

  it("混合选择时提供删除已停止记录入口", () => {
    state.tasks = [task("failed"), task("pending")]
    state.selected = true
    expect(renderToStaticMarkup(<ActivityPanel />)).toContain("activity.removeSelectedStopped")
  })

  it("排队和处理中的任务仅提供取消入口", () => {
    state.tasks = [task("pending"), task("processing")]
    const html = renderToStaticMarkup(<ActivityPanel />)
    expect(html).toContain('title="common.cancel"')
    expect(html).not.toContain('title="activity.removeStoppedTask"')
    expect(html).not.toContain("activity.removeSelectedStopped")
  })
})
