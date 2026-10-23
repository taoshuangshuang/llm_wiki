import { describe, expect, it } from "vitest"
import { parseModuleCatalog } from "./catalog"
import { loadModulePages, pagesForModule } from "./pages"
import { parseWikiSchemaRouting } from "@/lib/wiki-schema"

const catalog = parseModuleCatalog('## Business Modules\n```json\n{"version":1,"modules":[{"id":"root","name":"根","description":"整体","children":[{"id":"a","name":"A","description":"A领域"},{"id":"b","name":"B","description":"B领域"}]}]}\n```')!

describe("业务模块页面浏览契约", () => {
  it("父节点统计自身与全部子模块，多标签页面去重而同名跨目录页面不合并", () => {
    const pages = [
      { path: "/p/wiki/x/same.md", title: "Same", type: "concept", moduleIds: ["a", "b"] },
      { path: "/p/wiki/y/same.md", title: "Same", type: "design", moduleIds: ["b"] },
      { path: "/p/wiki/parent.md", title: "Parent", type: "module", moduleIds: ["root"] },
    ]
    expect(pagesForModule(catalog.byId.get("root")!, [...pages, pages[0]])).toHaveLength(3)
    expect(pagesForModule(catalog.byId.get("a")!, pages)).toHaveLength(1)
  })
  it("节点仅列直接归属，后代页面不在祖先重复显示，独立分支仍支持多标签", () => {
    const nested = parseModuleCatalog('## Business Modules\n```json\n{"version":1,"modules":[{"id":"root","name":"根","description":"整体","children":[{"id":"a","name":"A","description":"A领域","children":[{"id":"leaf","name":"叶子","description":"叶子领域"}]},{"id":"b","name":"B","description":"B领域"}]}]}\n```')!
    const pages = [
      { path: "/p/wiki/root.md", title: "根页面", type: "module", moduleIds: ["root"] },
      { path: "/p/wiki/a.md", title: "A页面", type: "design", moduleIds: ["a"] },
      // 即使历史标签同时包含父、子节点，列表也只出现在最具体节点下。
      { path: "/p/wiki/leaf.md", title: "叶子页面", type: "concept", moduleIds: ["root", "a", "leaf"] },
      { path: "/p/wiki/shared.md", title: "跨分支页面", type: "practice", moduleIds: ["a", "b"] },
    ]
    const pathsFor = (id: string) => pagesForModule(nested.byId.get(id)!, [...pages, pages[2]], ["module", "practice", "design", "concept"], "direct").map((page) => page.path)
    expect(pathsFor("root")).toEqual(["/p/wiki/root.md"])
    expect(pathsFor("a")).toEqual(["/p/wiki/shared.md", "/p/wiki/a.md"])
    expect(pathsFor("leaf")).toEqual(["/p/wiki/leaf.md"])
    expect(pathsFor("b")).toEqual(["/p/wiki/shared.md"])
    expect(pagesForModule(nested.byId.get("root")!, [...pages, pages[2]])).toHaveLength(4)
  })
  it("按项目 schema 的类型顺序排序，同类型按标题和路径排序，系统与未知类型放在末尾", () => {
    const schema = "## Page Types\n| Type | Directory | Purpose |\n| practice | wiki/practices/ | 示例 |\n| concept | wiki/concepts/ | 概念 |\n"
    const typeOrder = Object.keys(parseWikiSchemaRouting(schema).typeDirs)
    const pages = [
      { path: "/p/wiki/sources/source.md", title: "A 来源", type: "source", moduleIds: ["a"] },
      { path: "/p/wiki/concepts/b.md", title: "B 概念", type: "concept", moduleIds: ["a"] },
      { path: "/p/wiki/concepts/c.md", title: "A 概念", type: "concept", moduleIds: ["b"] },
      { path: "/p/wiki/concepts/a.md", title: "A 概念", type: "concept", moduleIds: ["a", "b"] },
      { path: "/p/wiki/practices/example.md", title: "Z 示例", type: "practice", moduleIds: ["a"] },
      { path: "/p/wiki/other.md", title: "Z 未标注", type: "other", moduleIds: ["a"] },
    ]
    const root = catalog.byId.get("root")!
    expect(pagesForModule(root, [...pages, pages[3]], typeOrder).map((page) => page.path)).toEqual([
      "/p/wiki/practices/example.md", "/p/wiki/concepts/a.md", "/p/wiki/concepts/c.md",
      "/p/wiki/concepts/b.md", "/p/wiki/sources/source.md", "/p/wiki/other.md",
    ])
    // 顺序修改后立即按新配置排列，不把任何业务类型顺序写死。
    expect(pagesForModule(root, pages, [...typeOrder].reverse())[0].type).toBe("concept")
  })
  it("逐级列目录，读取深层页面，不依赖懒加载 children", async () => {
    const visited: string[] = []
    const result = await loadModulePages("/p", catalog, {
      list: async (directory) => {
        visited.push(directory)
        return directory === "/p/wiki" ? [{ name: "nested", path: "/p/wiki/nested", is_dir: true }]
          : [{ name: "page.md", path: "/p/wiki/nested/page.md", is_dir: false }]
      },
      read: async () => "---\ntitle: 深层页面\ntype: practice\ntags: [module/a]\n---\nBody",
    })
    expect(visited).toEqual(["/p/wiki", "/p/wiki/nested"])
    expect(result.pages).toEqual([{ path: "/p/wiki/nested/page.md", title: "深层页面", type: "practice", moduleIds: ["a"] }])
  })
  it("部分文件不可读时保留其他页面并报告问题", async () => {
    const result = await loadModulePages("/p", catalog, {
      list: async () => [{ name: "bad.md", path: "/p/wiki/bad.md", is_dir: false }, { name: "ok.md", path: "/p/wiki/ok.md", is_dir: false }],
      read: async (path) => { if (path.endsWith("bad.md")) throw new Error("unreadable"); return "# 未标注页面" },
    })
    expect(result.unreadable).toEqual(["/p/wiki/bad.md"])
    expect(result.pages[0].moduleIds).toEqual(["unclassified"])
    expect(result.pages[0].type).toBe("other")
  })
})
