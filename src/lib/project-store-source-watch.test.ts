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

  it("来源摘要默认关闭，显式开启仅影响对应项目并能持久化", async () => {
    const { loadSourceWatchConfig, saveSourceWatchConfig } = await import("./project-store")
    const config = await loadSourceWatchConfig("project-a")
    expect(config.generateSourceSummary).toBe(false)
    await saveSourceWatchConfig({ ...config, generateSourceSummary: true }, "project-a")
    expect((await loadSourceWatchConfig("project-a")).generateSourceSummary).toBe(true)
    expect((await loadSourceWatchConfig("project-b")).generateSourceSummary).toBe(false)
    await saveSourceWatchConfig({ ...config, generateSourceSummary: false }, "project-a")
    expect((await loadSourceWatchConfig("project-a")).generateSourceSummary).toBe(false)
  })
})
