/** 用户点击检查后的展示契约：未完成或取消不能出现“一切正常”。 */
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ButtonHTMLAttributes } from "react"
const translated = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock("react-i18next", () => ({ useTranslation: () => translated }))
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }))
vi.mock("@/lib/lint", () => ({ runStructuralLint: vi.fn(async () => []), reviewItemsToLint: vi.fn(() => []) }))
vi.mock("@/lib/wiki-review", () => ({ runWikiReview: vi.fn() }))
vi.mock("@/lib/project-schema", () => ({ loadProjectSchema: vi.fn(async () => "") }))
vi.mock("@/features/business-modules/pages", () => ({ loadModulePages: vi.fn(async () => ({ pages: [], unreadable: [] })) }))
vi.mock("@/lib/lint-run-history", () => ({ loadLintRunHistory: vi.fn(async () => null), saveLintRunHistory: vi.fn(async () => {}) }))
vi.mock("@/lib/persist", () => ({ saveLintItems: vi.fn(async () => {}) }))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn(async () => {}) }))
vi.mock("@/lib/lint-config", async (original) => {
  const module = await original<typeof import("@/lib/lint-config")>()
  return { ...module, loadLintConfig: vi.fn(async () => module.DEFAULT_LINT_CONFIG) }
})
import { LintView } from "./lint-view"
import { reviewItemsToLint, runStructuralLint } from "@/lib/lint"
import { runWikiReview } from "@/lib/wiki-review"
import { useWikiStore } from "@/stores/wiki-store"
import { useLintStore } from "@/stores/lint-store"
import { useLintRunStore } from "@/stores/lint-run-store"
import { loadLintRunHistory } from "@/lib/lint-run-history"
import { saveLintItems } from "@/lib/persist"

let view: ReactTestRenderer | undefined
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadLintRunHistory).mockReset().mockResolvedValue(null)
  vi.mocked(reviewItemsToLint).mockReset().mockReturnValue([])
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  useWikiStore.setState({ project: { id: "test", name: "test", path: "/project" }, llmConfig: { ...useWikiStore.getState().llmConfig, provider: "openai", apiKey: "test" } })
  useLintStore.setState({ items: [] })
  useLintRunStore.setState({ runs: {} })
})
afterEach(async () => { await act(async () => view?.unmount()); view = undefined })

describe("Wiki 检查运行结果展示", () => {
  it("历史读取未结束时切换项目，迟到的进度与问题不覆盖当前项目", async () => {
    let finish!: (value: Awaited<ReturnType<typeof loadLintRunHistory>>) => void
    const deferred = new Promise<Awaited<ReturnType<typeof loadLintRunHistory>>>((resolve) => { finish = resolve })
    vi.mocked(loadLintRunHistory).mockImplementation(async (path) => path === "/project" ? deferred : null)
    await act(async () => { view = create(<LintView />) })
    await act(async () => useWikiStore.setState({ project: { id: "B", name: "B", path: "/project-b" } }))
    await act(async () => finish({ version: 1,
      run: { running: false, paused: true, pausing: false, phase: "semantic", runSemantic: true, hasRun: true, progress: { completed: 12, total: 58 }, detail: "项目A历史进度", error: null },
      items: [{ id: "A-history", type: "orphan", severity: "info", page: "A.md", detail: "项目A历史问题", createdAt: 0 }],
    }))
    expect(JSON.stringify(view!.toJSON())).not.toContain("项目A历史")
    expect(useLintStore.getState().items).toEqual([])
    expect(useLintRunStore.getState().runs["/project"].progress).toEqual({ completed: 12, total: 58 })
  })

  it("应用重启后自动显示历史进度与问题，点击继续前不启动检查", async () => {
    vi.mocked(loadLintRunHistory).mockResolvedValue({ version: 1,
      run: { running: false, paused: true, pausing: false, phase: "semantic", runSemantic: true, hasRun: true, progress: { completed: 12, total: 58 }, detail: "待继续检查：元数据缓存", error: null },
      items: [{ id: "history-1", type: "semantic", severity: "warning", page: "A.md", detail: "历史语义问题", createdAt: 0 }],
    })
    await act(async () => { view = create(<LintView />) })
    expect(JSON.stringify(view!.toJSON())).toContain("待继续检查：元数据缓存")
    expect(JSON.stringify(view!.toJSON())).toContain("历史语义问题")
    expect(JSON.stringify(view!.toJSON())).toContain("lint.resume")
    expect(view!.root.findAllByType("input")[0].props.checked).toBe(true)
    expect(runWikiReview).not.toHaveBeenCalled()
    expect(runStructuralLint).not.toHaveBeenCalled()
    vi.mocked(runWikiReview).mockResolvedValue({ status: "complete", items: [], reasons: [] })
    await act(async () => view!.root.findAllByType("button").find((button) => button.children.includes("lint.resume"))!.props.onClick())
    expect(runWikiReview).toHaveBeenCalledTimes(1)
  })

  it("旧数据有重复问题及冲突 ID 时，切到语义筛选不残留失效链接卡片", async () => {
    const broken = { id: "lint-5000", type: "broken-link" as const, severity: "warning" as const, page: "A.md", detail: "重复失效链接示例", brokenTarget: "missing", createdAt: 0 }
    const semantic = { ...broken, type: "semantic" as const, page: "B.md", detail: "真正的语义冲突示例" }
    useLintStore.getState().setItems([broken, { ...broken }, semantic])
    await act(async () => { view = create(<LintView />) })
    const filter = () => view!.root.findAllByType("select").find((select) => select.props["aria-label"] === "lint.filterType")!
    await act(async () => filter().props.onChange({ target: { value: "semantic" } }))
    expect(JSON.stringify(view!.toJSON())).toContain("真正的语义冲突示例")
    expect(JSON.stringify(view!.toJSON())).not.toContain("重复失效链接示例")
    await act(async () => useLintStore.getState().replaceResults([broken, broken, semantic]))
    expect(JSON.stringify(view!.toJSON())).not.toContain("重复失效链接示例")
    await act(async () => filter().props.onChange({ target: { value: "broken-link" } }))
    expect(JSON.stringify(view!.toJSON())).not.toContain("真正的语义冲突示例")
    expect(view!.root.findAllByType("p").filter((paragraph) => paragraph.children.includes("重复失效链接示例"))).toHaveLength(1)
  })

  it("公共检查多次发布时替换上一批结构和链接事项，保留独立扫描结果并按真实分类筛选", async () => {
    const base = { title: "格式检查结果", description: "格式说明", affectedPages: ["wiki/A.md"], options: [], resolved: false, createdAt: 0 }
    const format = { ...base, id: "format-review", type: "structure" as const }
    const reference = { ...base, id: "link-review", type: "structure" as const, subtype: "失效引用", title: "引用检查结果" }
    const scan = { type: "broken-link" as const, severity: "warning" as const, page: "B.md", detail: "独立扫描的链接", brokenTarget: "missing" }
    vi.mocked(runStructuralLint).mockResolvedValueOnce([scan])
    vi.mocked(reviewItemsToLint).mockImplementation((items) => items.map((reviewItem) => ({
      type: reviewItem.subtype === "失效引用" ? "broken-link" : "structure", severity: "warning", page: "A.md", detail: reviewItem.title, reviewItem,
    })))
    vi.mocked(runWikiReview).mockImplementation(async (_path, _config, _signal, _progress, onItems) => {
      onItems?.([format])
      onItems?.([format, reference])
      return { status: "complete", items: [format, reference], reasons: [] }
    })
    await act(async () => { view = create(<LintView />) })
    await act(async () => view!.root.findAllByType("input")[0].props.onChange({ target: { checked: true } }))
    await act(async () => view!.root.findAllByType("button").find((button) => button.children.includes("lint.runLint"))!.props.onClick())
    expect(useLintStore.getState().items.map((item) => item.type)).toEqual(["broken-link", "structure", "broken-link"])
    const filter = view!.root.findAllByType("select").find((select) => select.props["aria-label"] === "lint.filterType")!
    await act(async () => filter.props.onChange({ target: { value: "structure" } }))
    expect(JSON.stringify(view!.toJSON())).toContain("格式检查结果")
    expect(JSON.stringify(view!.toJSON())).not.toContain("引用检查结果")
    await act(async () => filter.props.onChange({ target: { value: "semantic" } }))
    expect(JSON.stringify(view!.toJSON())).not.toContain("格式检查结果")
    expect(JSON.stringify(view!.toJSON())).not.toContain("引用检查结果")
  })

  it("语义检查尚未结束时，批次产出的语义事项已经进入卡片与筛选计数", async () => {
    const item = { id: "semantic-review", type: "contradiction" as const, title: "删除语义冲突", description: "两页描述不一致", affectedPages: ["wiki/A.md"], options: [], resolved: false, createdAt: 0 }
    const projected = { type: "semantic" as const, severity: "warning" as const, page: "A.md", detail: "删除语义冲突", reviewItem: item }
    vi.mocked(reviewItemsToLint).mockReturnValue([projected])
    let finish!: (report: Awaited<ReturnType<typeof runWikiReview>>) => void
    const deferred = new Promise<Awaited<ReturnType<typeof runWikiReview>>>((resolve) => { finish = resolve })
    vi.mocked(runWikiReview).mockImplementation(async (_path, _config, _signal, progress, onItems) => {
      progress?.({ completed: 1, total: 58, detail: "下一批仍在检查" })
      onItems?.([item])
      return deferred
    })
    await act(async () => { view = create(<LintView />) })
    await act(async () => view!.root.findAllByType("input")[0].props.onChange({ target: { checked: true } }))
    let running: Promise<void> | undefined
    try {
      await act(async () => { running = view!.root.findAllByType("button").find((button) => button.children.includes("lint.runLint"))!.props.onClick(); await Promise.resolve() })
      expect(useLintRunStore.getState().runs["/project"].running).toBe(true)
      expect(useLintStore.getState().items).toMatchObject([{ type: "semantic", detail: "删除语义冲突" }])
      await act(async () => view!.root.findAllByType("select").find((select) => select.props["aria-label"] === "lint.filterType")!.props.onChange({ target: { value: "semantic" } }))
      expect(JSON.stringify(view!.toJSON())).toContain("删除语义冲突")
      expect(JSON.stringify(view!.toJSON())).not.toContain("lint.noMatchingIssues")
    } finally {
      await act(async () => { finish({ status: "complete", items: [item], reasons: [] }); await running })
    }
  })

  it("结构检查阶段也能暂停，继续时重新扫描且不显示正常通过", async () => {
    vi.mocked(runStructuralLint).mockImplementationOnce(async (_path, options) => {
      options?.onProgress?.(1, 4)
      await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))
      return []
    })
    await act(async () => { view = create(<LintView />) })
    let running: Promise<void> | undefined
    await act(async () => { running = view!.root.findAllByType("button").find((button) => button.children.includes("lint.runLint"))!.props.onClick(); await Promise.resolve() })
    await act(async () => { view!.root.findAllByType("button").find((button) => button.children.includes("lint.pause"))!.props.onClick(); await running })
    expect(useLintRunStore.getState().runs["/project"]).toMatchObject({ paused: true, phase: "structural", error: null })
    expect(JSON.stringify(view!.toJSON())).not.toContain("lint.allClear")
    await act(async () => view!.root.findAllByType("button").find((button) => button.children.includes("lint.resume"))!.props.onClick())
    expect(runStructuralLint).toHaveBeenCalledTimes(2)
    expect(runWikiReview).not.toHaveBeenCalled()
  })

  it("暂停立即中断请求，保存后允许继续，并沿用原检查配置", async () => {
    let signal: AbortSignal | undefined
    let finish!: (report: Awaited<ReturnType<typeof runWikiReview>>) => void
    const deferred = new Promise<Awaited<ReturnType<typeof runWikiReview>>>((resolve) => { finish = resolve })
    vi.mocked(runWikiReview).mockImplementationOnce(async (_path, _config, currentSignal, progress) => {
      signal = currentSignal
      progress?.({ completed: 2, total: 5, detail: "当前批次" })
      return deferred
    }).mockResolvedValue({ status: "complete", items: [], reasons: [] })
    await act(async () => { view = create(<LintView />) })
    await act(async () => view!.root.findAllByType("input")[0].props.onChange({ target: { checked: true } }))
    let running: Promise<void> | undefined
    try {
      await act(async () => { running = view!.root.findAllByType("button").find((button) => button.children.includes("lint.runLint"))!.props.onClick(); await Promise.resolve() })
      await act(async () => view!.root.findAllByType("button").find((button) => button.children.includes("lint.pause"))!.props.onClick())
      expect(signal!.aborted).toBe(true)
      const pausing = view!.root.findAllByType("button").find((button) => button.children.includes("lint.pausing"))!
      expect(pausing.props.disabled).toBe(true)
    } finally {
      await act(async () => { finish({ status: "cancelled", items: [], reasons: ["aborted"] }); await running })
    }
    expect(useLintRunStore.getState().runs["/project"]).toMatchObject({ paused: true, running: false, progress: { completed: 2, total: 5 }, error: null })
    await act(async () => view!.root.findAllByType("button").find((button) => button.children.includes("lint.resume"))!.props.onClick())
    expect(runWikiReview).toHaveBeenCalledTimes(2)
    expect(runStructuralLint).toHaveBeenCalledTimes(2)
    expect(useLintRunStore.getState().runs["/project"]).toMatchObject({ paused: false, running: false })
    expect(JSON.stringify(view!.toJSON())).toContain("lint.allClear")
  })

  it("筛选后全选和忽略只作用于可见结果，切换筛选清空选择", async () => {
    useLintStore.setState({ items: [
      { id: "a", type: "orphan", severity: "info", page: "A.md", detail: "孤立A", createdAt: 0 },
      { id: "b", type: "broken-link", severity: "warning", page: "B.md", detail: "失效B", createdAt: 0 },
    ] })
    await act(async () => { view = create(<LintView />) })
    const typeFilter = () => view!.root.findAllByType("select").find((select) => select.props["aria-label"] === "lint.filterType")!
    const selectVisible = () => view!.root.findAllByType("label").find((label) => label.children.includes("lint.selectVisible"))!.findByType("input")
    const dismiss = () => view!.root.findAllByType("button").find((button) => button.children.includes("lint.ignoreSelected"))!
    await act(async () => selectVisible().props.onChange())
    expect(dismiss().props.disabled).toBe(false)
    await act(async () => typeFilter().props.onChange({ target: { value: "orphan" } }))
    expect(dismiss().props.disabled).toBe(true)
    expect(JSON.stringify(view!.toJSON())).not.toContain("失效B")
    await act(async () => selectVisible().props.onChange())
    await act(async () => dismiss().props.onClick())
    expect(useLintStore.getState().items.map((item) => item.id)).toEqual(["b"])
    expect(JSON.stringify(view!.toJSON())).toContain("lint.noMatchingIssues")
    expect(JSON.stringify(view!.toJSON())).not.toContain("lint.allClear")
  })

  it("切换页面后任务继续运行，返回恢复勾选状态、进度和暂停入口", async () => {
    let finish!: (report: Awaited<ReturnType<typeof runWikiReview>>) => void
    let progress!: NonNullable<Parameters<typeof runWikiReview>[3]>
    let signal: AbortSignal | undefined
    const deferred = new Promise<Awaited<ReturnType<typeof runWikiReview>>>((resolve) => { finish = resolve })
    vi.mocked(runWikiReview).mockImplementation(async (_path, _config, controllerSignal, onProgress) => {
      signal = controllerSignal; progress = onProgress!
      progress({ completed: 3, total: 10, detail: "正在检查：元数据模块（3/10）" })
      return deferred
    })
    let running: Promise<void> | undefined
    try {
      await act(async () => { view = create(<LintView />) })
      await act(async () => view!.root.findAllByType("input").find((input) => input.props.type === "checkbox")!.props.onChange({ target: { checked: true } }))
      await act(async () => { running = view!.root.findAllByType("button").find((button) => button.children.includes("lint.runLint"))!.props.onClick(); await Promise.resolve() })
      expect(signal).toBeDefined()
      await act(async () => { view!.unmount(); view = undefined })
      expect(signal!.aborted).toBe(false)
      await act(async () => { view = create(<LintView />) })
      expect(view!.root.findAllByType("input").find((input) => input.props.type === "checkbox")!.props.checked).toBe(true)
      expect(JSON.stringify(view!.toJSON())).toContain("正在检查：元数据模块（3/10）")
      expect(JSON.stringify(view!.toJSON())).toContain("lint.pause")
      await act(async () => progress({ completed: 4, total: 10, detail: "正在检查：查询模块（4/10）" }))
      expect(JSON.stringify(view!.toJSON())).toContain("查询模块（4/10）")
      expect(runWikiReview).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => { finish({ status: "complete", items: [], reasons: [] }); await running })
    }
    expect(JSON.stringify(view!.toJSON())).toContain("lint.allClear")
    expect(JSON.stringify(view!.toJSON())).not.toContain("lint.pause")
  })

  it("返回页面后点击暂停，立即中断原来的后台任务", async () => {
    let finish!: (report: Awaited<ReturnType<typeof runWikiReview>>) => void
    let signal: AbortSignal | undefined
    const deferred = new Promise<Awaited<ReturnType<typeof runWikiReview>>>((resolve) => { finish = resolve })
    vi.mocked(runWikiReview).mockImplementation(async (_path, _config, controllerSignal, onProgress) => {
      signal = controllerSignal; onProgress?.({ completed: 1, total: 2, detail: "检查中" }); return deferred
    })
    let running: Promise<void> | undefined
    try {
      await act(async () => { view = create(<LintView />) })
      await act(async () => view!.root.findAllByType("input")[0].props.onChange({ target: { checked: true } }))
      await act(async () => { running = view!.root.findAllByType("button").find((button) => button.children.includes("lint.runLint"))!.props.onClick(); await Promise.resolve() })
      await act(async () => { view!.unmount(); view = create(<LintView />) })
      expect(signal!.aborted).toBe(false)
      await act(async () => view!.root.findAllByType("button").find((button) => button.children.includes("lint.pause"))!.props.onClick())
      expect(signal!.aborted).toBe(true)
    } finally {
      await act(async () => { finish({ status: "cancelled", items: [], reasons: ["检查已取消"] }); await running })
    }
    expect(JSON.stringify(view!.toJSON())).toContain("lint.paused")
    expect(JSON.stringify(view!.toJSON())).toContain("lint.resume")
    expect(JSON.stringify(view!.toJSON())).not.toContain("检查已取消")
    expect(JSON.stringify(view!.toJSON())).not.toContain("lint.allClear")
  })

  it("后台运行期间切换项目，进度和错误按项目隔离，结果保存到原项目", async () => {
    let finish!: (report: Awaited<ReturnType<typeof runWikiReview>>) => void
    const deferred = new Promise<Awaited<ReturnType<typeof runWikiReview>>>((resolve) => { finish = resolve })
    vi.mocked(runWikiReview).mockImplementation(async (_path, _config, _signal, progress) => { progress?.({ completed: 1, total: 2, detail: "项目A检查中" }); return deferred })
    let running: Promise<void> | undefined
    try {
      await act(async () => { view = create(<LintView />) })
      await act(async () => view!.root.findAllByType("input")[0].props.onChange({ target: { checked: true } }))
      await act(async () => { running = view!.root.findAllByType("button").find((button) => button.children.includes("lint.runLint"))!.props.onClick(); await Promise.resolve() })
      await act(async () => {
        useWikiStore.setState({ project: { id: "B", path: "/project-b", name: "B" } })
        useLintStore.setState({ items: [{ id: "b", type: "orphan", severity: "info", page: "B.md", detail: "B问题", createdAt: 0 }] })
      })
      expect(JSON.stringify(view!.toJSON())).not.toContain("项目A检查中")
    } finally {
      await act(async () => { finish({ status: "incomplete", items: [], reasons: ["项目A召回失败"] }); await running })
    }
    expect(useLintStore.getState().items.map((item) => item.page)).toEqual(["B.md"])
    expect(saveLintItems).toHaveBeenLastCalledWith("/project", [])
    expect(JSON.stringify(view!.toJSON())).not.toContain("项目A召回失败")
    await act(async () => useWikiStore.setState({ project: { id: "test", name: "test", path: "/project" } }))
    expect(JSON.stringify(view!.toJSON())).toContain("项目A召回失败")
  })

  it.each(["incomplete", "cancelled"] as const)("%s 显示原因且不显示正常通过", async (status) => {
    vi.mocked(runWikiReview).mockResolvedValue({ status, items: [], reasons: ["本轮检查未完成"] })
    await act(async () => { view = create(<LintView />) })
    const checkbox = view!.root.findAllByType("input").find((input) => input.props.type === "checkbox")!
    await act(async () => checkbox.props.onChange({ target: { checked: true } }))
    const run = view!.root.findAllByType("button").find((button) => button.children.includes("lint.runLint"))!
    await act(async () => { await run.props.onClick() })
    const output = JSON.stringify(view!.toJSON())
    expect(runWikiReview).toHaveBeenCalledTimes(1)
    expect(output).toContain("本轮检查未完成")
    expect(output).not.toContain("lint.allClear")
  })
})
