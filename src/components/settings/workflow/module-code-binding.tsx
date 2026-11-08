/** 在业务模块详情中直接选择仓库，显示继承来源及实际代码范围。 */
import { useEffect, useRef, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { Button } from "@/components/ui/button"
import { normalizePath } from "@/lib/path-utils"
import {
  codeDirectoryLabel, findCodeGraphRoot, hasGitMarker, resolveCodeBinding,
  type CodeSourcesConfig, type ModuleCodeBinding,
} from "@/features/business-modules/code-sources"
import { CodeScopePicker } from "./code-scope-picker"

export function ModuleCodeBindingEditor({ config, moduleId, ancestors, moduleNames, busy, onChange }: {
  config: CodeSourcesConfig; moduleId: string; ancestors: string[]; moduleNames: Map<string, string>
  busy: boolean; onChange: (config: CodeSourcesConfig) => void
}) {
  const effective = resolveCodeBinding(config, moduleId, ancestors)
  const own = Object.prototype.hasOwnProperty.call(config.moduleBindings, moduleId) ? config.moduleBindings[moduleId] : undefined
  const [choosing, setChoosing] = useState(false)
  const [pickingScope, setPickingScope] = useState(false)
  const [error, setError] = useState("")
  const [index, setIndex] = useState("")
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  useEffect(() => {
    let stopped = false
    setPickingScope(false)
    setIndex("")
    if (effective.repository) {
      const repository = effective.repository
      setIndex("正在检测仓库与索引…")
      void (async () => {
        if (!await hasGitMarker(repository)) throw new Error("仓库目录或 Git 标记不可用，请重新选择。")
        const indexRoot = await findCodeGraphRoot(repository)
        if (!stopped) setIndex(indexRoot ? "CodeGraph 索引 · " + indexRoot : "当前未发现 CodeGraph 索引")
      })().catch((failure) => { if (!stopped) setIndex(String(failure)) })
    }
    return () => { stopped = true }
  }, [effective.repository])

  function update(binding: ModuleCodeBinding | undefined) {
    const bindings = { ...config.moduleBindings }
    if (binding === undefined) delete bindings[moduleId]
    else bindings[moduleId] = binding
    onChange({ ...config, moduleBindings: bindings })
    setError("")
  }
  async function chooseRepository() {
    setChoosing(true); setError("")
    try {
      const path = await open({ directory: true, multiple: false, title: "选择源码仓库目录" })
      if (!active.current || typeof path !== "string") return
      if (!await hasGitMarker(path)) throw new Error("请选择包含 .git 标记的仓库根目录。")
      if (active.current) update({ repository: normalizePath(path), paths: [] })
    } catch (failure) {
      if (active.current) setError(String(failure))
    } finally {
      if (active.current) setChoosing(false)
    }
  }
  const sourceName = (id: string | undefined) => id ? moduleNames.get(id) ?? id : ""
  return <fieldset disabled={busy || choosing} className="min-w-0 space-y-2" aria-label="模块源码绑定">
    <legend className="mb-2">关联源码</legend>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <p className="break-all">{effective.repository ?? "尚未绑定仓库"}</p>
    {effective.repository && <p className="text-muted-foreground">
      {effective.repositorySource === moduleId ? "当前模块直接绑定" : "继承自 " + sourceName(effective.repositorySource)}
    </p>}
    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto">
      <Button size="sm" variant="outline" onClick={() => void chooseRepository()}>{effective.repository ? "更换仓库" : "绑定仓库"}</Button>
      {own && <Button size="sm" variant="ghost" onClick={() => update(undefined)}>恢复继承</Button>}
      {effective.repository && <Button size="sm" variant="ghost" onClick={() => update({ repository: null })}>解除绑定</Button>}
    </div>
    {effective.repository && <>
      <p className="break-all text-muted-foreground">{index}</p>
      <div className="space-y-1">
        <p>代码范围{effective.pathsSource !== moduleId && effective.pathsSource ? " · 继承自 " + sourceName(effective.pathsSource) : ""}</p>
        {effective.paths.length ? <ul className="space-y-1">{effective.paths.map((path) =>
          <li key={path} title={path} className="break-all">{codeDirectoryLabel(path)}<span className="block text-muted-foreground">{path}</span></li>)}</ul>
          : <p className="text-muted-foreground">整个仓库</p>}
      </div>
      {pickingScope ? <CodeScopePicker repository={effective.repository} paths={effective.paths}
        onApply={(paths) => { update({ ...own, paths, pathsRepository: effective.repository }); setPickingScope(false) }} onCancel={() => setPickingScope(false)} />
        : <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setPickingScope(true)}>选择模块或包</Button>
          {own?.paths !== undefined && <Button size="sm" variant="ghost" onClick={() => {
            const { paths: _paths, pathsRepository: _repository, ...rest } = own
            update(Object.keys(rest).length ? rest : undefined)
          }}>{own.repository !== undefined ? "使用整个仓库" : "沿用父模块范围"}</Button>}
        </div>}
      {own?.pathsRepository && own.pathsRepository !== effective.repository && <p role="status" className="text-muted-foreground">仓库已变化，原先选择的代码范围需重新确认。</p>}
    </>}
  </fieldset>
}
