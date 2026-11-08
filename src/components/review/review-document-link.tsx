import { useState } from "react"
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

/** 将审阅中的项目文档路径打开为预览，保留返回审阅页的入口。 */
export function ReviewDocumentLink({ path }: { path: string }) {
  const project = useWikiStore((state) => state.project)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  async function openDocument() {
    if (!project || loading) return
    const root = normalizePath(project.path).replace(/\/$/, "")
    const relative = normalizePath(path).replace(/^\.\//, "")
    const target = relative.startsWith(`${root}/`) ? relative : `${root}/${relative.startsWith("wiki/") ? relative : `wiki/${relative}`}`
    setLoading(true)
    setError(false)
    try {
      const content = await readFile(target)
      // 切换项目后，不能把原项目的异步读取结果打开到新项目中。
      if (useWikiStore.getState().project?.path === project.path) {
        useWikiStore.getState().openFileInPreview(target, content)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  return <span className="inline-flex max-w-full flex-wrap items-baseline gap-1">
    <button type="button" disabled={!project || loading} onClick={openDocument}
      className="break-all text-left text-primary underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
      title={`打开文档：${path}`}>{path}</button>
    {error && <span role="alert" className="text-destructive">无法打开文档，文件可能已移动或删除</span>}
  </span>
}
