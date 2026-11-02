/** 设置草稿统一从当前有效配置建立，界面只保存选中的参数分组。 */
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useZoomStore } from "@/stores/zoom-store"
import i18n from "@/i18n"
import { clampUserConcurrency } from "@/lib/concurrency-limits"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import type { AppTheme } from "@/lib/theme"
import type { SettingsDraft } from "./settings-types"

export function initialDraft(
  llm: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  embed: ReturnType<typeof useWikiStore.getState>["embeddingConfig"],
  multimodal: ReturnType<typeof useWikiStore.getState>["multimodalConfig"],
  outputLanguage: ReturnType<typeof useWikiStore.getState>["outputLanguage"],
  proxy: ReturnType<typeof useWikiStore.getState>["proxyConfig"],
  scheduledImport: ReturnType<typeof useWikiStore.getState>["scheduledImportConfig"],
  sourceWatch: ReturnType<typeof useWikiStore.getState>["sourceWatchConfig"],
  sourceWatchAllProjects: boolean,
  mineru: ReturnType<typeof useWikiStore.getState>["mineruConfig"],
  apiConfig: ReturnType<typeof useWikiStore.getState>["apiConfig"],
  generalConfig: ReturnType<typeof useWikiStore.getState>["generalConfig"],
  maxHistoryMessages: number,
  uiLanguage: string,
  projectPath?: string,
  theme?: AppTheme,
  zoomLevel?: number,
): SettingsDraft {
  // Show absolute path: if stored path is empty, show default using project path
  // If stored path is relative (legacy), prepend project path
  // If stored path is absolute, show as-is
  let displayPath = scheduledImport.path || ""
  if (!displayPath && projectPath) {
    displayPath = `${projectPath}/raw/sources`
  } else if (displayPath && projectPath && !displayPath.startsWith("/") && !displayPath.match(/^[a-zA-Z]:[/\\]/)) {
    // Legacy relative path - prepend project path for display
    displayPath = `${projectPath}/${displayPath}`
  }

  return {
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    ollamaUrl: llm.ollamaUrl,
    customEndpoint: llm.customEndpoint,
    azureApiVersion: llm.azureApiVersion ?? "2024-10-21",
    azureModelFamily: llm.azureModelFamily ?? "auto",
    maxContextSize: llm.maxContextSize ?? 204800,
    apiMode: llm.apiMode,
    reasoning: llm.reasoning,
    ingestReasoning: llm.ingestReasoning,
    localCliIsolation: llm.localCliIsolation === true,
    embeddingEnabled: embed.enabled,
    embeddingEndpoint: embed.endpoint,
    embeddingApiKey: embed.apiKey,
    embeddingModel: embed.model,
    embeddingOutputDimensionality: embed.outputDimensionality,
    embeddingMaxChunkChars: embed.maxChunkChars,
    embeddingOverlapChunkChars: embed.overlapChunkChars,
    embeddingConcurrency: clampUserConcurrency(embed.concurrency ?? 1),
    embeddingBatchSize: embed.batchSize ?? 1,
    embeddingExtraHeaders: embed.extraHeaders ?? {},
    multimodalEnabled: multimodal.enabled,
    multimodalUseMainLlm: multimodal.useMainLlm,
    multimodalProvider: multimodal.provider,
    multimodalApiKey: multimodal.apiKey,
    multimodalModel: multimodal.model,
    multimodalOllamaUrl: multimodal.ollamaUrl,
    multimodalCustomEndpoint: multimodal.customEndpoint,
    multimodalAzureApiVersion: multimodal.azureApiVersion ?? "2024-10-21",
    multimodalAzureModelFamily: multimodal.azureModelFamily ?? "auto",
    multimodalApiMode: multimodal.apiMode,
    multimodalConcurrency: clampUserConcurrency(multimodal.concurrency, 4),
    outputLanguage,
    maxHistoryMessages,
    proxyEnabled: proxy.enabled,
    proxyUrl: proxy.url,
    proxyBypassLocal: proxy.bypassLocal,
    proxyAcceptInvalidCerts: proxy.acceptInvalidCerts === true,
    scheduledImportEnabled: scheduledImport.enabled,
    scheduledImportPath: displayPath,
    scheduledImportInterval: scheduledImport.interval,
    sourceWatchConfig: normalizeSourceWatchConfig(sourceWatch),
    sourceWatchAllProjects,
    mineruEnabled: mineru.enabled,
    mineruBackend: mineru.backend || "cloud",
    mineruLocalEndpoint:
      mineru.localEndpoint || "http://127.0.0.1:8000",
    mineruLocalToken: mineru.localToken || "",
    mineruLocalBackend: mineru.localBackend || "hybrid-engine",
    mineruLocalEffort: mineru.localEffort || "medium",
    mineruLocalParseMethod: mineru.localParseMethod || "auto",
    mineruLocalLanguage: mineru.localLanguage || "ch",
    mineruLocalFormulaEnabled: mineru.localFormulaEnabled !== false,
    mineruLocalTableEnabled: mineru.localTableEnabled !== false,
    mineruLocalImageAnalysis: mineru.localImageAnalysis !== false,
    mineruLocalServerUrl: mineru.localServerUrl || "",
    mineruToken: mineru.token,
    mineruModelVersion: mineru.modelVersion,
    apiEnabled: apiConfig.enabled,
    apiAllowUnauthenticated: apiConfig.allowUnauthenticated,
    apiAllowLanAccess: apiConfig.allowLanAccess,
    apiMcpEnabled: apiConfig.mcpEnabled,
    apiToken: apiConfig.token,
    autostart: generalConfig.autostart,
    closeBehavior: generalConfig.closeBehavior,
    uiLanguage,
    theme: theme ?? "system",
    zoomLevel: zoomLevel ?? useZoomStore.getState().level,
  }
}

export function createSettingsDraft(): SettingsDraft {
  const state = useWikiStore.getState()
  return initialDraft(state.llmConfig, state.embeddingConfig, state.multimodalConfig,
    state.outputLanguage, state.proxyConfig, state.scheduledImportConfig,
    state.sourceWatchConfig, state.sourceWatchAllProjects, state.mineruConfig,
    state.apiConfig, state.generalConfig, useChatStore.getState().maxHistoryMessages,
    i18n.language, state.project?.path, undefined, useZoomStore.getState().level)
}
