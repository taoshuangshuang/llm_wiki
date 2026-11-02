import { fileExists, listDirectory } from "@/commands/fs"

/** 限制历史清单的并发文件调用，避免逐条 IPC 等待或一次提交全部长正文读取。 */
export async function readIngestHistory<T>(root: string, load: (id: string) => Promise<T>, validId: (id: string) => boolean = () => true): Promise<T[]> {
  if (!await fileExists(root)) return []
  const directories = (await listDirectory(root, { maxDepth: 1 })).filter((node) => node.is_dir && validId(node.name))
  const records: { index: number; value: T }[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, directories.length) }, async () => {
    while (cursor < directories.length) {
      const index = cursor++
      const directory = directories[index]
      if (await fileExists(`${directory.path}/manifest.json`)) records.push({ index, value: await load(directory.name) })
    }
  }))
  // 保留目录顺序，使上层按时间排序时，同一时间的记录仍稳定展示。
  return records.sort((a, b) => a.index - b.index).map(({ value }) => value)
}
