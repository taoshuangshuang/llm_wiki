/** 通过用户可见导航验证三级布局、草稿保留和共享配置定位。 */
import { createElement } from "react"
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const files = vi.hoisted(() => new Map<string, string>())
const save = vi.hoisted(() => vi.fn(async () => undefined))
const chooseDirectory = vi.hoisted(() => vi.fn())
const listDirectory = vi.hoisted(() => vi.fn(async (path: string) => {
  const entries = new Map<string, { path: string; name: string; is_dir: boolean }>()
  for (const file of files.keys()) {
    if (!file.startsWith(path + "/")) continue
    const relative = file.slice(path.length + 1)
    const name = relative.split("/")[0]
    entries.set(name, { path: path + "/" + name, name, is_dir: relative.includes("/") })
  }
  return [...entries.values()]
}))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: chooseDirectory }))
vi.mock("@/commands/fs", () => ({
  fileExists: async (path: string) => files.has(path),
  listDirectory,
  readFile: async (path: string) => { if (!files.has(path)) throw new Error("不存在"); return files.get(path)! },
  saveWorkflowFile: async (_project: string, path: string, _expected: string | null, content: string) => { await save(); files.set(`/project/${path}`, content) },
}))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn() }))
vi.mock("../sections/llm-provider-section", () => ({ LlmProviderSection: () => null }))
vi.mock("../sections/embedding-section", () => ({ EmbeddingSection: () => null }))
vi.mock("../sections/web-search-section", () => ({ WebSearchSection: () => null }))
vi.mock("../sections/mineru-section", () => ({ MineruSection: () => null }))
vi.mock("../sections/multimodal-section", () => ({ MultimodalSection: () => null }))
vi.mock("../sections/scheduled-import-section", () => ({ ScheduledImportSection: () => null }))
vi.mock("../sections/network-section", () => ({ NetworkSection: () => null }))
vi.mock("../sections/source-watch-section", () => ({ SourceWatchSection: () => null }))
vi.mock("../sections/retrieval-section", () => ({ RetrievalSection: () => null }))
vi.mock("../sections/output-section", () => ({ OutputSection: () => null }))
vi.mock("../sections/review-prompt-section", () => ({ ReviewPromptSection: () => null }))
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: React.ComponentProps<"button">) => createElement("button", props, children) }))
vi.mock("@/components/ui/input", () => ({ Input: (props: React.ComponentProps<"input">) => createElement("input", props) }))
import { WorkflowSettingsView } from "./workflow-settings-view"
import { useWikiStore } from "@/stores/wiki-store"
import { parseModuleCatalog } from "@/features/business-modules/catalog"

let view: ReactTestRenderer | undefined
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  files.clear(); save.mockClear()
  chooseDirectory.mockReset()
  listDirectory.mockClear()
  files.set("/project/purpose.md", "原始知识目标")
  useWikiStore.setState({ project: { id: "project", name: "测试知识库", path: "/project" } })
})
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
async function render() { await act(async () => { view = create(createElement(WorkflowSettingsView)) }) }
function label(entry: ReactTestInstance): string {
  return entry.children.map((child) => typeof child === "string" ? child : label(child)).join("")
}
async function click(text: string) {
  const button = view!.root.findAllByType("button").find((entry) => label(entry).replace(/•/g, "").replace(/^\d+/, "").replace(/按条件执行$/, "") === text)
  if (!button) throw new Error(`找不到按钮：${text}`)
  await act(async () => { button.props.onClick() })
}
async function fill(label: string, value: string) {
  const field = view!.root.findAll((entry) => typeof entry.type === "string" && entry.props["aria-label"] === label)[0]
  if (!field) throw new Error("找不到字段 " + label)
  await act(async () => { field.props.onChange({ target: { value } }) })
}

const moduleFile = "/project/business-modules.md"
const dictionary = [
  "## 维护说明", "保留此处的 Markdown 说明。", "",
  "## Business Modules", "```json",
  '{"version":1,"modules":[{"id":"root","name":"平台","description":"平台范围","children":[{"id":"query","name":"查询","description":"查询范围","children":[{"id":"sql","name":"SQL 构建","description":"SQL 范围","custom":"保留附加字段"}]}]},{"id":"other","name":"其他","description":"其他范围"}]}',
  "```", "", "## 其他规则", "保留其他章节。", "",
].join("\r\n")

describe("知识流程导航与配置", () => {
  it("顶部切阶段、左侧切节点，无配置节点仍展示输入输出和职责", async () => {
    await render()
    const nav = view!.root.findByProps({ "aria-label": "知识处理主流程" })
    expect(nav.findAllByType("button")).toHaveLength(8)
    await click("匹配与写入")
    await click("页面提交与图片归位")
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("程序自动执行")
    expect(text).toContain("原子写入")
    expect(text).toContain("此节点暂无独立设置")
    expect(text).toContain("修改影响与生效方式")
  })

  it("全库引用维护位于提交后，说明章节退回和缺失引用转审阅规则", async () => {
    await render()
    await click("匹配与写入")
    await click("全库引用维护")
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain("页面写入完成、格式检查之前")
    expect(text).toContain("章节不存在则退回页面链接")
    expect(text).toContain("交格式检查转待审阅")
    expect(text).toContain("不创建占位页")
  })

  it("模块字典直接展示一级模块，可逐级展开，其他设置保留节点说明", async () => {
    files.set(moduleFile, dictionary)
    await render()
    await click("业务类型与模块字典")
    const settings = view!.root.findByProps({ "aria-label": "节点设置" })
    const tree = settings.findByProps({ "aria-label": "模块树" })
    expect(label(tree)).toBe("平台其他")
    const actions = settings.findByProps({ "aria-label": "模块操作" })
    expect(actions.findAllByType("button").map(label)).toEqual(["新增顶级模块", "新增子模块", "删除模块"])
    expect(view!.root.findAllByProps({ "aria-label": "节点说明" })).toHaveLength(0)
    expect(settings.findAllByType("h3")).toHaveLength(0)
    await act(async () => { tree.findByProps({ "aria-label": "展开 平台" }).props.onClick() })
    expect(label(tree)).toContain("查询")
    expect(label(tree)).not.toContain("SQL 构建")
    await act(async () => { tree.findByProps({ "aria-label": "展开 查询" }).props.onClick() })
    expect(label(tree)).toContain("SQL 构建")
    await act(async () => { tree.findByProps({ "aria-label": "收起 平台" }).props.onClick() })
    expect(label(tree)).toBe("平台其他")
    await click("向量库配置")
    expect(view!.root.findByProps({ "aria-label": "节点设置" })).toBeTruthy()
    expect(view!.root.findByProps({ "aria-label": "节点说明" })).toBeTruthy()
    await click("匹配与写入")
    await click("向量索引构建")
    expect(JSON.stringify(view!.toJSON())).toContain("此节点暂无独立设置")
    const reference = view!.root.findByProps({ "aria-label": "共用配置引用" }).findAllByType("button").find((entry) => label(entry).includes("向量库配置"))!
    await act(async () => { reference.props.onClick() })
    expect(JSON.stringify(view!.toJSON())).toContain("公共设置")
    expect(view!.root.findByProps({ "aria-label": "公共设置的执行节点" })).toBeTruthy()
  })

  it("文件草稿跨阶段保留，保存只提交当前文件", async () => {
    await render()
    await act(async () => { view!.root.findByProps({ "aria-label": "知识库目标与收录范围" }).props.onChange({ target: { value: "新的知识目标" } }) })
    await click("输出")
    await click("公共设置")
    expect(view!.root.findByProps({ "aria-label": "知识库目标与收录范围" }).props.value).toBe("新的知识目标")
    expect(files.get("/project/purpose.md")).toBe("原始知识目标")
    await click("保存当前文件")
    expect(files.get("/project/purpose.md")).toBe("新的知识目标")
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("共用规则以跳转呈现，切换项目丢弃旧项目草稿", async () => {
    await render()
    await click("后台审阅")
    await click("知识补充建议")
    const reference = view!.root.findByProps({ "aria-label": "共用配置引用" }).findAllByType("button").find((button) => label(button).includes("已有知识核对与共用规则"))!
    await act(async () => { reference.props.onClick() })
    expect(view!.root.findAllByType("textarea").some((entry) => entry.props["aria-label"] === "统一后台审阅")).toBe(true)
    await act(async () => { useWikiStore.setState({ project: { id: "other", name: "另一个", path: "/other" } }) })
    expect(view!.root.findByProps({ "aria-label": "知识库目标与收录范围" }).props.value).toBe("")
  })

  it("搜索并编辑深层模块后，表单与原始配置共用草稿和落盘入口", async () => {
    files.set(moduleFile, dictionary)
    await render()
    await click("业务类型与模块字典")
    await fill("搜索模块", "sql")
    expect(label(view!.root.findByProps({ "aria-label": "模块树" }))).toBe("平台查询SQL 构建")
    await click("SQL 构建")
    await fill("模块名称", "")
    await fill("模块名称", "SQL 生成")
    await fill("分类说明", "SQL 生成与参数绑定")
    await click("高级 · 编辑原始配置")
    const draft = view!.root.findByType("textarea").props.value
    expect(parseModuleCatalog(draft)?.byId.get("query")?.children[0]).toMatchObject({
      id: "sql", name: "SQL 生成", description: "SQL 生成与参数绑定",
    })
    expect(draft).toContain('"custom": "保留附加字段"')
    expect(draft).toContain("## 其他规则\r\n保留其他章节。")
    expect(files.get(moduleFile)).toBe(dictionary)
    await click("返回模块编辑")
    await click("保存字典")
    expect(files.get(moduleFile)).toBe(draft)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("新增模块后保留 ID，删除子树前展示实际引用且只保存字典", async () => {
    files.set(moduleFile, dictionary)
    const page = "/project/wiki/query.md"
    const body = "---\ntitle: 查询页面\ntags: [module/root, module/sql, module/other]\n---\n原文"
    files.set(page, body)
    await render()
    await click("业务类型与模块字典")
    await click("新增顶级模块")
    await fill("模块 ID", "overview")
    await fill("模块名称", "概览")
    await fill("分类说明", "概览范围")
    await click("添加到草稿")
    await click("平台")
    await click("新增子模块")
    await fill("模块 ID", "query")
    await fill("模块名称", "新查询")
    await fill("分类说明", "新的分类说明")
    await click("添加到草稿")
    expect(JSON.stringify(view!.toJSON())).toContain("业务模块 id 重复")
    await fill("模块 ID", "new-query")
    await click("添加到草稿")
    await click("查询")
    await click("删除模块")
    const preview = view!.root.findByProps({ "aria-label": "删除模块影响" })
    expect(label(preview)).toContain("受影响页面 1 篇")
    expect(label(preview)).toContain("wiki/query.md")
    await click("确认删除")
    expect(files.get(moduleFile)).toBe(dictionary)
    await click("保存字典")
    const saved = parseModuleCatalog(files.get(moduleFile)!)!
    expect(saved.roots.some((entry) => entry.id === "overview")).toBe(true)
    expect(saved.byId.has("new-query")).toBe(true)
    expect(saved.byId.has("query")).toBe(false)
    expect(saved.byId.has("sql")).toBe(false)
    expect(files.get(page)).toBe(body)
  })

  it("页面引用扫描不完整时禁止确认删除", async () => {
    files.set(moduleFile, dictionary)
    listDirectory.mockRejectedValueOnce(new Error("目录不可读"))
    await render()
    await click("业务类型与模块字典")
    await click("删除模块")
    const preview = view!.root.findByProps({ "aria-label": "删除模块影响" })
    expect(label(preview)).toContain("页面影响未核实完整")
    expect(preview.findAllByType("button").find((button) => label(button) === "确认删除")?.props.disabled).toBe(true)
    await click("取消")
    expect(files.get(moduleFile)).toBe(dictionary)
    expect(save).not.toHaveBeenCalled()
  })

  it("中间模块直接绑定仓库，子模块搜索 Java 包并保存继承范围与仓库图标", async () => {
    files.set(moduleFile, dictionary)
    const repository = "/repos/imeta"
    const packagePath = "engine/src/main/java/org/imeta/query"
    files.set(repository + "/.git", "gitdir: /git/modules/imeta")
    files.set("/repos/.codegraph/codegraph.db", "index")
    files.set(repository + "/engine/pom.xml", "<project/>")
    files.set(repository + "/" + packagePath + "/Builder.java", "package org.imeta.query;")
    chooseDirectory.mockResolvedValueOnce(repository)
    await render()
    await click("业务类型与模块字典")
    await fill("搜索模块", "sql")
    await click("查询")
    await click("绑定仓库")
    expect(JSON.stringify(view!.toJSON())).toContain("CodeGraph 索引 · /repos")
    await click("SQL 构建")
    const binding = view!.root.findByProps({ "aria-label": "模块源码绑定" })
    expect(label(binding)).toContain("继承自 查询")
    expect(view!.root.findAllByProps({ "aria-label": "已关联源码仓库" })).toHaveLength(2)
    await click("选择模块或包")
    await fill("搜索模块或包", "org.imeta.query")
    await act(async () => {
      view!.root.findByType("form").props.onSubmit({ preventDefault() {} })
    })
    await act(async () => {
      view!.root.findByProps({ "aria-label": "选择范围 " + packagePath }).props.onChange()
    })
    await click("应用代码范围")
    await click("保存源码绑定 · 未保存")
    const config = JSON.parse(files.get("/project/code-sources.json")!)
    expect(config.moduleBindings).toEqual({
      query: { repository, paths: [] },
      sql: { paths: [packagePath], pathsRepository: repository },
    })
    expect(files.get(moduleFile)).toBe(dictionary)
    await click("输出")
    await click("公共设置")
    await click("业务类型与模块字典")
    await fill("搜索模块", "sql")
    await click("SQL 构建")
    expect(label(view!.root.findByProps({ "aria-label": "模块源码绑定" }))).toContain("org.imeta.query")
  })
})
