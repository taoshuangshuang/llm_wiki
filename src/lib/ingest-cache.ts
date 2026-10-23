import { readFile, writeFile, fileExists } from "@/commands/fs"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"
import type { IngestResult } from "./ingest-result"

/**
 * SHA256-based ingest cache.
 * Stores hash of source file content → skips re-ingest if unchanged.
 * Cache file: .llm-wiki/ingest-cache.json
 */

interface CacheEntry {
  hash: string
  timestamp: number
  filesWritten: string[]
  result?: IngestResult
  pageHashes?: Record<string, string>
}

interface CacheData {
  entries: Record<string, CacheEntry> // keyed by source filename
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
  return Object.keys(cache.entries)
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
  if (!entry) return null

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

  for (const [path, expected] of Object.entries(entry.pageHashes ?? {})) {
    try {
      if (!path.startsWith("wiki/") || path.split("/").some((part) => part === ".." || part === ".") || path.includes("\\")) return null
      if (await sha256(await readFile(`${pp}/${path}`)) !== expected) return null
    } catch { return null }
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
  result?: IngestResult,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const hash = await sha256(contract ? JSON.stringify([sourceContent, contract]) : sourceContent)
  const newEntries = { ...cache.entries }
  const pageHashes: Record<string, string> = {}
  if (result) {
    for (const path of result.coveredPaths) pageHashes[path] = await sha256(await readFile(`${normalizePath(projectPath)}/${path}`))
  }
  newEntries[sourceFileName] = {
    hash,
    timestamp: Date.now(),
    filesWritten,
    ...(result ? { result, pageHashes } : {}),
  }
  await saveCache(projectPath, { entries: newEntries })
}

/** 仅在 checkIngestCache 已验证有效后读取完成结果，兼容旧文件清单调用方。 */
export async function cachedIngestResult(projectPath: string, sourceIdentity: string): Promise<IngestResult | undefined> {
  return (await loadCache(projectPath)).entries[sourceIdentity]?.result
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
    ...(entry.result ? { result: {
      ...entry.result,
      writtenPaths: entry.result.writtenPaths.map((path) => movedFiles.get(path) ?? path),
      coveredPaths: entry.result.coveredPaths.map((path) => movedFiles.get(path) ?? path),
    } } : {}),
    // sources 字段迁移会改变正文哈希，下次入库重新核对关联页。
    ...(entry.pageHashes ? { pageHashes: Object.fromEntries(Object.entries(entry.pageHashes).map(([path, hash]) => [movedFiles.get(path) ?? path, hash])) } : {}),
  }
  const newEntries = { ...cache.entries, [newSourceIdentity]: migratedEntry }
  delete newEntries[oldSourceIdentity]
  await saveCache(projectPath, { entries: newEntries })
}
