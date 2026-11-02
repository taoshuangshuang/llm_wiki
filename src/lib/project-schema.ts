/** 项目 Schema 按职责加载；旧版单文件只在内存中拆分，不改写用户配置。 */
import { fileExists, readFile, writeFile, saveWorkflowFile } from "@/commands/fs"

export type SchemaPurpose = "analysis" | "generation" | "classification"

export interface ProjectSchemaParts {
  core: string
  rules: string
  modules: string
}

export const SCHEMA_RULES_PATH = "page-rules.md"
export const SCHEMA_MODULES_PATH = "business-modules.md"

/** 旧拆分配置复制到根目录；保留旧文件，根目录已有内容（含空文件）绝不覆盖。 */
export async function migrateProjectSchemaFiles(projectPath: string): Promise<void> {
  const root = projectPath.replace(/\/+$/, "")
  for (const path of [SCHEMA_RULES_PATH, SCHEMA_MODULES_PATH]) {
    if (await fileExists(`${root}/${path}`)) continue
    const legacy = `${root}/schema/${path}`
    if (await fileExists(legacy)) await saveWorkflowFile(root, path, null, await readFile(legacy))
  }
}

const RULE_HEADINGS = new Set([
  "naming conventions", "frontmatter", "index format", "log format",
  "cross-referencing rules",
  "命名规范", "命名约定", "前置元数据", "索引格式", "日志格式", "交叉引用规则",
])

/** 只移动已知职责的完整章节；代码块中的标题不参与分段，自定义章节保留在核心中。 */
export function splitProjectSchema(markdown: string): ProjectSchemaParts {
  const sections: Record<keyof ProjectSchemaParts, string[]> = { core: [], rules: [], modules: [] }
  let kind: keyof ProjectSchemaParts = "core"
  let level = 0
  let fence = ""
  let fenceLength = 0
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) {
        fence = marker[1][0]
        fenceLength = marker[1].length
      } else if (marker[1][0] === fence && marker[1].length >= fenceLength && !marker[2].trim()) {
        fence = ""
      }
    } else if (!fence) {
      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (heading && (kind === "core" || heading[1].length <= level)) {
        const title = heading[2].trim().toLowerCase()
        kind = /^(business modules|业务模块)$/.test(title) ? "modules"
          : RULE_HEADINGS.has(title) ? "rules" : "core"
        level = heading[1].length
      }
    }
    sections[kind].push(line)
  }
  return {
    core: sections.core.join("\n").trim(),
    rules: sections.rules.join("\n").trim(),
    modules: sections.modules.join("\n").trim(),
  }
}

/** 独立文件存在即优先（空文件表示禁用）；读取错误直接上抛，不回退到旧规则。 */
async function readOptionalSchema(path: string): Promise<string | null> {
  return await fileExists(path) ? readFile(path) : null
}

/** 分析只读核心，生成/验收附加写作规范，业务分类只读模块字典。 */
export async function loadProjectSchema(projectPath: string, purpose: SchemaPurpose): Promise<string> {
  const root = projectPath.replace(/\/+$/, "")
  if (purpose === "classification") {
    const modules = await readOptionalSchema(`${root}/${SCHEMA_MODULES_PATH}`)
      ?? await readOptionalSchema(`${root}/schema/business-modules.md`)
    if (modules !== null) return modules
  }
  const raw = await readOptionalSchema(`${root}/schema.md`)
    ?? await readOptionalSchema(`${root}/wiki/schema.md`) ?? ""
  const parts = splitProjectSchema(raw)
  if (purpose === "classification") return parts.modules
  if (purpose === "analysis") return parts.core
  const rules = await readOptionalSchema(`${root}/${SCHEMA_RULES_PATH}`)
    ?? await readOptionalSchema(`${root}/schema/page-rules.md`) ?? parts.rules
  return [parts.core, rules.trim()].filter(Boolean).join("\n\n")
}

/** 新项目模板物理拆分为核心和可选片段；不用于覆盖已有项目。 */
export async function writeProjectSchema(projectPath: string, markdown: string): Promise<void> {
  const root = projectPath.replace(/\/+$/, "")
  const parts = splitProjectSchema(markdown)
  await writeFile(`${root}/schema.md`, `${parts.core}\n`)
  await writeFile(`${root}/${SCHEMA_RULES_PATH}`, parts.rules ? `${parts.rules}\n` : "")
  await writeFile(`${root}/${SCHEMA_MODULES_PATH}`, parts.modules ? `${parts.modules}\n` : "")
}
