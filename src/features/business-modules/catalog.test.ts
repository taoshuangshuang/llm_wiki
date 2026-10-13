import { describe, expect, it } from "vitest"
import { descendantIds, normalizeModuleIds, parseModuleCatalog } from "./catalog"

export const MODULE_JSON = { version: 1, modules: [{
  id: "platform", name: "平台", description: "平台整体知识", children: [
    { id: "query", name: "查询", description: "以查询为主的知识", children: [
      { id: "parser", name: "解析", description: "以解析为主的知识" },
    ] },
    { id: "storage", name: "存储", description: "以存储为主的知识" },
  ],
}] }
export const MODULE_SCHEMA = `# Wiki Schema\n\n## Business Modules\n\n\`\`\`json\n${JSON.stringify(MODULE_JSON)}\n\`\`\`\n\n## Other\n`

describe("业务模块字典契约", () => {
  it("保留多级说明，父节点包含自身及所有后代，并提供未分类保底", () => {
    const catalog = parseModuleCatalog(MODULE_SCHEMA)!
    expect([...descendantIds(catalog.roots[0])]).toEqual(["platform", "query", "parser", "storage"])
    expect(catalog.byId.get("parser")?.description).toBe("以解析为主的知识")
    expect(catalog.byId.has("unclassified")).toBe(true)
  })
  it("未配置章节时不激活功能，也不误读其他 JSON 代码块", () => {
    expect(parseModuleCatalog("## Other\n```json\n{}\n```")).toBeNull()
  })
  it("缺少 description 或全局重复 ID 时拒绝字典", () => {
    const schema = (modules: unknown[]) => `## Business Modules\n\`\`\`json\n${JSON.stringify({ version: 1, modules })}\n\`\`\``
    expect(() => parseModuleCatalog(schema([{ id: "a", name: "A" }]))).toThrow("description")
    const node = { id: "a", name: "A", description: "范围" }
    expect(() => parseModuleCatalog(schema([node, node]))).toThrow("重复")
  })
  it("字典不合法或章节存在多个 JSON 时给出明确错误", () => {
    expect(() => parseModuleCatalog("## Business Modules\n```json\n{\n```" )).toThrow("JSON")
    expect(() => parseModuleCatalog(MODULE_SCHEMA.replace("## Other", "```json\n{}\n```"))).toThrow("一个 JSON")
  })
  it("允许实质跨模块分类，移除祖先重复标签和未分类残留", () => {
    const catalog = parseModuleCatalog(MODULE_SCHEMA)!
    expect(normalizeModuleIds(["platform", "query", "parser", "storage", "parser", "unclassified"], catalog))
      .toEqual(["parser", "storage"])
    expect(normalizeModuleIds(["invented"], catalog)).toEqual(["unclassified"])
  })
})
