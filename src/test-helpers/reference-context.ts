/** 原生关系索引的临时文件适配器；只模拟 IPC，引用改写、提交和审阅仍执行真实代码。 */
import { realFs, readFileRaw } from "./fs-temp"
import { parseFrontmatter } from "@/lib/frontmatter"
import type { ReferenceContext } from "@/lib/wiki-reference-maintenance"
import type { FileNode } from "@/types/wiki"

export async function referenceContextFromFiles(args: { projectPath: string; paths: string[]; targets: string[] }): Promise<ReferenceContext> {
  const files: FileNode[] = []
  const collect = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.is_dir) collect(node.children ?? [])
      else if (node.path.endsWith(".md")) files.push(node)
    }
  }
  collect(await realFs.listDirectory(`${args.projectPath}/wiki`))
  const pages: ReferenceContext["pages"] = []
  const affected = new Set(args.paths)
  const key = (value: string) => value.split("#")[0].replace(/^wiki\//, "").replace(/\.md$/, "")
  for (const file of files) {
    const text = await readFileRaw(file.path)
    const path = file.path.slice(args.projectPath.length + 1)
    const { frontmatter } = parseFrontmatter(text)
    pages.push({ path, names: [file.name.replace(/\.md$/, ""), String(frontmatter?.title ?? ""), ...Array.isArray(frontmatter?.aliases) ? frontmatter.aliases.map(String) : []] })
    const references = [...text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) => match[1]).concat(Array.isArray(frontmatter?.related) ? frontmatter.related.map(String) : [])
    if (references.some((reference) => args.targets.some((target) => key(reference) === key(target)))) affected.add(path)
  }
  return { pages, affectedPaths: [...affected], relations: [] }
}
