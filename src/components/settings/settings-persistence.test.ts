/** 验证节点保存只改变本节点参数，不覆盖其他节点或另一个项目的运行状态。 */
import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ save: vi.fn(), start: vi.fn(), stop: vi.fn() }))
vi.mock("@/lib/project-store", () => ({ saveSourceWatchConfig: mocks.save, saveSourceWatchAllProjects: vi.fn() }))
vi.mock("@/lib/project-file-sync", () => ({ startProjectFileSync: mocks.start, stopProjectFileSync: mocks.stop, startAllProjectFileSync: vi.fn(), stopAllProjectFileSync: vi.fn() }))
vi.mock("@/lib/ingest-queue", () => ({ setIngestWorkerLimit: vi.fn() }))
import { saveSettingsSection } from "./settings-persistence"
import { createSettingsDraft } from "./settings-draft"
import { useWikiStore } from "@/stores/wiki-store"
import { DEFAULT_SOURCE_WATCH_CONFIG } from "@/lib/source-watch-config"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.save.mockResolvedValue(undefined)
  useWikiStore.setState({ project: { id: "p1", name: "测试", path: "/project" }, sourceWatchConfig: { ...DEFAULT_SOURCE_WATCH_CONFIG, enabled: true, parsingConcurrency: 3 }, sourceWatchAllProjects: false })
})

describe("知识流程节点参数保存", () => {
  it("保存文件筛选保留当前监控开关及并发，不提交其他节点的未保存草稿", async () => {
    const draft = createSettingsDraft()
    draft.sourceWatchConfig = { ...draft.sourceWatchConfig, excludeDirs: ["drafts"], enabled: false, parsingConcurrency: 8 }
    await saveSettingsSection("filters", draft)
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ excludeDirs: ["drafts"], enabled: true, parsingConcurrency: 3 }), "p1")
    expect(useWikiStore.getState().sourceWatchConfig.excludeDirs).toEqual(["drafts"])
  })

  it("持久化失败不更新运行状态", async () => {
    const draft = createSettingsDraft()
    draft.sourceWatchConfig.enabled = false
    mocks.save.mockRejectedValueOnce(new Error("磁盘写入失败"))
    await expect(saveSettingsSection("monitoring", draft)).rejects.toThrow("磁盘写入失败")
    expect(useWikiStore.getState().sourceWatchConfig.enabled).toBe(true)
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it("等待保存时切换项目，不把原项目参数应用到新项目", async () => {
    let finish!: () => void
    mocks.save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const draft = createSettingsDraft()
    draft.sourceWatchConfig.enabled = false
    const saving = saveSettingsSection("monitoring", draft)
    useWikiStore.setState({ project: { id: "p2", name: "另一个项目", path: "/other" } })
    finish()
    await saving
    expect(useWikiStore.getState().sourceWatchConfig.enabled).toBe(true)
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
