import { describe, expect, it } from "vitest"
import { parseFrontmatter } from "@/lib/frontmatter"
import { mergePageContent } from "@/lib/page-merge"
import { parseModuleCatalog } from "./catalog"
import { readPageModuleIds, replaceModuleTags } from "./page-tags"

const catalog = parseModuleCatalog('## Business Modules\n```json\n{"version":1,"modules":[{"id":"query","name":"查询","description":"查询知识"}]}\n```')!

describe("业务标签替换与正文保留", () => {
  it("重新分类移除旧业务标签及未分类，保留普通标签、其他字段及正文", () => {
    const content = "---\ntype: concept\n# 保留原有字段说明\ntitle: Example\ntags: [SQL, module/old, module/unclassified]\nsources: [a.md]\n---\n# 正文\n内容含 tags: 不应被修改"
    const next = replaceModuleTags(content, ["query"], catalog)
    expect(parseFrontmatter(next).frontmatter).toMatchObject({
      type: "concept", title: "Example", sources: ["a.md"], tags: ["SQL", "module/query"],
    })
    expect(next).toContain("# 保留原有字段说明")
    expect(parseFrontmatter(next).body).toBe(parseFrontmatter(content).body)
  })
  it.each(["tags: SQL", "tags:\n  - SQL\n  - module/old", '"tags": [SQL]', "tags: [\n  SQL,\n  module/old\n]"])(
    "兼容历史 tags 形式且不会产生重复 YAML 键：%s", (tags) => {
      const next = replaceModuleTags(`---\ntype: concept\n${tags}\ntitle: A\n---\nBody`, ["query"], catalog)
      expect(parseFrontmatter(next).frontmatter?.tags).toEqual(["SQL", "module/query"])
      expect(parseFrontmatter(next).frontmatter?.title).toBe("A")
    },
  )
  it("无标签或只有失效模块的旧页面进入未分类", () => {
    expect(readPageModuleIds("# 未标注正文", catalog)).toEqual(["unclassified"])
    expect(readPageModuleIds("---\ntags: [module/missing]\n---\nBody", catalog)).toEqual(["unclassified"])
    expect(replaceModuleTags("# 无 frontmatter 的正文", [], catalog)).toContain("# 无 frontmatter 的正文")
  })
  it("Windows 换行页面更新标签后保持正文的逐字内容", () => {
    const content = "---\r\ntype: concept\r\ntags: [SQL]\r\n---\r\n# Body\r\nline\r\n"
    const result = replaceModuleTags(content, ["query"], catalog)
    expect(parseFrontmatter(result).body).toBe(parseFrontmatter(content).body)
    expect(parseFrontmatter(result).frontmatter?.tags).toEqual(["SQL", "module/query"])
  })
  it("先完成多来源合并，再替换业务标签，普通主题仍按原契约合并", async () => {
    const old = "---\ntype: concept\ntitle: A\ntags: [SQL, module/old]\nsources: [a.md]\n---\n旧来源知识"
    const incoming = "---\ntype: concept\ntitle: A\ntags: [缓存, module/query]\nsources: [b.md]\n---\n新来源知识"
    const merged = await mergePageContent(incoming, old, async () => `${incoming}\n旧来源知识`, { sourceFileName: "b.md", pagePath: "wiki/concepts/a.md" })
    const next = replaceModuleTags(merged, ["query"], catalog)
    expect(parseFrontmatter(next).frontmatter?.tags).toEqual(["SQL", "缓存", "module/query"])
    expect(parseFrontmatter(next).frontmatter?.sources).toEqual(["a.md", "b.md"])
    expect(next).toContain("旧来源知识")
    expect(next).toContain("新来源知识")
  })
})
