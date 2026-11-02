import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => new Map<string, unknown>())
const save = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => storage.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      storage.set(key, value)
    },
    save,
  })),
}))

describe("source watch all-projects persistence", () => {
  beforeEach(() => {
    storage.clear()
    save.mockClear()
  })

  it("问答历史长度独立持久化，重启读取并约束手工修改的值", async () => {
    const { saveHistoryMessageLimit, loadHistoryMessageLimit } = await import("./project-store")
    expect(await loadHistoryMessageLimit()).toBe(10)
    await saveHistoryMessageLimit(20)
    expect(await loadHistoryMessageLimit()).toBe(20)
    expect(save).toHaveBeenCalledTimes(1)
    storage.set("historyMessageLimit", 1000)
    expect(await loadHistoryMessageLimit()).toBe(100)
  })

  it("defaults off and round-trips the global option", async () => {
    const {
      loadSourceWatchAllProjects,
      saveSourceWatchAllProjects,
    } = await import("./project-store")

    expect(await loadSourceWatchAllProjects()).toBe(false)
    await saveSourceWatchAllProjects(true)
    expect(await loadSourceWatchAllProjects()).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)

    await saveSourceWatchAllProjects(false)
    expect(await loadSourceWatchAllProjects()).toBe(false)
  })

  it("读取旧配置时丢弃摘要开关，其他项目设置正常持久化", async () => {
    const { loadSourceWatchConfig, saveSourceWatchConfig } = await import("./project-store")
    const config = await loadSourceWatchConfig("project-a")
    storage.set("sourceWatchConfig", { "project-a": { ...config, generateSourceSummary: true } })
    const restored = await loadSourceWatchConfig("project-a")
    expect(restored).not.toHaveProperty("generateSourceSummary")
    await saveSourceWatchConfig({ ...restored, persistExtractedMarkdown: true }, "project-a")
    expect((await loadSourceWatchConfig("project-a")).persistExtractedMarkdown).toBe(true)
    expect((await loadSourceWatchConfig("project-b")).persistExtractedMarkdown).toBe(false)
    expect(storage.get("sourceWatchConfig")).toEqual({ "project-a": { ...restored, persistExtractedMarkdown: true } })
  })
})
