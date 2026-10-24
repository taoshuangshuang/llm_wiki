import { parseFrontmatter } from "./frontmatter"
import type { SourceWatchConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { clampUserConcurrency } from "@/lib/concurrency-limits"
import sourceWatchDefaults from "@/lib/source-watch-defaults.json"

export const DEFAULT_SOURCE_WATCH_CONFIG: SourceWatchConfig = sourceWatchDefaults

export const SOURCE_WATCH_FILE_TYPE_GROUPS = [
  {
    id: "documents",
    extensions: ["md", "mdx", "txt", "org", "pdf", "doc", "docx", "docm", "odt", "rtf", "epub", "mobi"],
  },
  {
    id: "presentations",
    extensions: ["ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm", "odp"],
  },
  {
    id: "spreadsheets",
    extensions: ["xls", "xlsx", "xlsm", "xlsb", "ods", "csv"],
  },
  {
    id: "web",
    extensions: ["html", "htm"],
  },
  {
    id: "data",
    extensions: ["json", "yaml", "yml", "xml"],
  },
  {
    id: "images",
    extensions: ["png", "jpg", "jpeg"],
  },
]

const SOURCE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"] as const
const LEGACY_DEFAULT_INCLUDE_EXTENSIONS = sourceWatchDefaults.includeExtensions.filter(
  (extension) => !SOURCE_IMAGE_EXTENSIONS.includes(extension as typeof SOURCE_IMAGE_EXTENSIONS[number]),
)

function normalizeExtensions(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .flatMap((value) => value.split(/[,，\n]/))
    .map((value) => value.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean))]
}

function normalizeList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .flatMap((value) => value.split(/[,，\n]/))
    .map((value) => value.trim())
    .filter(Boolean))]
}

export function normalizeSourceWatchConfig(config?: Partial<SourceWatchConfig> | null): SourceWatchConfig {
  const rawParsingConcurrency = config?.parsingConcurrency
    ?? DEFAULT_SOURCE_WATCH_CONFIG.parsingConcurrency
  const parsingConcurrency = Number.isFinite(rawParsingConcurrency)
    ? clampUserConcurrency(rawParsingConcurrency)
    : DEFAULT_SOURCE_WATCH_CONFIG.parsingConcurrency
  const rawIngestConcurrency = config?.ingestConcurrency
    ?? DEFAULT_SOURCE_WATCH_CONFIG.ingestConcurrency
  const ingestConcurrency = Number.isFinite(rawIngestConcurrency)
    ? clampUserConcurrency(rawIngestConcurrency)
    : DEFAULT_SOURCE_WATCH_CONFIG.ingestConcurrency
  const includeExtensions = normalizeExtensions(
    config?.includeExtensions ?? DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions,
  )
  const usesLegacyDefaults = includeExtensions.length === LEGACY_DEFAULT_INCLUDE_EXTENSIONS.length
    && LEGACY_DEFAULT_INCLUDE_EXTENSIONS.every((extension) => includeExtensions.includes(extension))
  return {
    enabled: config?.enabled ?? DEFAULT_SOURCE_WATCH_CONFIG.enabled,
    autoIngest: config?.autoIngest ?? DEFAULT_SOURCE_WATCH_CONFIG.autoIngest,
    generateSourceSummary: config?.generateSourceSummary === true,
    persistExtractedMarkdown:
      config?.persistExtractedMarkdown ?? DEFAULT_SOURCE_WATCH_CONFIG.persistExtractedMarkdown,
    parsingConcurrency,
    ingestConcurrency,
    includeExtensions: usesLegacyDefaults
      ? [...includeExtensions, ...SOURCE_IMAGE_EXTENSIONS]
      : includeExtensions,
    excludeExtensions: normalizeExtensions(config?.excludeExtensions ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeExtensions),
    excludeDirs: normalizeList(config?.excludeDirs ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeDirs),
    excludeGlobs: normalizeList(config?.excludeGlobs ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeGlobs),
    excludedTitleKeywords: normalizeList(config?.excludedTitleKeywords ?? []),
    maxFileSizeMb: Math.max(1, Math.min(4096, config?.maxFileSizeMb ?? DEFAULT_SOURCE_WATCH_CONFIG.maxFileSizeMb)),
  }
}

export function getSourceWatchExtension(path: string): string {
  const name = normalizePath(path).split("/").pop() ?? ""
  if (!name || !name.includes(".")) return ""
  return name.split(".").pop()?.toLowerCase() ?? ""
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i")
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalized = normalizePath(path)
  const name = normalized.split("/").pop() ?? normalized
  const re = wildcardToRegExp(pattern)
  return re.test(name) || re.test(normalized)
}

function pathMatchesExcludedDir(path: string, excludedDir: string): boolean {
  const normalized = normalizePath(path).toLowerCase()
  const dir = normalizePath(excludedDir).toLowerCase()
  if (!dir) return false
  if (dir.includes("/")) {
    return normalized === dir || normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`)
  }
  return normalized.split("/").some((part) => part === dir)
}

export function isPathAllowedBySourceWatch(path: string, config: SourceWatchConfig): boolean {
  const cfg = normalizeSourceWatchConfig(config)
  const normalized = normalizePath(path)
  const parts = normalized.split("/").filter(Boolean)
  if (cfg.excludeDirs.some((dir) => pathMatchesExcludedDir(normalized, dir))) return false
  if (cfg.excludeGlobs.some((pattern) => matchesGlob(normalized, pattern))) return false
  const name = parts[parts.length - 1] ?? ""
  if (!name || name.startsWith(".")) return false
  const ext = getSourceWatchExtension(normalized)
  if (ext && cfg.excludeExtensions.includes(ext)) return false
  if (cfg.includeExtensions.length > 0 && (!ext || !cfg.includeExtensions.includes(ext))) {
    return false
  }
  return true
}

/** 只匹配文件名和文档主标题，不将目录、正文或子章节当作整篇资料的排除依据。 */
export function excludedSourceTitleKeyword(path: string, content: string, keywords: readonly string[] = []): string | undefined {
  const fileTitle = (normalizePath(path).split("/").pop() ?? "").replace(/\.[^.]+$/, "")
  const { frontmatter, body } = parseFrontmatter(content.replace(/^\uFEFF/, ""))
  const lines = body.split(/\r?\n/)
  let fence: string | undefined
  let title = ""
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined
      continue
    }
    if (fence) continue
    const heading = line.match(/^ {0,3}#\s+(.+?)\s*#*\s*$/)
    if (heading) { title = heading[1]; break }
  }
  const titles = [fileTitle, String(frontmatter?.title ?? ""), title].map((value) => value.normalize("NFKC").toLowerCase())
  return keywords.map((word) => word.trim()).find((word) => word && titles.some((value) => value.includes(word.normalize("NFKC").toLowerCase())))
}
