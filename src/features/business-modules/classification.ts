import { commitIngestPage, contentRevision } from "@/lib/ingest-run"
import { readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { parseModuleCatalog, normalizeModuleIds, UNCLASSIFIED_ID, type ModuleCatalog } from "./catalog"
import { replaceModuleTags } from "./page-tags"
import { DEFAULT_INGEST_PROMPTS, renderIngestPromptTemplate } from "@/lib/ingest-prompts"
import { resolveIngestReasoning } from "@/lib/reasoning-capabilities"
import { withLlmStage } from "@/lib/llm-observer"
import { withProjectLock } from "@/lib/project-mutex"
import { assertIngestSnapshotsUnchanged } from "@/lib/ingest-write-guard"
import { loadProjectSchema } from "@/lib/project-schema"

export interface ModuleTagResult { content: string; warnings: string[] }
export type ModuleTagWriter = ((content: string) => Promise<ModuleTagResult>) & { enabled: boolean }
const unchangedWriter: ModuleTagWriter = Object.assign(
  async (content: string) => ({ content, warnings: [] }), { enabled: false },
)

/** 完整正文分类：输入不包含历史业务标签，避免旧分类影响新判断。 */
export async function classifyPageModules(
  content: string, catalog: ModuleCatalog, config: LlmConfig, signal?: AbortSignal,
  classificationPolicy: string = DEFAULT_INGEST_PROMPTS.classification,
  classificationTemplate: string = DEFAULT_INGEST_PROMPTS.classificationTemplate,
): Promise<{ ids: string[]; warnings: string[] }> {
  signal?.throwIfAborted()
  const parsed = parseFrontmatter(content)
  let output = ""
  let failure: Error | null = null
  await streamChat(withLlmStage(config, "module-classification"), [
    { role: "system", content: renderIngestPromptTemplate(classificationTemplate, {
      module_dictionary: JSON.stringify({ version: 1, modules: catalog.roots }),
      业务模块选择规则: classificationPolicy,
    }, ["module_dictionary"]) },
    { role: "user", content: JSON.stringify({ title: parsed.frontmatter?.title ?? "", body: parsed.body }) },
  ], {
    onToken: (token) => { output += token },
    onDone: (completion) => {
      if (completion?.truncated) failure = new Error("分类输出被截断。")
    },
    onError: (error) => { failure = error },
  }, signal, { temperature: 0.1, reasoning: resolveIngestReasoning(config) })
  signal?.throwIfAborted()
  if (failure) throw failure
  const raw = output.trim().replace(/^```json\s*\n([\s\S]*?)\n```$/i, "$1")
  const response = JSON.parse(raw) as { moduleIds?: unknown }
  if (!Array.isArray(response?.moduleIds) || !response.moduleIds.every((id) => typeof id === "string")) {
    throw new Error("分类结果必须包含 moduleIds 字符串数组。")
  }
  const ids = response.moduleIds as string[]
  const unknown = ids.filter((id) => !catalog.byId.has(id))
  return {
    ids: normalizeModuleIds(ids, catalog),
    warnings: unknown.length ? [`模型返回了未定义模块，已忽略：${unknown.join(", ")}`] : [],
  }
}

/** 建立入库写入钩子；只有配置业务模块字典的项目启用，标签失败保留正文。 */
export async function createModuleTagWriter(
  projectPath: string, config: LlmConfig, signal?: AbortSignal,
  classificationPolicy: string = DEFAULT_INGEST_PROMPTS.classification,
  classificationTemplate: string = DEFAULT_INGEST_PROMPTS.classificationTemplate,
): Promise<ModuleTagWriter> {
  let catalog: ModuleCatalog | null
  let configurationWarning = ""
  try {
    const schema = await loadProjectSchema(projectPath, "classification")
    catalog = parseModuleCatalog(schema)
    if (!catalog && schema.trim()) throw new Error("业务模块文件缺少 Business Modules 或业务模块章节。")
  }
  catch (error) {
    configurationWarning = `业务模块配置无效，页面暂归未分类：${error instanceof Error ? error.message : String(error)}`
    catalog = parseModuleCatalog('## Business Modules\n```json\n{"version":1,"modules":[]}\n```')
  }
  if (!catalog) return unchangedWriter
  const enabledCatalog = catalog
  return Object.assign(async (content: string) => {
    signal?.throwIfAborted()
    let ids = [UNCLASSIFIED_ID]
    const warnings: string[] = configurationWarning ? [configurationWarning] : []
    if (!configurationWarning) {
      try {
        const result = await classifyPageModules(content, enabledCatalog, config, signal, classificationPolicy, classificationTemplate)
        ids = result.ids
        warnings.push(...result.warnings)
      } catch (error) {
        signal?.throwIfAborted()
        warnings.push(`模块分类失败，页面暂归未分类：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { content: replaceModuleTags(content, ids, enabledCatalog), warnings }
  }, { enabled: true })
}

/** 缓存命中也基于现有最终正文重分类，保留原正文和未改动源文档的缓存。 */
export async function refreshCachedModuleTags(
  projectPath: string, paths: readonly string[], config: LlmConfig,
  signal?: AbortSignal, onFileWritten?: (path: string) => void,
  classificationPolicy: string = DEFAULT_INGEST_PROMPTS.classification,
  classificationTemplate: string = DEFAULT_INGEST_PROMPTS.classificationTemplate,
  runCommit: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => withProjectLock(projectPath, operation),
  runId?: string,
): Promise<{ updated: number; warnings: string[] }> {
  const classify = await createModuleTagWriter(projectPath, config, signal, classificationPolicy, classificationTemplate)
  if (!classify.enabled) return { updated: 0, warnings: [] }
  const warnings: string[] = []
  let updated = 0
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  for (const originalPath of new Set(paths)) {
    signal?.throwIfAborted()
    const normalized = normalizePath(originalPath)
    const path = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
    if (!/^wiki\/.+\.md$/i.test(path) || path.split("/").some((part) => part === "." || part === "..")) continue
    if (["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(path.toLowerCase())) continue
    try {
      const fullPath = `${root}/${path}`
      const previous = await readFile(fullPath)
      const result = await classify(previous)
      warnings.push(...result.warnings.map((warning) => `${path}: ${warning}`))
      signal?.throwIfAborted()
      if (result.content === previous) continue
      await runCommit(async () => {
        signal?.throwIfAborted()
        await assertIngestSnapshotsUnchanged(root, new Map([[path, previous]]))
        if (runId) await commitIngestPage(projectPath, runId, path, previous, result.content, `maintenance-modules-${(await contentRevision(result.content)).slice(7)}`, "maintenance")
        else await writeFile(fullPath, result.content)
        updated++
        onFileWritten?.(path)
      })
    } catch (error) {
      signal?.throwIfAborted()
      warnings.push(`${path}: 模块标签更新失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { updated, warnings }
}
