import { describe, expect, it } from "vitest"
import { parseModuleCatalog } from "./catalog"
import { loadModulePages, pagesForModule } from "./pages"

const catalog = parseModuleCatalog('## Business Modules\n```json\n{"version":1,"modules":[{"id":"root","name":"根","description":"整体","children":[{"id":"a","name":"A","description":"A领域"},{"id":"b","name":"B","description":"B领域"}]}]}\n```')!

describe("业务模块页面浏览契约", () => {
  it("父节点显示自身与全部子模块，多标签页面去重而同名跨目录页面不合并", () => {
    const pages = [
      { path: "/p/wiki/x/same.md", title: "Same", moduleIds: ["a", "b"] },
      { path: "/p/wiki/y/same.md", title: "Same", moduleIds: ["b"] },
      { path: "/p/wiki/parent.md", title: "Parent", moduleIds: ["root"] },
    ]
    expect(pagesForModule(catalog.byId.get("root")!, [...pages, pages[0]])).toHaveLength(3)
    expect(pagesForModule(catalog.byId.get("a")!, pages)).toHaveLength(1)
  })
  it("逐级列目录，读取深层页面，不依赖懒加载 children", async () => {
    const visited: string[] = []
    const result = await loadModulePages("/p", catalog, {
      list: async (directory) => {
        visited.push(directory)
        return directory === "/p/wiki" ? [{ name: "nested", path: "/p/wiki/nested", is_dir: true }]
          : [{ name: "page.md", path: "/p/wiki/nested/page.md", is_dir: false }]
      },
      read: async () => "---\ntitle: 深层页面\ntags: [module/a]\n---\nBody",
    })
    expect(visited).toEqual(["/p/wiki", "/p/wiki/nested"])
    expect(result.pages).toEqual([{ path: "/p/wiki/nested/page.md", title: "深层页面", moduleIds: ["a"] }])
  })
  it("部分文件不可读时保留其他页面并报告问题", async () => {
    const result = await loadModulePages("/p", catalog, {
      list: async () => [{ name: "bad.md", path: "/p/wiki/bad.md", is_dir: false }, { name: "ok.md", path: "/p/wiki/ok.md", is_dir: false }],
      read: async (path) => { if (path.endsWith("bad.md")) throw new Error("unreadable"); return "# 未标注页面" },
    })
    expect(result.unreadable).toEqual(["/p/wiki/bad.md"])
    expect(result.pages[0].moduleIds).toEqual(["unclassified"])
  })
})
