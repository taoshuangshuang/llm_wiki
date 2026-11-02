/** 入库乐观校验：模型等待期间不占项目锁，提交前核对实际消费过的文件快照。 */
import { fileExists, getFileMd5, readFile } from "@/commands/fs"

/** 版本冲突必须交给队列重试，不能被可选摘要等尽力处理分支吞掉。 */
export class IngestVersionConflictError extends Error {}

/** 区分不存在与空文件；已有文件读取失败必须报错，不能当成新建覆盖。 */
export async function readIngestFileSnapshot(path: string): Promise<string | null> {
  return await fileExists(path) ? readFile(path) : null
}

/** 原始来源可能是 PDF 等二进制文件，比较实际字节指纹，避免同大小、同时间戳漏检。 */
export async function ingestSourceVersion(path: string): Promise<string> {
  return getFileMd5(path)
}

/** 必须在项目提交锁内调用；候选页和最终目标均按完整正文校验。 */
export async function assertIngestSnapshotsUnchanged(
  projectPath: string,
  snapshots: ReadonlyMap<string, string | null>,
): Promise<void> {
  for (const [path, expected] of snapshots) {
    if (await readIngestFileSnapshot(`${projectPath}/${path}`) !== expected) {
      throw new IngestVersionConflictError(`页面在模型处理期间已变化，保留当前版本并重试入库：${path}`)
    }
  }
}
