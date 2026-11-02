/** 按参数分组持久化；先保存，再更新运行状态，避免一次保存覆盖其他节点的配置。 */
import { invoke } from "@tauri-apps/api/core"
import { enable, disable } from "@tauri-apps/plugin-autostart"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useZoomStore } from "@/stores/zoom-store"
import * as storage from "@/lib/project-store"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { clampUserConcurrency } from "@/lib/concurrency-limits"
import { applyTheme } from "@/lib/theme"
import i18n from "@/i18n"
import type { SettingsDraft } from "./settings-types"

export type ParameterSection = "network" | "monitoring" | "filters" | "processing" | "scheduled-import"
  | "mineru" | "multimodal" | "embedding" | "output" | "general" | "interface" | "api-server"

/** 项目参数绑定发起保存时的项目；切换项目后只完成原项目落盘。 */
export async function saveSettingsSection(section: ParameterSection, draft: SettingsDraft): Promise<void> {
  const state = useWikiStore.getState()
  const project = state.project
  const isCurrent = () => useWikiStore.getState().project?.path === project?.path
  switch (section) {
    case "monitoring":
    case "filters":
    case "processing": {
      if (!project) throw new Error("请先打开知识库项目")
      const fields = section === "monitoring" ? ["enabled", "autoIngest"] as const
        : section === "processing" ? ["parsingConcurrency", "ingestConcurrency", "persistExtractedMarkdown"] as const
          : ["includeExtensions", "excludeExtensions", "excludeDirs", "excludeGlobs", "maxFileSizeMb"] as const
      const patch = Object.fromEntries(fields.map((field) => [field, draft.sourceWatchConfig[field]]))
      const config = normalizeSourceWatchConfig({ ...state.sourceWatchConfig, ...patch })
      await storage.saveSourceWatchConfig(config, project.id)
      if (section === "monitoring") await storage.saveSourceWatchAllProjects(draft.sourceWatchAllProjects)
      if (!isCurrent()) return
      state.setSourceWatchConfig(config)
      if (section === "monitoring") state.setSourceWatchAllProjects(draft.sourceWatchAllProjects)
      const { setIngestWorkerLimit } = await import("@/lib/ingest-queue")
      const sync = await import("@/lib/project-file-sync")
      if (!isCurrent()) return
      setIngestWorkerLimit(config.ingestConcurrency)
      if (config.enabled) await sync.startProjectFileSync(project, config)
      else await sync.stopProjectFileSync()
      if (!isCurrent()) return
      if (useWikiStore.getState().sourceWatchAllProjects) sync.startAllProjectFileSync(project)
      else sync.stopAllProjectFileSync()
      return
    }
    case "scheduled-import": {
      if (!project) throw new Error("请先打开知识库项目")
      const config = { enabled: draft.scheduledImportEnabled, path: draft.scheduledImportPath,
        interval: Math.max(1, Math.min(1440, draft.scheduledImportInterval || 60)), lastScan: state.scheduledImportConfig.lastScan }
      await storage.saveScheduledImportConfig(project.path, config)
      if (!isCurrent()) return
      state.setScheduledImportConfig(config)
      const { startScheduledImport } = await import("@/lib/scheduled-import")
      if (!isCurrent()) return
      startScheduledImport(project, config)
      return
    }
    case "network": {
      const config = { enabled: draft.proxyEnabled, url: draft.proxyUrl.trim(), bypassLocal: draft.proxyBypassLocal,
        acceptInvalidCerts: draft.proxyAcceptInvalidCerts }
      await storage.saveProxyConfig(config)
      state.setProxyConfig(config)
      // 下一次出站请求读取新的代理；设置同时保存供重启使用。
      await invoke("set_proxy_env", { config })
      return
    }
    case "mineru": {
      const config = { enabled: draft.mineruEnabled, backend: draft.mineruBackend,
        localEndpoint: draft.mineruLocalEndpoint.trim(), localToken: draft.mineruLocalToken.trim(),
        localBackend: draft.mineruLocalBackend, localEffort: draft.mineruLocalEffort,
        localParseMethod: draft.mineruLocalParseMethod, localLanguage: draft.mineruLocalLanguage.trim(),
        localFormulaEnabled: draft.mineruLocalFormulaEnabled, localTableEnabled: draft.mineruLocalTableEnabled,
        localImageAnalysis: draft.mineruLocalImageAnalysis, localServerUrl: draft.mineruLocalServerUrl.trim(),
        token: draft.mineruToken.trim(), modelVersion: draft.mineruModelVersion }
      await storage.saveMineruConfig(config)
      state.setMineruConfig(config)
      return
    }
    case "multimodal": {
      const config = { enabled: draft.multimodalEnabled, useMainLlm: draft.multimodalUseMainLlm,
        provider: draft.multimodalProvider, apiKey: draft.multimodalApiKey, model: draft.multimodalModel,
        ollamaUrl: draft.multimodalOllamaUrl, customEndpoint: draft.multimodalCustomEndpoint,
        azureApiVersion: draft.multimodalProvider === "azure" ? draft.multimodalAzureApiVersion.trim() : undefined,
        azureModelFamily: draft.multimodalProvider === "azure" ? draft.multimodalAzureModelFamily : undefined,
        apiMode: draft.multimodalProvider === "custom" ? draft.multimodalApiMode : undefined,
        concurrency: clampUserConcurrency(draft.multimodalConcurrency || 4) }
      await storage.saveMultimodalConfig(config)
      state.setMultimodalConfig(config)
      return
    }
    case "embedding": {
      const config = { enabled: draft.embeddingEnabled, endpoint: draft.embeddingEndpoint, apiKey: draft.embeddingApiKey,
        model: draft.embeddingModel, outputDimensionality: draft.embeddingOutputDimensionality,
        maxChunkChars: draft.embeddingMaxChunkChars, overlapChunkChars: draft.embeddingOverlapChunkChars,
        concurrency: clampUserConcurrency(draft.embeddingConcurrency || 1),
        batchSize: Math.max(1, Math.min(64, Math.floor(draft.embeddingBatchSize || 1))), extraHeaders: draft.embeddingExtraHeaders }
      await storage.saveEmbeddingConfig(config)
      state.setEmbeddingConfig(config)
      return
    }
    case "output":
      await storage.saveOutputLanguage(draft.outputLanguage as typeof state.outputLanguage, project?.id)
      await storage.saveHistoryMessageLimit(draft.maxHistoryMessages)
      if (isCurrent()) state.setOutputLanguage(draft.outputLanguage as typeof state.outputLanguage)
      useChatStore.getState().setMaxHistoryMessages(draft.maxHistoryMessages)
      return
    case "general": {
      const config = { autostart: draft.autostart, closeBehavior: draft.closeBehavior }
      await storage.saveGeneralConfig(config)
      state.setGeneralConfig(config)
      if (config.autostart) await enable()
      else await disable()
      await invoke("set_close_behavior", { value: config.closeBehavior })
      return
    }
    case "api-server": {
      const config = { enabled: draft.apiEnabled, allowUnauthenticated: draft.apiAllowUnauthenticated,
        allowLanAccess: draft.apiAllowLanAccess, mcpEnabled: draft.apiMcpEnabled, token: draft.apiToken.trim() }
      await storage.saveApiConfig(config)
      state.setApiConfig(config)
      // 服务器从同一 app-state.json 读取配置；地址修改仍需重启。
      await invoke("api_server_reload_config")
      return
    }
    case "interface":
      await storage.saveLanguage(draft.uiLanguage)
      await i18n.changeLanguage(draft.uiLanguage)
      await storage.saveTheme(draft.theme)
      applyTheme(draft.theme)
      await storage.saveZoomLevel(draft.zoomLevel)
      useZoomStore.getState().setLevel(draft.zoomLevel)
  }
}
