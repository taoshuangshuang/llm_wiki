/** 来源配图可被多个知识页引用；无法确认未使用时保留资源。 */
import { listDirectory, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export async function isSourceMediaReferenced(projectPath: string, sourceSlug: string): Promise<boolean> {
  const root = `${normalizePath(projectPath).replace(/\/+$/, "")}/wiki`
  const directories = [root]
  const visited = new Set<string>()
  const reference = `media/${sourceSlug}/`
  try {
    for (let index = 0; index < directories.length; index++) {
      const directory = directories[index]
      if (visited.has(directory)) continue
      if (visited.size >= 10_000) return true
      visited.add(directory)
      for (const node of await listDirectory(directory, { maxDepth: 1 })) {
        const path = normalizePath(node.path)
        if (!path.startsWith(`${root}/`)) continue
        if (node.is_dir) { directories.push(path); continue }
        if (!/\.md$/i.test(node.name)) continue
        const content = await readFile(path)
        if (content.includes(reference) || content.includes(encodeURI(reference))) return true
      }
    }
  } catch { return true }
  return false
}
