import { readFile, writeFile, fileExists } from "@/commands/fs"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"
import { isIngestKnowledgePath } from "./ingest-knowledge-path"

/**
 * SHA256-based ingest cache.
 * Stores hash of source file content → skips re-ingest if unchanged.
 * Cache file: .llm-wiki/ingest-cache.json
 */

interface CacheEntry {
  hash: string
  timestamp: number
  filesWritten: string[]
}

interface CacheData {
  entries: Record<string, CacheEntry> // keyed by source filename
}

/** 兼容历史绝对路径缓存，但只承认当前项目内的知识页。 */
function hasKnowledgePages(projectPath: string, files: string[]): boolean {
  const prefix = `${normalizePath(projectPath).replace(/\/+$/, "")}/`
  return files.some((file) => {
    const path = normalizePath(file)
    return isIngestKnowledgePath(isAbsolutePath(path) && path.startsWith(prefix) ? path.slice(prefix.length) : path)
  })
}

async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

function cachePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-cache.json`
}

async function loadCache(projectPath: string): Promise<CacheData> {
  try {
    const raw = await readFile(cachePath(projectPath))
    return JSON.parse(raw) as CacheData
  } catch {
    return { entries: {} }
  }
}

/** Source identities with a recorded successful ingest result. */
export async function listIngestedSourceIdentities(projectPath: string): Promise<string[]> {
  const cache = await loadCache(projectPath)
  return Object.keys(cache.entries).filter((source) => hasKnowledgePages(projectPath, cache.entries[source].filesWritten))
}

async function saveCache(projectPath: string, cache: CacheData): Promise<void> {
  try {
    await writeFile(cachePath(projectPath), JSON.stringify(cache, null, 2))
  } catch {
    // non-critical
  }
}

/**
 * Check if a source file has already been ingested with the same content.
 * Returns the list of previously written files if cached, or null if ingest
 * is needed.
 *
 * IMPORTANT: a cache hit is only returned if every previously-written file
 * still exists on disk. Otherwise we treat the cache as stale and fall
 * through to a full re-ingest. Historically we returned the cached list
 * blindly, which surfaced ghost entries in the activity panel — clicking
 * them gave the preview panel a missing file, and the auto-save path then
 * materialized a `[Binary file: ...]` stub at the now-empty location.
 */
export async function checkIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  contract: string = "",
): Promise<string[] | null> {
  const cache = await loadCache(projectPath)
  const entry = cache.entries[sourceFileName]
  if (!entry || !hasKnowledgePages(projectPath, entry.filesWritten)) return null

  const currentHash = await sha256(contract ? JSON.stringify([sourceContent, contract]) : sourceContent)
  if (entry.hash !== currentHash) return null

  const pp = normalizePath(projectPath)
  for (const filePath of entry.filesWritten) {
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${pp}/${filePath}`
    try {
      if (!(await fileExists(fullPath))) {
        console.log(
          `[ingest-cache] cache miss for ${sourceFileName}: ${filePath} no longer on disk`,
        )
        return null
      }
    } catch {
      // If the existence check itself fails, fall back to re-ingest —
      // safer than trusting a stale cache entry.
      return null
    }
  }

  return entry.filesWritten
}

/**
 * Save ingest result to cache after successful ingest.
 */
export async function saveIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  filesWritten: string[],
  contract: string = "",
): Promise<void> {
  const cache = await loadCache(projectPath)
  if (!hasKnowledgePages(projectPath, filesWritten)) {
    // 失败重跑也不能留下旧的日志成功缓存。
    if (cache.entries[sourceFileName]) {
      delete cache.entries[sourceFileName]
      await saveCache(projectPath, cache)
    }
    return
  }
  const hash = await sha256(contract ? JSON.stringify([sourceContent, contract]) : sourceContent)
  const newEntries = { ...cache.entries }
  newEntries[sourceFileName] = {
    hash,
    timestamp: Date.now(),
    filesWritten,
  }
  await saveCache(projectPath, { entries: newEntries })
}

/**
 * Remove a source file entry from cache (e.g., when source is deleted).
 */
export async function removeFromIngestCache(
  projectPath: string,
  sourceFileName: string,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const newEntries = { ...cache.entries }
  delete newEntries[sourceFileName]
  await saveCache(projectPath, { entries: newEntries })
}

/** Move a cache entry when an unchanged source is renamed inside raw/sources. */
export async function moveIngestCacheEntry(
  projectPath: string,
  oldSourceIdentity: string,
  newSourceIdentity: string,
  movedFiles: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const cache = await loadCache(projectPath)
  const entry = cache.entries[oldSourceIdentity]
  if (!entry || oldSourceIdentity === newSourceIdentity) return
  const migratedEntry: CacheEntry = {
    ...entry,
    filesWritten: entry.filesWritten.map((path) => movedFiles.get(path) ?? path),
  }
  const newEntries = { ...cache.entries, [newSourceIdentity]: migratedEntry }
  delete newEntries[oldSourceIdentity]
  await saveCache(projectPath, { entries: newEntries })
}
