/** 顶部主流程、左侧执行节点、右侧说明与配置；草稿跨节点保留。 */
import { useEffect, useRef, useState } from "react"
import { ArrowRight, ArrowUpRight, Check, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { createSettingsDraft } from "../settings-draft"
import { saveSettingsSection, type ParameterSection } from "../settings-persistence"
import type { DraftSetter } from "../settings-types"
import { LlmProviderSection } from "../sections/llm-provider-section"
import { NetworkSection } from "../sections/network-section"
import { SourceWatchSection } from "../sections/source-watch-section"
import { ScheduledImportSection } from "../sections/scheduled-import-section"
import { MineruSection } from "../sections/mineru-section"
import { MultimodalSection } from "../sections/multimodal-section"
import { EmbeddingSection } from "../sections/embedding-section"
import { RetrievalSection } from "../sections/retrieval-section"
import { WebSearchSection } from "../sections/web-search-section"
import { OutputSection } from "../sections/output-section"
import { ReviewPromptSection } from "../sections/review-prompt-section"
import { WORKFLOW_STAGES, findWorkflowNode, type WorkflowFile, type WorkflowStageId } from "./workflow-catalog"
import { CODE_SOURCES_FILE, loadWorkflowDocument, saveWorkflowDocument, workflowFilePath, VARIABLE_DESCRIPTIONS, type WorkflowDocumentDraft } from "./workflow-documents"

import { WorkflowFileEditor } from "./workflow-file-editor"
import { BusinessModuleEditor } from "./business-module-editor"

export function WorkflowSettingsView() {
  const project = useWikiStore((state) => state.project)
  // 项目切换时重建草稿，防止原项目的文件内容进入新项目。
  return <WorkflowSettingsPage key={project?.path ?? "no-project"} projectPath={project?.path} />
}

function WorkflowSettingsPage({ projectPath }: { projectPath?: string }) {
  const [stageId, setStageId] = useState<WorkflowStageId>("common")
  const [selection, setSelection] = useState<Record<string, string>>({ common: "purpose" })
  const [draft, setDraftState] = useState(createSettingsDraft)
  const [dirtyParameters, setDirtyParameters] = useState<Set<ParameterSection>>(new Set())
  const [documents, setDocuments] = useState<Record<string, WorkflowDocumentDraft>>({})
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const mainPanel = useRef<HTMLElement>(null)
  const currentProject = useRef(projectPath)
  useEffect(() => {
    currentProject.current = projectPath
    return () => { currentProject.current = undefined }
  }, [projectPath])
  const stage = WORKFLOW_STAGES.find((entry) => entry.id === stageId)!
  const node = stage.nodes.find((entry) => entry.id === selection[stageId]) ?? stage.nodes[0]
  const isModuleDictionary = node.id === "business-types"
  const editable = Boolean(node.parameter || node.inline || node.files?.length)
  const affected = WORKFLOW_STAGES.flatMap((entry) => entry.nodes).filter((entry) => entry.references?.includes(node.id))
  useEffect(() => { mainPanel.current?.scrollTo({ top: 0 }) }, [node.id])

  useEffect(() => {
    if (!projectPath) return
    let stopped = false
    const files = [...(node.files ?? []), ...(isModuleDictionary ? [CODE_SOURCES_FILE] : [])]
    const missing = files.filter((file) => !documents[workflowFilePath(file)])
    Promise.allSettled(missing.map(async (file) => ({ path: workflowFilePath(file), value: await loadWorkflowDocument(projectPath, file) })))
      .then((results) => {
        if (stopped) return
        for (let index = 0; index < results.length; index++) {
          const result = results[index]
          const path = workflowFilePath(missing[index])
          if (result.status === "fulfilled") {
            setDocuments((prev) => ({ ...prev, [path]: prev[path] ?? result.value.value }))
            setLoadErrors((prev) => { const next = { ...prev }; delete next[path]; return next })
          } else setLoadErrors((prev) => ({ ...prev, [path]: String(result.reason) }))
        }
      })
    return () => { stopped = true }
    // 每个节点第一次访问读取，后续使用同一草稿；重新读取由显式按钮触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, projectPath])

  const setDraft: DraftSetter = (key, value) => {
    setDraftState((prev) => ({ ...prev, [key]: value }))
    if (node.parameter) setDirtyParameters((prev) => new Set([...prev, node.parameter!]))
    setMessage(""); setError("")
  }
  function goTo(id: string) {
    const target = findWorkflowNode(id)
    setStageId(target.stage.id)
    setSelection((prev) => ({ ...prev, [target.stage.id]: id }))
    setMessage(""); setError("")
  }
  async function saveParameters() {
    if (!node.parameter) return
    setBusy(true); setMessage(""); setError("")
    try {
      await saveSettingsSection(node.parameter, draft)
      setDirtyParameters((prev) => { const next = new Set(prev); next.delete(node.parameter!); return next })
      setMessage("当前节点参数已保存。")
    } catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  async function reloadFile(file: WorkflowFile) {
    if (!projectPath) return
    const path = workflowFilePath(file)
    setBusy(true); setMessage(""); setError("")
    try {
      const value = await loadWorkflowDocument(projectPath, file)
      if (currentProject.current !== projectPath) return
      setDocuments((prev) => ({ ...prev, [path]: value }))
      setLoadErrors((prev) => { const next = { ...prev }; delete next[path]; return next })
    } catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  async function saveFile(file: WorkflowFile) {
    if (!projectPath) return
    const path = workflowFilePath(file)
    const value = documents[path]
    if (!value) return
    setBusy(true); setMessage(""); setError("")
    try {
      const saved = await saveWorkflowDocument(projectPath, file, value)
      if (currentProject.current !== projectPath) return
      setDocuments((prev) => ({ ...prev, [path]: saved }))
      setMessage(`${path} 已保存。${file.document === "code-sources.json" ? "" : node.impact}`)
      await refreshProjectFileTree(projectPath, { bumpDataVersion: true })
    } catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  function hasNodeDraft(id: string) {
    const entry = findWorkflowNode(id).node
    const files = [...(entry.files ?? []), ...(id === "business-types" ? [CODE_SOURCES_FILE] : [])]
    return Boolean(entry.parameter && dirtyParameters.has(entry.parameter)) || files.some((file) => {
      const document = documents[workflowFilePath(file)]
      return document && document.content !== document.original
    })
  }
  const sectionProps = { draft, setDraft }
  const parameters = node.parameter === "network" ? <NetworkSection {...sectionProps} />
    : node.parameter === "monitoring" || node.parameter === "filters" || node.parameter === "processing"
      ? <SourceWatchSection {...sectionProps} projectReady={!!projectPath} part={node.parameter} />
      : node.parameter === "scheduled-import" ? <ScheduledImportSection {...sectionProps} />
        : node.parameter === "mineru" ? <MineruSection {...sectionProps} />
          : node.parameter === "multimodal" ? <MultimodalSection {...sectionProps} />
            : node.parameter === "embedding" ? <EmbeddingSection {...sectionProps} />
              : node.parameter === "output" ? <OutputSection {...sectionProps} /> : null

  return <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
    <header className="shrink-0 border-b px-5 pb-4 pt-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><h1 className="text-lg font-semibold">知识流程</h1><p className="mt-1 text-xs text-muted-foreground">了解每一步做什么，在对应节点调整规则并查看修改影响。</p></div>
        <span className="max-w-60 truncate rounded-full border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">{useWikiStore.getState().project?.name ?? "尚未打开知识库"}</span>
      </div>
      <nav aria-label="知识处理主流程" className="flex items-center overflow-x-auto pb-1">
        {WORKFLOW_STAGES.map((entry, index) => <div key={entry.id} className="flex shrink-0 items-center">
          {index > 0 && (index === 1 || entry.id === "retrieval" ? <span className="mx-3 h-7 border-l" /> : <ArrowRight className="mx-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />)}
          <button type="button" disabled={busy} aria-current={stageId === entry.id ? "step" : undefined}
            className={`relative rounded-lg border px-3 py-2 text-sm transition-colors ${stageId === entry.id ? "border-primary bg-primary/10 font-semibold text-primary" : "border-transparent bg-muted/40 text-muted-foreground hover:bg-accent"}`}
            onClick={() => { setStageId(entry.id); setMessage(""); setError("") }}>
            {entry.title}{entry.nodes.some((item) => hasNodeDraft(item.id)) && <span className="ml-1 text-amber-600" aria-label="有未保存修改">•</span>}
          </button>
        </div>)}
      </nav>
    </header>
    <div className="flex min-h-0 flex-1">
      <aside className="w-48 shrink-0 overflow-y-auto border-r bg-muted/20 p-3 lg:w-56">
        <p className="mb-3 px-2 text-xs leading-5 text-muted-foreground">{stage.description}</p>
        <nav aria-label={`${stage.title}的执行节点`} className="space-y-1">
          {stage.nodes.map((entry, index) => <button type="button" key={entry.id} disabled={busy}
            aria-current={entry.id === node.id ? "page" : undefined}
            className={`flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left text-sm ${node.id === entry.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60"}`}
            onClick={() => goTo(entry.id)}>
            <span className="pt-0.5 text-[10px] opacity-60">{String(index + 1).padStart(2, "0")}</span>
            <span>{entry.title}{entry.condition && <span className="mt-1 block text-[10px] font-normal opacity-70">按条件执行</span>}</span>
            {hasNodeDraft(entry.id) && <span className="ml-auto text-amber-600" aria-label="未保存">•</span>}
          </button>)}
        </nav>
      </aside>
      <main ref={mainPanel} className="min-w-0 flex-1 overflow-y-auto px-5 py-5 lg:px-8">
        <div className={isModuleDictionary ? "flex h-full flex-col gap-4" : "mx-auto max-w-4xl space-y-5"}>
          <div className="shrink-0"><p className="mb-2 text-xs text-muted-foreground">{stage.title} / {node.title}</p>
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold">{node.title}</h2>
              {node.scope && <span className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground">{node.scope}</span>}
              {!editable && <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">程序自动执行</span>}
            </div><p className="mt-2 text-sm leading-6 text-muted-foreground">{node.description}</p>
          </div>
          {!isModuleDictionary && <section aria-label="节点说明" className="rounded-lg border bg-muted/20 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div><h3 className="mb-1 text-xs font-semibold">输入</h3><p className="text-sm text-muted-foreground">{node.input}</p></div>
              <div><h3 className="mb-1 text-xs font-semibold">产出</h3><p className="text-sm text-muted-foreground">{node.output}</p></div>
              {node.condition && <p className="text-xs text-muted-foreground sm:col-span-2">执行条件：{node.condition}</p>}
            </div>
            <div className="mt-4 border-t pt-4 text-sm">
              <h3 className="mb-1 font-medium">修改影响与生效方式</h3><p className="leading-6 text-muted-foreground">{node.impact}</p>
              {affected.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs"><span>同时影响 / 被以下节点引用：</span>{affected.map((entry) => <button key={entry.id} type="button" disabled={busy} className="underline underline-offset-4" onClick={() => goTo(entry.id)}>{entry.title}</button>)}</div>}
            </div>
          </section>}
          {node.references?.length ? <section className="flex flex-wrap gap-2" aria-label="共用配置引用">{node.references.map((id) => {
            const target = findWorkflowNode(id)
            return <Button key={id} size="sm" variant="outline" disabled={busy} onClick={() => goTo(id)} className="h-auto whitespace-normal text-xs"><ArrowUpRight className="mr-1 h-3 w-3" />{target.stage.title} / {target.node.title}</Button>
          })}</section> : null}
          {(message || error) && <p role={error ? "alert" : "status"} className={`sticky top-0 z-10 rounded-md border bg-background p-3 text-sm shadow-sm ${error ? "border-destructive/30 text-destructive" : "text-emerald-600"}`}>{error || message}</p>}
          {editable && <section aria-label="节点设置" className={isModuleDictionary ? "flex min-h-0 flex-1 flex-col" : "space-y-4 border-t pt-6"}>
            {!isModuleDictionary && <div className="flex items-start gap-2.5">
              <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div><h3 className="text-base font-semibold">节点设置</h3><p className="mt-1 text-xs text-muted-foreground">在这里调整本节点使用的参数与规则；保存范围以各编辑器的按钮说明为准。</p></div>
            </div>}
            {!projectPath && node.files?.length ? <p className="rounded border p-4 text-sm text-muted-foreground">打开知识库后可查看和编辑当前项目文件。</p> : null}
            {projectPath && node.files?.map((file) => {
              const path = workflowFilePath(file)
              const editorProps = { file, value: documents[path], error: loadErrors[path], busy,
                onChange: (content: string) => { setDocuments((prev) => ({ ...prev, [path]: { ...prev[path], content } })); setMessage(""); setError("") },
                onReload: () => reloadFile(file), onSave: () => saveFile(file) }
              if (file.document === "business-modules.md") return <BusinessModuleEditor key={path} projectPath={projectPath} {...editorProps}
                source={{
                  value: documents["code-sources.json"], error: loadErrors["code-sources.json"],
                  onChange: (content) => { setDocuments((prev) => ({ ...prev, "code-sources.json": { ...prev["code-sources.json"], content } })); setMessage(""); setError("") },
                  onReload: () => reloadFile(CODE_SOURCES_FILE), onSave: () => saveFile(CODE_SOURCES_FILE),
                }} />
              return <WorkflowFileEditor key={path} {...editorProps} />
            })}
            {parameters && <section className="rounded-lg border p-4">
              <fieldset disabled={busy || (!projectPath && ["monitoring", "filters", "processing", "scheduled-import"].includes(node.parameter!))}>{parameters}</fieldset>
              <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4">
                <p className="text-xs text-muted-foreground">仅保存当前节点参数；其他节点草稿继续保留。</p>
                <Button disabled={busy || !dirtyParameters.has(node.parameter!)} onClick={saveParameters}><Check className="mr-1 h-4 w-4" />保存当前节点</Button>
              </div>
            </section>}
            {node.inline === "llm" && <LlmProviderSection />}
            {node.inline === "retrieval" && <RetrievalSection />}
            {node.inline === "web-search" && <WebSearchSection />}
            {node.inline === "review-migration" && <ReviewPromptSection onSelectDraft={async (content, key = "backgroundReview") => {
              if (!projectPath) return
              const file: WorkflowFile = { title: "入库审阅规则", prompt: key }
              const path = workflowFilePath(file)
              try {
                const value = documents[path] ?? await loadWorkflowDocument(projectPath, file)
                if (currentProject.current === projectPath) setDocuments((prev) => ({ ...prev, [path]: { ...value, content } }))
              } catch (failure) { setError(String(failure)) }
            }} />}
            {node.inline === "variables" && <VariableReference />}
          </section>}
          {!editable && <p className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"><Settings2 className="h-4 w-4" />此节点暂无独立设置，上方展示其处理职责与相关配置。</p>}
        </div>
      </main>
    </div>
  </div>
}

function VariableReference() {
  return <section className="space-y-4 rounded-lg border p-4 text-sm">
    <p className="leading-6 text-muted-foreground">变量由系统按本次任务注入，不能在公共设置中直接赋值。各模板仅支持其编辑器列出的变量；必填变量、FILE / JSON 输出协议应保留。自然语言规则直接嵌入，不进行二次变量展开。</p>
    <table className="w-full text-left text-xs"><thead><tr><th className="pb-3">变量</th><th className="pb-3">含义与来源</th></tr></thead><tbody>{Object.entries(VARIABLE_DESCRIPTIONS).map(([key, description]) => <tr key={key} className="border-t"><td className="py-3 pr-4 font-mono">{`{{${key}}}`}</td><td className="py-3 text-muted-foreground">{description}</td></tr>)}</tbody></table>
    <p className="text-xs text-muted-foreground">范围说明：项目文件只影响当前知识库；公共模型、网络与外部搜索等应用级配置会影响其他项目。保存配置不等于重新执行，已有任务需按节点说明选择重新入库或重新审阅。</p>
  </section>
}
