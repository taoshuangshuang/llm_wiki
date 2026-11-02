import { useState, useCallback, useEffect, useMemo } from "react"
import {
  Link2Off,
  Unlink,
  ArrowUpRight,
  AlertTriangle,
  Info,
  RefreshCw,
  CheckCircle2,
  BrainCircuit,
  Wrench,
  Trash2,
  Link,
  Settings2,
  Pause,
  Play,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { startLintRun, pauseLintRun, resumeLintRun, restoreLintRun } from "@/lib/lint-runner"
import { useLintRunStore, DEFAULT_LINT_RUN } from "@/stores/lint-run-store"
import { loadProjectSchema } from "@/lib/project-schema"
import { parseModuleCatalog, type BusinessModule, type ModuleCatalog } from "@/features/business-modules/catalog"
import { loadModulePages } from "@/features/business-modules/pages"
import { filterLintItems, lintModuleIndex, type LintFilters } from "@/lib/lint-filters"
import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import {
  appendWikilink,
  ensureBrokenLinkStub,
  rewriteWikilinkTarget,
} from "@/lib/lint-fixes"
import { useTranslation } from "react-i18next"
import { useAppDialog } from "@/stores/app-dialog-store"
import {
  DEFAULT_LINT_CONFIG,
  loadLintConfig,
  saveLintConfig,
  type LintConfig,
} from "@/lib/lint-config"

export function groupLintResultsForDisplay(results: readonly LintItem[]): {
  warnings: LintItem[]
  infos: LintItem[]
} {
  const warnings: LintItem[] = []
  const infos: LintItem[] = []

  results.forEach((result) => {
    if (result.severity === "warning") {
      warnings.push(result)
    } else {
      infos.push(result)
    }
  })

  return { warnings, infos }
}

export function shouldShowLintResults(hasRun: boolean, itemCount: number): boolean {
  return hasRun || itemCount > 0
}

export function LintView() {
  const { t } = useTranslation()
  const appDialog = useAppDialog()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)

  // Dynamic type config based on i18n
  const typeConfig = useMemo(() => ({
    orphan: { icon: Unlink, label: t("lint.typeLabels.orphan") },
    "broken-link": { icon: Link2Off, label: t("lint.typeLabels.broken-link") },
    "no-outlinks": { icon: ArrowUpRight, label: t("lint.typeLabels.no-outlinks") },
    structure: { icon: Settings2, label: t("lint.typeLabels.structure") },
    semantic: { icon: BrainCircuit, label: t("lint.typeLabels.semantic") },
  }), [t])

  const items = useLintStore((s) => s.items)
  const removeLintItems = useLintStore((s) => s.removeItems)

  const projectPath = project ? normalizePath(project.path) : ""
  const run = useLintRunStore((state) => state.runs[projectPath] ?? DEFAULT_LINT_RUN)
  const updateRun = useLintRunStore((state) => state.update)
  const { running, paused, pausing, phase, progress: lintProgress, hasRun, runSemantic, error: checkError, detail: checkDetail } = run
  const dataVersion = useWikiStore((state) => state.dataVersion)
  const [restoringHistory, setRestoringHistory] = useState(true)
  const [filters, setFilters] = useState<LintFilters>({ type: "", moduleId: "", query: "" })
  const [moduleData, setModuleData] = useState<{ path: string; catalog: ModuleCatalog | null; index: Map<string, string[]> }>({ path: "", catalog: null, index: new Map() })
  const [moduleError, setModuleError] = useState<string | null>(null)
  const [modulesLoading, setModulesLoading] = useState(false)
  const catalog = moduleData.path === projectPath ? moduleData.catalog : null
  const moduleIndex = useMemo(() => moduleData.path === projectPath ? moduleData.index : new Map<string, string[]>(), [moduleData, projectPath])
  const visibleItems = useMemo(() => filterLintItems(items, filters, catalog, moduleIndex), [items, filters, catalog, moduleIndex])
  const moduleOptions = useMemo(() => {
    const options: { id: string; label: string }[] = []
    function visit(nodes: BusinessModule[], depth = 0) {
      for (const node of nodes) {
        options.push({ id: node.id, label: `${"　".repeat(depth)}${node.name}` })
        visit(node.children, depth + 1)
      }
    }
    if (catalog) visit(catalog.roots)
    return options
  }, [catalog])
  const [showRuleSettings, setShowRuleSettings] = useState(false)
  const [lintConfig, setLintConfig] = useState<LintConfig>(DEFAULT_LINT_CONFIG)
  const [ignoredPagesDraft, setIgnoredPagesDraft] = useState("")
  const [savingConfig, setSavingConfig] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [batchFixing, setBatchFixing] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [selectedLintIds, setSelectedLintIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let active = true
    // Do not expose the previous project's draft while this project's config
    // is loading, and do not carry a completed save's busy state across a
    // project switch.
    setLintConfig(DEFAULT_LINT_CONFIG)
    setIgnoredPagesDraft("")
    setSavingConfig(false)
    setConfigError(null)
    if (!project) {
      return () => { active = false }
    }
    const projectPath = project.path
    void loadLintConfig(projectPath).then((config) => {
      if (!active || useWikiStore.getState().project?.path !== projectPath) return
      setLintConfig(config)
      setIgnoredPagesDraft(config.ignorePages.join("\n"))
      setConfigError(null)
    })
    return () => { active = false }
  }, [project])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setModuleError(null)
    setModulesLoading(Boolean(projectPath))
    if (!projectPath) return
    void (async () => {
      try {
        const next = parseModuleCatalog(await loadProjectSchema(projectPath, "classification"))
          ?? parseModuleCatalog('## Business Modules\n```json\n{"version":1,"modules":[]}\n```')!
        const result = await loadModulePages(projectPath, next, undefined, controller.signal)
        if (!active) return
        setModuleData({ path: projectPath, catalog: next, index: lintModuleIndex(projectPath, result.pages) })
        setFilters((current) => current.moduleId && !next.byId.has(current.moduleId) ? { ...current, moduleId: "" } : current)
        if (result.unreadable.length) setModuleError(t("sidebar.moduleUnreadable", { count: result.unreadable.length }))
      } catch (error) {
        if (active) { setModuleData({ path: projectPath, catalog: null, index: new Map() }); setModuleError(String(error)) }
      } finally { if (active) setModulesLoading(false) }
    })()
    return () => { active = false; controller.abort() }
  }, [projectPath, dataVersion, t])

  useEffect(() => {
    setFilters({ type: "", moduleId: "", query: "" })
    setSelectedLintIds(new Set())
  }, [projectPath])

  function changeFilter(patch: Partial<LintFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setSelectedLintIds(new Set())
  }

  useEffect(() => {
    let active = true
    setRestoringHistory(Boolean(projectPath))
    if (projectPath) void restoreLintRun(projectPath).finally(() => { if (active) setRestoringHistory(false) })
    return () => { active = false }
  }, [projectPath])

  const handleSaveLintConfig = useCallback(async () => {
    if (!project || savingConfig) return
    const projectPath = project.path
    setSavingConfig(true)
    setConfigError(null)
    try {
      const saved = await saveLintConfig(projectPath, {
        ...lintConfig,
        ignorePages: ignoredPagesDraft.split(/[,，\n]/),
      })
      if (useWikiStore.getState().project?.path !== projectPath) return
      setLintConfig(saved)
      setIgnoredPagesDraft(saved.ignorePages.join("\n"))
      setShowRuleSettings(false)
    } catch (error) {
      if (useWikiStore.getState().project?.path === projectPath) {
        setConfigError(String(error))
      }
    } finally {
      if (useWikiStore.getState().project?.path === projectPath) setSavingConfig(false)
    }
  }, [ignoredPagesDraft, lintConfig, project, savingConfig])

  const handleRunLint = useCallback(async () => {
    if (!project || running) return
    setFixError(null)
    setSelectedLintIds(new Set())
    const options = {
      project, llmConfig, runSemantic,
      config: { ...lintConfig, ignorePages: ignoredPagesDraft.split(/[,，\n]/) },
      messages: { preparing: t("lint.preparingSemantic"), incomplete: t("lint.checkIncomplete"), needsModel: t("lint.checkNeedsModel") },
    }
    if (paused) await resumeLintRun(projectPath, options)
    else await startLintRun(options)
  }, [project, projectPath, running, paused, llmConfig, runSemantic, lintConfig, ignoredPagesDraft, t])

  async function handleOpenPage(page: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/${page}`,
      `${pp}/wiki/${page}.md`,
    ]
    for (const path of candidates) {
      try {
        const content = await readFile(path)
        openFileInPreview(path, content)
        return
      } catch {
        // try next
      }
    }
    openFileInPreview(candidates[0], `Unable to load: ${page}`)
  }

  const addLintItemToReview = useCallback((item: LintItem) => {
    if (item.reviewItem) { useReviewStore.getState().addItems([item.reviewItem]); return }
    switch (item.type) {
      case "broken-link": {
        const pp = project ? normalizePath(project.path) : ""
        useReviewStore.getState().addItem({
          type: "confirm",
          title: t("lint.fixBrokenLink", { page: item.page }),
          description: item.detail,
          affectedPages: [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            ...(pp ? [{ label: t("lint.deletePage"), action: `delete:${pp}/wiki/${item.page}` }] : []),
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
        break
      }
      case "orphan":
      case "no-outlinks": {
        useReviewStore.getState().addItem({
          type: "suggestion",
          title: t("lint.addCrossRefs", { page: item.page }),
          description: item.type === "no-outlinks" ? t("lint.addCrossRefsDescription") : item.detail,
          affectedPages: [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
        break
      }
      default: {
        useReviewStore.getState().addItem({
          type: "confirm",
          title: item.detail.slice(0, 80),
          description: item.detail,
          affectedPages: item.affectedPages ?? [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
      }
    }
  }, [project, t])

  async function handleFix(item: LintItem, refreshTree = true) {
    if (!project) return
    const pp = normalizePath(project.path)
    setFixingId(item.id)
    setFixError(null)

    try {
      switch (item.type) {
        case "orphan": {
          if (item.suggestedSource) {
            const sourcePath = `${pp}/wiki/${item.suggestedSource}`
            const content = await readFile(sourcePath)
            await writeFile(sourcePath, appendWikilink(content, item.page))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "broken-link": {
          const pagePath = `${pp}/wiki/${item.page}`
          if (item.brokenTarget && item.suggestedTarget) {
            const content = await readFile(pagePath)
            await writeFile(pagePath, rewriteWikilinkTarget(content, item.brokenTarget, item.suggestedTarget))
          } else if (item.brokenTarget) {
            const content = await readFile(pagePath)
            const stub = await ensureBrokenLinkStub(pp, item.brokenTarget)
            await writeFile(pagePath, rewriteWikilinkTarget(content, item.brokenTarget, stub.relativePath))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "no-outlinks": {
          if (item.suggestedTarget) {
            const pagePath = `${pp}/wiki/${item.page}`
            const content = await readFile(pagePath)
            await writeFile(pagePath, appendWikilink(content, item.suggestedTarget))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        default: {
          // Semantic issues → send to Review for manual resolution
          addLintItemToReview(item)
          useLintStore.getState().removeItem(item.id)
          break
        }
      }

      if (refreshTree) {
        await refreshProjectFileTree(pp, {
          projectId: project.id,
          bumpDataVersion: true,
        })
      }
    } catch (err) {
      console.error("Fix failed:", err)
      setFixError(err instanceof Error ? err.message : String(err))
    } finally {
      setFixingId(null)
    }
  }

  async function handleDeleteOrphan(item: LintItem) {
    if (!project) return
    const pp = normalizePath(project.path)
    const pagePath = `${pp}/wiki/${item.page}`
    const confirmed = await appDialog.confirm({
      message: t("lint.deleteOrphanConfirm", { page: item.page }),
      variant: "destructive",
    })
    if (!confirmed) return

    try {
      // Full cascade: file + embedding chunks + every reference to
      // the page across the wiki (body wikilinks, index.md listing,
      // `related:` frontmatter arrays). Even though "orphan" by lint
      // means no incoming wikilinks were detected, `related:` slugs
      // and index.md entries can still point at it — the orphan
      // detector only walks body refs.
      const { cascadeDeleteWikiPagesWithRefs } = await import(
        "@/lib/wiki-page-delete"
      )
      const result = await cascadeDeleteWikiPagesWithRefs(pp, [pagePath])
      if (result.warnings.length > 0) await appDialog.alert({ message: result.warnings.join("\n") })
      useLintStore.getState().removeItem(item.id)
      await refreshProjectFileTree(pp, {
        projectId: project.id,
        bumpDataVersion: true,
      })
    } catch (err) {
      console.error("Delete failed:", err)
    }
  }

  const { warnings, infos } = useMemo(
    () => groupLintResultsForDisplay(visibleItems),
    [visibleItems],
  )
  const showResults = running || paused || shouldShowLintResults(hasRun, items.length)
  const selectedLintItems = useMemo(
    () => visibleItems.filter((item) => selectedLintIds.has(item.id)),
    [visibleItems, selectedLintIds],
  )
  const allLintSelected = visibleItems.length > 0 && selectedLintItems.length === visibleItems.length
  const isFixing = fixingId !== null || batchFixing

  const setLintSelected = useCallback((id: string, selected: boolean) => {
    setSelectedLintIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const toggleAllLint = useCallback(() => {
    setSelectedLintIds((prev) => {
      const next = new Set(prev)
      if (allLintSelected) {
        for (const item of visibleItems) next.delete(item.id)
      } else {
        for (const item of visibleItems) next.add(item.id)
      }
      return next
    })
  }, [allLintSelected, visibleItems])

  const handleBatchDismiss = useCallback(() => {
    const ids = selectedLintItems.map((item) => item.id)
    removeLintItems(ids)
    setSelectedLintIds(new Set())
  }, [removeLintItems, selectedLintItems])

  const handleBatchSendToReview = useCallback(() => {
    for (const item of selectedLintItems) {
      addLintItemToReview(item)
    }
    removeLintItems(selectedLintItems.map((item) => item.id))
    setSelectedLintIds(new Set())
  }, [addLintItemToReview, removeLintItems, selectedLintItems])

  const handleBatchFix = useCallback(async () => {
    if (!project || batchFixing || selectedLintItems.length === 0) return
    setBatchFixing(true)
    setFixError(null)
    const pp = normalizePath(project.path)
    let filesystemChanged = false
    try {
      const edits = new Map<string, Array<{ id: string; apply: (content: string) => string }>>()
      const queueEdit = (path: string, id: string, apply: (content: string) => string) => {
        const pending = edits.get(path) ?? []
        pending.push({ id, apply })
        edits.set(path, pending)
      }

      for (const item of selectedLintItems) {
        if (item.type === "orphan" && item.suggestedSource) {
          queueEdit(`${pp}/wiki/${item.suggestedSource}`, item.id, (content) => appendWikilink(content, item.page))
        } else if (item.type === "no-outlinks" && item.suggestedTarget) {
          queueEdit(`${pp}/wiki/${item.page}`, item.id, (content) => appendWikilink(content, item.suggestedTarget!))
        } else if (item.type === "broken-link" && item.brokenTarget) {
          const stub = item.suggestedTarget ? null : await ensureBrokenLinkStub(pp, item.brokenTarget)
          if (stub) filesystemChanged = true
          const target = item.suggestedTarget ?? stub!.relativePath
          queueEdit(`${pp}/wiki/${item.page}`, item.id, (content) =>
            rewriteWikilinkTarget(content, item.brokenTarget!, target))
        } else {
          addLintItemToReview(item)
          removeLintItems([item.id])
        }
      }

      // Multiple findings can target the same page. Apply their transforms in
      // memory and write that page once, avoiding lost updates and N full reads.
      for (const [path, pending] of edits) {
        const original = await readFile(path)
        const updated = pending.reduce((content, edit) => edit.apply(content), original)
        if (updated !== original) {
          await writeFile(path, updated)
          filesystemChanged = true
        }
        removeLintItems(pending.map((edit) => edit.id))
      }
      setSelectedLintIds(new Set())
    } catch (err) {
      console.error("Batch fix failed:", err)
      setFixError(err instanceof Error ? err.message : String(err))
    } finally {
      // Refresh even after a partial failure: earlier files or stubs may have
      // been written successfully. The expensive recursive rebuild still runs
      // at most once for the whole batch.
      if (filesystemChanged) {
        await refreshProjectFileTree(pp, {
          projectId: project.id,
          bumpDataVersion: true,
        })
      }
      setBatchFixing(false)
    }
  }, [addLintItemToReview, batchFixing, project, removeLintItems, selectedLintItems])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant={showRuleSettings ? "secondary" : "ghost"}
            onClick={() => setShowRuleSettings((value) => !value)}
            title={t("lint.ruleSettings")}
            aria-label={t("lint.ruleSettings")}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
          <h2 className="text-sm font-semibold">{t("lint.title")}</h2>
          {showResults && items.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {items.length === 1 ? t("lint.issues", { count: items.length }) : t("lint.issues_plural", { count: items.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={runSemantic}
              onChange={(e) => updateRun(projectPath, { runSemantic: e.target.checked })}
              disabled={running || paused || !project}
            />
            {t("lint.semantic")}
          </label>
          <Button
            size="sm"
            variant={running ? "outline" : "default"}
            onClick={running ? () => pauseLintRun(projectPath) : handleRunLint}
            disabled={!project || pausing || restoringHistory}
          >
            {running ? <Pause className="mr-1.5 h-3.5 w-3.5" /> : paused ? <Play className="mr-1.5 h-3.5 w-3.5" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            {pausing ? t("lint.pausing") : running ? t("lint.pause") : paused ? t("lint.resume") : t("lint.runLint")}
          </Button>
        </div>
      </div>

      {(running || paused || hasRun) && (
        <div className="shrink-0 space-y-2 border-b bg-muted/10 px-4 py-3" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium">{t(pausing ? "lint.pausing" : paused ? "lint.paused" : running ? "lint.running" : checkError ? "lint.checkIncomplete" : "lint.finished")}</span>
            <span className="text-muted-foreground">{t(phase === "semantic" ? "lint.semanticPhase" : "lint.structuralPhase")}{lintProgress && ` · ${t(phase === "semantic" ? "lint.batchProgress" : "lint.pageProgress", lintProgress)}`}</span>
          </div>
          <div role="progressbar" aria-label={t("lint.progress")} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={lintProgress && lintProgress.total > 0 ? Math.round(lintProgress.completed / lintProgress.total * 100) : undefined}
            className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full bg-primary transition-all ${running && !lintProgress ? "animate-pulse" : ""}`}
              style={{ width: lintProgress && lintProgress.total > 0 ? `${Math.min(100, lintProgress.completed / lintProgress.total * 100)}%` : running ? "20%" : "0%" }} />
          </div>
          {checkDetail && <p className="text-xs text-muted-foreground">{checkDetail}</p>}
          {paused && <p className="text-xs text-muted-foreground">{t("lint.resumeHint")}</p>}
        </div>
      )}

      {runSemantic && <p className="border-b px-4 py-2 text-xs text-muted-foreground">{t("lint.semanticDescription")}</p>}
      {showRuleSettings && (
        <div className="shrink-0 space-y-3 border-b bg-muted/20 px-4 py-3 text-xs">
          <div className="font-medium">{t("lint.ruleSettings")}</div>
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              disabled={running || paused}
              checked={lintConfig.ignoreOrphan}
              onChange={(event) => setLintConfig((config) => ({
                ...config,
                ignoreOrphan: event.target.checked,
              }))}
            />
            {t("lint.ignoreOrphan")}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              disabled={running || paused}
              checked={lintConfig.ignoreNoOutlinks}
              onChange={(event) => setLintConfig((config) => ({
                ...config,
                ignoreNoOutlinks: event.target.checked,
              }))}
            />
            {t("lint.ignoreNoOutlinks")}
          </label>
          <label className="block space-y-1.5">
            <span className="text-muted-foreground">{t("lint.ignorePages")}</span>
            <textarea
              disabled={running || paused}
              value={ignoredPagesDraft}
              onChange={(event) => setIgnoredPagesDraft(event.target.value)}
              placeholder={t("lint.ignorePagesPlaceholder")}
              className="min-h-20 w-full resize-y rounded border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          {configError && <p className="text-destructive">{configError}</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSaveLintConfig} disabled={savingConfig || running || paused}>
              {savingConfig ? t("lint.savingRules") : t("lint.saveRules")}
            </Button>
          </div>
        </div>
      )}

      <div className="shrink-0 space-y-2 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select aria-label={t("lint.filterType")} value={filters.type} onChange={(event) => changeFilter({ type: event.target.value })}
            className="h-8 rounded-md border bg-background px-2">
            <option value="">{t("lint.allTypes")} ({filterLintItems(items, { ...filters, type: "" }, catalog, moduleIndex).length})</option>
            {Object.entries(typeConfig).map(([type, config]) => <option key={type} value={type}>{config.label} ({filterLintItems(items, { ...filters, type }, catalog, moduleIndex).length})</option>)}
          </select>
          <select aria-label={t("lint.filterModule")} value={filters.moduleId} disabled={modulesLoading || !catalog}
            onChange={(event) => changeFilter({ moduleId: event.target.value })} className="h-8 max-w-64 rounded-md border bg-background px-2">
            <option value="">{t("lint.allModules")} ({filterLintItems(items, { ...filters, moduleId: "" }, catalog, moduleIndex).length})</option>
            {moduleOptions.map((module) => <option key={module.id} value={module.id}>{module.label} ({filterLintItems(items, { ...filters, moduleId: module.id }, catalog, moduleIndex).length})</option>)}
          </select>
          <input type="search" aria-label={t("lint.searchIssues")} placeholder={t("lint.searchIssues")} value={filters.query}
            onChange={(event) => changeFilter({ query: event.target.value })} className="h-8 min-w-44 flex-1 rounded-md border bg-background px-2" />
          <span className="text-muted-foreground">{t("lint.filteredCount", { count: visibleItems.length, total: items.length })}</span>
        </div>
        {moduleError && <p role="alert" className="text-xs text-destructive">{moduleError}</p>}
      </div>

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2 text-xs">
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={allLintSelected}
              onChange={toggleAllLint}
            />
            {t("lint.selectVisible")}
          </label>
          <span className="text-muted-foreground">
            {t("lint.selectedCount", { count: selectedLintItems.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchFix}
          >
            {batchFixing ? t("lint.fixing") : t("lint.fixSelected")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchSendToReview}
          >
            {t("lint.sendSelectedToReview")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchDismiss}
          >
            {t("lint.ignoreSelected")}
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {checkError && <p role="alert" className="px-4 py-2 text-xs text-destructive">{checkError}</p>}
        {fixError && (
          <div className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("lint.fixFailed", { error: fixError })}
          </div>
        )}
        {!showResults ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>{t("lint.runLintHint")}</p>
            <p className="text-xs">{t("lint.runLintDescription")}</p>
          </div>
        ) : items.length === 0 && !checkError && !running && !paused ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">{t("lint.allClear")}</p>
            <p className="text-xs">{t("lint.noIssues")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {(items.length > 0 || running) && visibleItems.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{t(running ? "lint.awaitingIssues" : "lint.noMatchingIssues")}</p>}
            {warnings.length > 0 && (
              <SectionHeader icon={AlertTriangle} label={t("lint.warnings")} count={warnings.length} color="text-amber-500" t={t} />
            )}
            {warnings.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                selected={selectedLintIds.has(item.id)}
                onSelectedChange={setLintSelected}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
            {infos.length > 0 && (
              <SectionHeader icon={Info} label={t("lint.info")} count={infos.length} color="text-blue-500" t={t} />
            )}
            {infos.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                selected={selectedLintIds.has(item.id)}
                onSelectedChange={setLintSelected}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  color,
  t,
}: {
  icon: typeof AlertTriangle
  label: string
  count: number
  color: string
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <div className={`flex items-center gap-1.5 px-1 py-1 text-xs font-semibold ${color}`}>
      <Icon className="h-3.5 w-3.5" />
      {t("lint.sectionCount", { label, count })}
    </div>
  )
}

function LintCard({
  item,
  fixing,
  selected,
  onSelectedChange,
  onOpenPage,
  onFix,
  onDelete,
  typeConfig,
  t,
}: {
  item: LintItem
  fixing: boolean
  selected: boolean
  onSelectedChange: (id: string, selected: boolean) => void
  onOpenPage: (page: string) => void
  onFix: (item: LintItem) => void
  onDelete?: (item: LintItem) => void
  typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const config = typeConfig[item.type] ?? typeConfig.semantic
  const Icon = config.icon

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-1.5 flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5"
          checked={selected}
          onChange={(event) => onSelectedChange(item.id, event.target.checked)}
          aria-label={t("lint.selectItem", { page: item.page })}
        />
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            item.severity === "warning" ? "text-amber-500" : "text-blue-500"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{item.page}</div>
          <div className="text-[11px] text-muted-foreground">{config.label}</div>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{item.detail}</p>

      {(item.suggestedTarget || item.suggestedSource) && (
        <div className="mb-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
          <div className="flex items-start gap-1.5">
            <Link className="mt-0.5 h-3 w-3 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">
                {item.suggestedSource
                  ? t("lint.suggestedSource", { page: item.suggestedSource })
                  : t("lint.suggestedTarget", { page: item.suggestedTarget })}
              </div>
            </div>
          </div>
        </div>
      )}

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {item.affectedPages.map((page) => (
            <button
              key={page}
              type="button"
              onClick={() => onOpenPage(page)}
              className="inline-flex items-center gap-0.5 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
            >
              {page}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          onClick={() => onOpenPage(item.page)}
        >
          {t("lint.open")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          disabled={fixing}
          onClick={() => onFix(item)}
        >
          <Wrench className="h-3 w-3" />
          {fixing ? t("lint.fixing") : t("lint.fix")}
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
            onClick={() => onDelete(item)}
          >
            <Trash2 className="h-3 w-3" />
            {t("lint.delete")}
          </Button>
        )}
      </div>
    </div>
  )
}
