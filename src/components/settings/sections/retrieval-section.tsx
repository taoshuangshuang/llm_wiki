/** 各入口共用的检索开关；全局默认与项目覆盖由后端同一解析器处理。 */
import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useWikiStore } from "@/stores/wiki-store"
import type { RetrievalChannel } from "@/lib/evidence-retrieval"

type Channels = Record<RetrievalChannel, boolean>
interface Config { defaults: Channels; overrides: Partial<Channels>; effective: Channels }
const LABELS: Record<RetrievalChannel, string> = { title: "页面标题相似召回", vector: "向量检索", keyword: "关键词检索", indexPage: "索引页检索", graph: "图关系扩展" }

export function RetrievalSection() {
  const project = useWikiStore((state) => state.project)
  const [config, setConfig] = useState<Config>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let stopped = false
    setConfig(undefined)
    invoke<Config>("retrieval_config", { projectPath: project?.path ?? null }).then((value) => { if (!stopped) setConfig(value) }).catch((failure) => { if (!stopped) setError(String(failure)) })
    return () => { stopped = true }
  }, [project?.path])
  async function save(scope: "global" | "project", channels: Partial<Channels>) {
    setBusy(true)
    try {
      await invoke("save_retrieval_config", { projectPath: scope === "project" ? project?.path : null, channels })
      const latest = await invoke<Config>("retrieval_config", { projectPath: project?.path ?? null })
      if (useWikiStore.getState().project?.path === project?.path) { setConfig(latest); setError("") }
    } catch (failure) { if (useWikiStore.getState().project?.path === project?.path) setError(String(failure)) }
    finally { if (useWikiStore.getState().project?.path === project?.path) setBusy(false) }
  }
  return <section className="mt-6 space-y-3 rounded-lg border p-4">
    <h3 className="text-sm font-medium">统一知识检索</h3>
    <p className="text-xs text-muted-foreground">入库、后台审阅、问答和搜索遵守同一有效设置。失败降级不会启用已关闭的通道。向量能力同时受 Embedding 设置影响。</p>
    <p className="text-xs text-muted-foreground">标题相似召回用于入库和后台审阅，候选与正文检索合并后再核对，不因标题相近直接合并页面。</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {config && <table className="w-full text-left text-xs"><thead><tr><th className="pb-2">通道</th><th>全局默认</th>{project && <th>当前项目覆盖</th>}<th>当前有效值</th></tr></thead><tbody>{(Object.keys(LABELS) as RetrievalChannel[]).map((channel) => <tr key={channel}>
      <td className="py-2">{LABELS[channel]}</td>
      <td><input type="checkbox" aria-label={`${LABELS[channel]}全局默认`} checked={config.defaults[channel]} disabled={busy} onChange={(event) => void save("global", { ...config.defaults, [channel]: event.target.checked })} /></td>
      {project && <td><select className="rounded border bg-background p-1" disabled={busy} aria-label={`${LABELS[channel]}项目覆盖`} value={config.overrides[channel] === undefined ? "inherit" : String(config.overrides[channel])} onChange={(event) => {
        const overrides = { ...config.overrides }
        if (event.target.value === "inherit") delete overrides[channel]
        else overrides[channel] = event.target.value === "true"
        void save("project", overrides)
      }}><option value="inherit">继承全局</option><option value="true">启用</option><option value="false">关闭</option></select></td>}
      <td>{config.effective[channel] ? "启用" : "关闭"} · {config.overrides[channel] === undefined ? "全局默认" : "项目覆盖"}</td>
    </tr>)}</tbody></table>}
    {config && !Object.values(config.effective).some(Boolean) && <p className="text-xs text-amber-600">全库检索未启用。写入继续，依赖全库证据的审阅检查将标记为未执行。</p>}
  </section>
}
