/**
 * Real-filesystem adapter for @/commands/fs. Tests that want to exercise
 * the actual JSON / path round-trip (rather than a vi.mock memory stub)
 * should call `installRealFs()` then use a per-test temp directory via
 * `createTempProject()`.
 *
 * The Tauri fs commands are replaced with implementations backed by
 * node:fs/promises, operating on whatever path the caller passes. The
 * caller is responsible for using a temp-dir root to prevent tests from
 * touching each other's state.
 */
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import type { FileNode } from "@/types/wiki"
import { normalizeReviewItems, type ReviewItem } from "@/stores/review-store"

async function buildTree(dir: string): Promise<FileNode[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: FileNode[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name).replace(/\\/g, "/")
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: full,
        is_dir: true,
        children: await buildTree(full),
      } as FileNode)
    } else {
      nodes.push({
        name: entry.name,
        path: full,
        is_dir: false,
        children: [],
      } as FileNode)
    }
  }
  return nodes
}

/**
 * Implementations of the @/commands/fs API backed by node:fs.
 * Import this from a test file that calls `vi.mock("@/commands/fs", ...)`.
 */
export const realFs = {
  appendIngestLog: async (projectPath: string, sourceIdentity: string, entry: unknown): Promise<void> => {
    const target = `${projectPath}/.llm-wiki/ingest-logs/${createHash("sha256").update(sourceIdentity).digest("hex")}.jsonl`
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.appendFile(target, JSON.stringify(entry) + "\n", "utf-8")
  },
  readIngestLog: async (projectPath: string, sourceIdentity: string): Promise<string> => {
    const target = `${projectPath}/.llm-wiki/ingest-logs/${createHash("sha256").update(sourceIdentity).digest("hex")}.jsonl`
    return fs.readFile(target, "utf-8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
  },
  readFile: async (p: string): Promise<string> => {
    return fs.readFile(p, "utf-8")
  },
  writeFile: async (p: string, contents: string): Promise<void> => {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, contents, "utf-8")
  },
  writeFileAtomic: async (p: string, contents: string): Promise<void> => {
    await fs.mkdir(path.dirname(p), { recursive: true })
    const temporary = `${p}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, contents, "utf-8")
    await fs.rename(temporary, p)
  },
  saveWorkflowFile: async (projectPath: string, relativePath: string, expected: string | null, contents: string): Promise<void> => {
    await realFs.compareAndWriteFile(projectPath, relativePath, expected, contents)
  },
  compareAndWriteFile: async (projectPath: string, relativePath: string, expected: string | null, contents: string): Promise<void> => {
    const target = `${projectPath}/${relativePath}`
    const current = await fs.readFile(target, "utf-8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (current !== expected) throw new Error("INGEST_VERSION_CONFLICT: 页面已变化")
    await realFs.writeFileAtomic(target, contents)
  },
  mergeReviewItems: async (projectPath: string, items: ReviewItem[]): Promise<ReviewItem[]> => {
    const target = `${projectPath}/.llm-wiki/review.json`
    const existing = await fs.readFile(target, "utf-8").then((raw) => JSON.parse(raw) as ReviewItem[]).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const result = normalizeReviewItems([...existing, ...items])
    await realFs.writeFileAtomic(target, JSON.stringify(result, null, 2))
    return result
  },
  listDirectory: async (p: string): Promise<FileNode[]> => {
    return buildTree(p)
  },
  copyFile: async (source: string, destination: string): Promise<void> => {
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
  },
  preprocessFile: async (p: string): Promise<string> => {
    return fs.readFile(p, "utf-8")
  },
  deleteFile: async (p: string): Promise<void> => {
    await fs.unlink(p).catch(() => {})
  },
  fileExists: async (p: string): Promise<boolean> => {
    return fs.access(p).then(
      () => true,
      () => false,
    )
  },
  getFileModifiedTime: async (p: string): Promise<number> => {
    return (await fs.stat(p)).mtimeMs
  },
  getFileSize: async (p: string): Promise<number> => {
    return (await fs.stat(p)).size
  },
  getFileMd5: async (p: string): Promise<string> => createHash("md5").update(await fs.readFile(p)).digest("hex"),
  findRelatedWikiPages: async (): Promise<string[]> => {
    return []
  },
  createDirectory: async (p: string): Promise<void> => {
    await fs.mkdir(p, { recursive: true })
  },
  createProject: async () => {
    throw new Error("createProject not supported in tests")
  },
  openProject: async () => {
    throw new Error("openProject not supported in tests")
  },
  clipServerStatus: async (): Promise<string> => "ok",
}

/**
 * Create a fresh unique temp directory for a single test. Returns the
 * absolute path (with forward slashes) and a cleanup function.
 */
export async function createTempProject(label: string = "proj"): Promise<{
  path: string
  cleanup: () => Promise<void>
}> {
  const prefix = path.join(os.tmpdir(), `llmwiki-${label}-`)
  const dir = await fs.mkdtemp(prefix)
  const normalized = dir.replace(/\\/g, "/")
  return {
    path: normalized,
    cleanup: async () => {
      await fs.rm(normalized, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** Read a file directly (bypasses the mocked API) — used in assertions. */
export async function readFileRaw(p: string): Promise<string> {
  return fs.readFile(p, "utf-8")
}

/** Write a file directly (bypasses the mocked API) — used in fixture setup. */
export async function writeFileRaw(p: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, contents, "utf-8")
}

/** Check if a file exists on disk. */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
