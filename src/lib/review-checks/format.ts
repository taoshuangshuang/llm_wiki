/** 格式检查：只校验传入页面，不读取项目文件或调用模型。 */
import yaml from "js-yaml"
import { parseWikiSchemaRouting, validateWikiPageRouting } from "../wiki-schema"
import { failureResult, materialScope, type ReviewMaterial, type ReviewCheckResult, type PageCheckIssue } from "./types"

/** 用严格 YAML 检查兜底，不能把读取时的容错解析误当成结构合格。 */
export function inspectStructure(path: string, content: string, schema: string): PageCheckIssue[] {
  const problems: string[] = []
  const block = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  let fields: Record<string, unknown> | null = null
  try {
    const parsed: unknown = block ? yaml.load(block[1], { schema: yaml.JSON_SCHEMA }) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>
  } catch { /* 统一归入结构问题，由同一轮修复处理。 */ }
  if (!fields) problems.push("缺少规范的 YAML frontmatter，或 YAML 无法解析")
  else {
    for (const key of ["type", "title"]) {
      if (typeof fields[key] !== "string" || !fields[key].trim()) problems.push(`缺少有效的 ${key}`)
    }
    if (!Array.isArray(fields.sources) || !fields.sources.length || fields.sources.some((s) => typeof s !== "string" || !s.trim())) {
      problems.push("sources 必须是非空字符串列表")
    }
    if (fields.related !== undefined && (!Array.isArray(fields.related) || fields.related.some((s) => typeof s !== "string" || /\[\[|\]\]/.test(s)))) {
      problems.push("related 必须是页面标识字符串列表，不包含双括号包装或嵌套数组")
    }
    const routing = parseWikiSchemaRouting(schema)
    const issue = validateWikiPageRouting(path, content, routing)
    if (issue) problems.push(issue.message)
    // 历史来源摘要仍可读取，不要求其类型加入项目业务类型表。
    const managedSource = fields.type === "source" && /^wiki\/sources\/[^/]+\.md$/.test(path)
    if (fields.type === "source" && !managedSource) problems.push("来源摘要必须位于 wiki/sources/ 下")
    if (!managedSource && typeof fields.type === "string" && Object.keys(routing.typeDirs).length && !routing.typeDirs[fields.type]) {
      problems.push(`schema 未定义类型 ${fields.type}`)
    }
  }
  if (block && !content.slice(block[0].length).trim()) problems.push("页面正文为空")
  return problems.map((description) => ({ kind: "structure", description, sourceEvidence: "", pageEvidence: path, pages: [path] }))
}

/** 按项目规范检查页面，保留问题所属页面与实际检查版本。 */
export function checkFormat(options: { pages: ReviewMaterial[]; schema: string; referenceIssues?: PageCheckIssue[]; signal?: AbortSignal }): ReviewCheckResult<PageCheckIssue> {
  const issues: PageCheckIssue[] = [...options.referenceIssues ?? []]
  const checkedScope: ReviewCheckResult<PageCheckIssue>["checkedScope"] = []
  try {
    options.signal?.throwIfAborted()
    if (!options.pages.length) throw new Error("没有可检查的页面")
    for (const page of options.pages) {
      options.signal?.throwIfAborted()
      issues.push(...inspectStructure(page.path, page.text, options.schema))
      checkedScope.push(materialScope(page))
    }
    return { status: "complete", issues, checkedScope }
  } catch (error) { return failureResult(error, issues, checkedScope, options.signal) }
}
