/** 筛选契约覆盖父子模块、跨模块去重及结构/语义两种页面路径。 */
import { describe, expect, it } from "vitest"
import type { LintItem } from "@/stores/lint-store"
import { parseModuleCatalog } from "@/features/business-modules/catalog"
import { filterLintItems, lintModuleIndex } from "./lint-filters"

const catalog = parseModuleCatalog('## Business Modules\n```json\n{"version":1,"modules":[{"id":"root","name":"查询","description":"查询","children":[{"id":"leaf","name":"解析","description":"解析"}]},{"id":"other","name":"其他","description":"其他"}]}\n```')!
const modules = lintModuleIndex("/project", [
  { path: "/project/wiki/topics/a.md", title: "A", type: "concept", moduleIds: ["leaf", "other"] },
  { path: "/project/wiki/topics/b.md", title: "B", type: "concept", moduleIds: ["other"] },
])
const items: LintItem[] = [
  { id: "a", type: "orphan", severity: "info", page: "topics/a.md", detail: "缺少引用", createdAt: 0 },
  { id: "b", type: "semantic", severity: "warning", page: "wiki/topics/b.md", affectedPages: ["wiki/topics/a.md"], detail: "内容冲突", createdAt: 0 },
  { id: "c", type: "no-outlinks", severity: "info", page: "topics/c.md", detail: "没有出站链接", createdAt: 0 },
]
const defaults = { type: "", moduleId: "", query: "" }

describe("Wiki 问题筛选", () => {
  it("父模块包含子模块，跨模块问题和多页面问题各显示一次", () => {
    expect(filterLintItems(items, { ...defaults, moduleId: "root" }, catalog, modules).map((item) => item.id)).toEqual(["a", "b"])
    expect(filterLintItems(items, { ...defaults, moduleId: "other" }, catalog, modules).map((item) => item.id)).toEqual(["a", "b"])
  })

  it("类型、模块、搜索同时生效，搜索覆盖相关页面", () => {
    expect(filterLintItems(items, { type: "semantic", moduleId: "root", query: "TOPICS/A" }, catalog, modules).map((item) => item.id)).toEqual(["b"])
    expect(filterLintItems(items, { type: "semantic", moduleId: "root", query: "无匹配" }, catalog, modules)).toEqual([])
  })

  it("无标签页面归入未分类，未配置模块时仍支持类型筛选", () => {
    expect(filterLintItems(items, { ...defaults, moduleId: "unclassified" }, catalog, modules).map((item) => item.id)).toEqual(["c"])
    expect(filterLintItems(items, { ...defaults, type: "orphan" }, null, new Map()).map((item) => item.id)).toEqual(["a"])
  })
})
