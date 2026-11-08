/** 通过目录树或包名搜索选择仓库内的代码范围。 */
import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { listCodeDirectories, searchCodeDirectories, type CodeDirectory } from "@/features/business-modules/code-sources"

interface SelectionProps {
  repository: string
  selected: string[]
  onToggle: (path: string) => void
}

export function CodeScopePicker({ repository, paths, onApply, onCancel }: {
  repository: string; paths: string[]; onApply: (paths: string[]) => void; onCancel: () => void
}) {
  const [selected, setSelected] = useState(paths)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<{ directories: CodeDirectory[]; complete: boolean }>()
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState("")
  const searchController = useRef<AbortController | null>(null)
  useEffect(() => () => searchController.current?.abort(), [])
  function toggle(path: string) {
    setSelected((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path])
  }
  async function search() {
    searchController.current?.abort()
    if (!query.trim()) { setResults(undefined); setSearching(false); return }
    const controller = new AbortController()
    searchController.current = controller
    setSearching(true); setError(""); setResults(undefined)
    try {
      const result = await searchCodeDirectories(repository, query, controller.signal)
      if (!controller.signal.aborted) setResults(result)
    } catch (failure) {
      if (!controller.signal.aborted) setError(String(failure))
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }
  }
  const selection = { repository, selected, onToggle: toggle }
  return <section aria-label="代码范围选择" className="space-y-2">
    <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void search() }}>
      <Input aria-label="搜索模块或包" placeholder="输入模块名、Java 包名或目录" className="h-7 text-xs md:text-xs"
        value={query} onChange={(event) => setQuery(event.target.value)} />
      <Button type="submit" size="sm" variant="outline">搜索</Button>
    </form>
    {!!selected.length && <div className="flex flex-wrap gap-1" aria-label="已选代码范围">
      {selected.map((path) => <button type="button" key={path} title={path} aria-label={"移除范围 " + path}
        className="max-w-full truncate rounded bg-muted px-2 py-1" onClick={() => toggle(path)}>{path} ×</button>)}
    </div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {searching ? <div className="flex items-center gap-2"><p role="status">正在搜索代码目录…</p>
      <Button size="sm" variant="ghost" onClick={() => { searchController.current?.abort(); setSearching(false) }}>停止搜索</Button>
    </div> : <div className="max-h-64 overflow-y-auto" aria-label="源码目录树">
      {results ? <>
        {!results.complete && <p role="status" className="text-muted-foreground">部分目录未扫描完成，以下是已找到的结果。</p>}
        {!results.directories.length && <p>未找到匹配目录。</p>}
        {results.directories.map((directory) => <ScopeRow key={directory.path} directory={directory} {...selection} />)}
      </> : <ScopeChildren path="" {...selection} />}
    </div>}
    <p className="text-muted-foreground">勾选 Maven 模块或 Java 包目录。空选表示整个仓库。</p>
    <div className="flex gap-2">
      <Button size="sm" onClick={() => onApply(selected)}>应用代码范围</Button>
      <Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
    </div>
  </section>
}

function ScopeChildren({ path, ...selection }: SelectionProps & { path: string }) {
  const [directories, setDirectories] = useState<CodeDirectory[]>()
  const [error, setError] = useState("")
  useEffect(() => {
    let stopped = false
    void listCodeDirectories(selection.repository, path).then((result) => {
      if (!stopped) setDirectories(result)
    }).catch((failure) => { if (!stopped) setError(String(failure)) })
    return () => { stopped = true }
  }, [selection.repository, path])
  if (error) return <p role="alert" className="text-destructive">{error}</p>
  if (!directories) return <p role="status" className="text-muted-foreground">正在读取目录…</p>
  if (!directories.length) return <p className="text-muted-foreground">没有子目录。</p>
  return <>{directories.map((directory) => <ScopeRow key={directory.path} directory={directory} {...selection} />)}</>
}

function ScopeRow({ directory, ...selection }: SelectionProps & { directory: CodeDirectory }) {
  const [expanded, setExpanded] = useState(false)
  return <div>
    <div className="flex items-center gap-1 py-0.5">
      <button type="button" className="shrink-0 rounded p-1 hover:bg-accent" aria-expanded={expanded}
        aria-label={(expanded ? "收起目录 " : "展开目录 ") + directory.path} onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <label className="flex min-w-0 flex-1 items-center gap-2" title={directory.path}>
        <input type="checkbox" aria-label={"选择范围 " + directory.path} checked={selection.selected.includes(directory.path)}
          onChange={() => selection.onToggle(directory.path)} />
        <span className="truncate">{directory.label}</span>
        {directory.kind !== "directory" && <span className="shrink-0 text-muted-foreground">{directory.kind === "module" ? "Maven 模块" : "Java 包"}</span>}
      </label>
    </div>
    {expanded && <div className="pl-4"><ScopeChildren path={directory.path} {...selection} /></div>}
  </div>
}
