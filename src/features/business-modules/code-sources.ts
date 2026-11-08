/** 模块直接绑定本机仓库，代码范围以仓库相对目录保存。 */
import { fileExists, listDirectory } from "@/commands/fs"
import { getFileName, isAbsolutePath, normalizePath } from "@/lib/path-utils"

export interface ModuleCodeBinding {
  /** 未设置时继承父模块，null 表示停止继承。 */
  repository?: string | null
  /** 未设置时继承范围，空数组表示整个仓库。 */
  paths?: string[]
  /** 记录选择代码范围时的仓库，防止祖先更换仓库后误用旧路径。 */
  pathsRepository?: string
}
export interface CodeSourcesConfig {
  version: 1
  moduleBindings: Record<string, ModuleCodeBinding>
}
export interface CodeDirectory { path: string; label: string; kind: "module" | "package" | "directory" }

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function validRelativePath(path: string): boolean {
  return !!path && !isAbsolutePath(path) && !/[\\:\x00-\x1f]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

export function readCodeSourcesConfig(content: string): CodeSourcesConfig {
  if (!content.trim()) return { version: 1, moduleBindings: {} }
  const value: unknown = JSON.parse(content)
  if (!isObject(value) || value.version !== 1 || !isObject(value.moduleBindings)) {
    throw new Error("源码绑定配置需包含 version: 1 和 moduleBindings。")
  }
  for (const [id, binding] of Object.entries(value.moduleBindings)) {
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id) || !isObject(binding)) throw new Error("模块源码绑定格式无效。")
    if (binding.repository !== undefined && binding.repository !== null
      && (typeof binding.repository !== "string" || !isAbsolutePath(binding.repository) || /[\x00-\x1f]/.test(binding.repository))) {
      throw new Error("仓库需使用本机绝对路径。")
    }
    if (binding.paths !== undefined && (!Array.isArray(binding.paths)
      || binding.paths.some((path) => typeof path !== "string" || !validRelativePath(path))
      || new Set(binding.paths).size !== binding.paths.length)) throw new Error("代码范围需为不重复的仓库相对目录。")
    if (binding.repository === null && Array.isArray(binding.paths) && binding.paths.length) throw new Error("停用源码绑定时不能设置代码范围。")
    if (binding.pathsRepository !== undefined && (typeof binding.pathsRepository !== "string"
      || !isAbsolutePath(binding.pathsRepository))) throw new Error("代码范围的来源仓库无效。")
  }
  return value as unknown as CodeSourcesConfig
}

/** 从根到当前节点依次覆盖；切换仓库时重新开始确定代码范围。 */
export function resolveCodeBinding(config: CodeSourcesConfig, moduleId: string, ancestors: readonly string[]) {
  let repository: string | undefined
  let repositorySource: string | undefined
  let paths: string[] = []
  let pathsSource: string | undefined
  for (const id of [...ancestors, moduleId]) {
    if (!Object.prototype.hasOwnProperty.call(config.moduleBindings, id)) continue
    const binding = config.moduleBindings[id]
    if (binding.repository !== undefined) {
      repository = binding.repository ?? undefined
      repositorySource = id
      paths = []
      pathsSource = id
    }
    if (repository && binding.paths !== undefined && (!binding.pathsRepository || binding.pathsRepository === repository)) {
      paths = binding.paths; pathsSource = id
    }
  }
  return { repository, repositorySource, paths, pathsSource }
}

export function codeLocation(repository: string, relativePath = ""): string {
  if (relativePath && !validRelativePath(relativePath)) throw new Error("代码目录超出仓库范围。")
  const trimmed = normalizePath(repository).replace(/\/+$/, "")
  const root = /^[a-z]:$/i.test(trimmed) ? trimmed + "/" : trimmed || "/"
  return root + (relativePath ? (root.endsWith("/") ? "" : "/") + relativePath : "")
}

export function hasGitMarker(repository: string): Promise<boolean> {
  return fileExists(codeLocation(repository).replace(/\/+$/, "") + "/.git")
}

/** 检测现有索引，支持复用父目录的聚合 CodeGraph。 */
export async function findCodeGraphRoot(repository: string): Promise<string | undefined> {
  let directory = codeLocation(repository)
  while (isAbsolutePath(directory)) {
    if (await fileExists(directory.replace(/\/+$/, "") + "/.codegraph/codegraph.db")) return directory
    const parentPath = directory.slice(0, directory.lastIndexOf("/")) || "/"
    const parent = /^[a-z]:$/i.test(parentPath) ? parentPath + "/" : parentPath
    if (parent === directory) return
    directory = parent
  }
}

/** 按源码目录约定显示 Java 包名，同时保留完整相对路径用于定位。 */
export function codeDirectoryLabel(path: string): string {
  const javaPackage = path.match(/(?:^|\/)src\/(?:main|test)\/java\/(.+)$/)?.[1]
  return javaPackage ? javaPackage.replace(/\//g, ".") : getFileName(path)
}

const EXCLUDED_DIRECTORIES = new Set(["target", "node_modules", "dist", "build", "vendor"])

export async function listCodeDirectories(repository: string, relativePath = ""): Promise<CodeDirectory[]> {
  const root = codeLocation(repository)
  const entries = await listDirectory(codeLocation(root, relativePath), { maxDepth: 1 })
  const result: CodeDirectory[] = []
  for (const entry of entries) {
    const path = normalizePath(entry.path)
    const prefix = root.endsWith("/") ? root : root + "/"
    if (!entry.is_dir || entry.name.startsWith(".") || EXCLUDED_DIRECTORIES.has(entry.name) || !path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    const kind = await fileExists(codeLocation(root, relative) + "/pom.xml") ? "module"
      : /(?:^|\/)src\/(?:main|test)\/java(?:\/|$)/.test(relative) ? "package" : "directory"
    result.push({ path: relative, label: codeDirectoryLabel(relative), kind })
  }
  return result
}

/** 搜索目录名和包名，达到扫描上限时明确返回部分结果。 */
export async function searchCodeDirectories(repository: string, query: string, signal: AbortSignal) {
  const queue = [""]
  const seen = new Set<string>()
  const matches = new Map<string, CodeDirectory>()
  const failures: string[] = []
  let truncated = false
  const term = query.trim().toLowerCase()
  while (queue.length && seen.size < 1500) {
    signal.throwIfAborted()
    const batch = queue.splice(0, Math.min(8, 1500 - seen.size))
    const results = await Promise.allSettled(batch.map((path) => listCodeDirectories(repository, path)))
    signal.throwIfAborted()
    for (const [index, result] of results.entries()) {
      seen.add(batch[index])
      if (result.status === "rejected") { failures.push(batch[index] || "仓库根目录"); continue }
      for (const directory of result.value) {
        if (directory.label.toLowerCase().includes(term) || directory.path.toLowerCase().includes(term)) matches.set(directory.path, directory)
        if (directory.path.split("/").length >= 30) truncated = true
        else if (!seen.has(directory.path)) queue.push(directory.path)
      }
    }
  }
  return { directories: [...matches.values()], complete: !queue.length && !failures.length && !truncated }
}
