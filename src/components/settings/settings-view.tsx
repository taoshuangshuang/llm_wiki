/** 应用设置仅保留运行与界面管理；知识处理参数集中在知识流程。 */
import { useEffect, useState } from "react"
import { Settings, Palette, Server, Wrench, History, Info, Workflow } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useUpdateStore, hasAvailableUpdate } from "@/stores/update-store"
import { loadTheme } from "@/lib/project-store"
import { applyTheme } from "@/lib/theme"
import { createSettingsDraft } from "./settings-draft"
import { saveSettingsSection, type ParameterSection } from "./settings-persistence"
import type { DraftSetter } from "./settings-types"
import { GeneralSection } from "./sections/general-section"
import { ApiServerSection } from "./sections/api-server-section"
import { InterfaceSection } from "./sections/interface-section"
import { MaintenanceSection } from "./sections/maintenance-section"
import { ChangelogSection } from "./sections/changelog-section"
import { AboutSection } from "./sections/about-section"

const CATEGORIES = [
  { id: "general", label: "general", icon: Settings },
  { id: "api-server", label: "apiServer", icon: Server },
  { id: "interface", label: "interface", icon: Palette },
  { id: "maintenance", label: "maintenance", icon: Wrench },
  { id: "changelog", label: "changelog", icon: History },
  { id: "about", label: "about", icon: Info },
] as const

export function SettingsView() {
  const { t } = useTranslation()
  const [active, setActive] = useState<(typeof CATEGORIES)[number]["id"]>("general")
  const [draft, setDraftState] = useState(createSettingsDraft)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const updateAvailable = useUpdateStore((state) => hasAvailableUpdate(state))
  useEffect(() => {
    let stopped = false
    loadTheme().then((theme) => { if (!stopped && theme) setDraftState((prev) => ({ ...prev, theme })) }).catch(() => {})
    return () => { stopped = true }
  }, [])
  const setDraft: DraftSetter = (key, value) => {
    setDraftState((prev) => ({ ...prev, [key]: value }))
    setMessage(""); setError("")
  }
  async function save() {
    setBusy(true); setError(""); setMessage("")
    try { await saveSettingsSection(active as ParameterSection, draft); setMessage(t("settings.savedTick")) }
    catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  const body = active === "general" ? <GeneralSection draft={draft} setDraft={setDraft} />
    : active === "api-server" ? <ApiServerSection draft={draft} setDraft={setDraft} />
      : active === "interface" ? <InterfaceSection draft={draft} setDraft={setDraft} onThemeChange={applyTheme} />
        : active === "maintenance" ? <MaintenanceSection />
          : active === "changelog" ? <ChangelogSection /> : <AboutSection />
  const editable = ["general", "api-server", "interface"].includes(active)
  return <div className="flex h-full overflow-hidden">
    <aside className="flex w-52 shrink-0 flex-col border-r bg-muted/30 p-3">
      <h2 className="px-2 py-3 text-sm font-semibold">{t("settings.title")}</h2>
      <nav className="space-y-1 overflow-y-auto">
        {CATEGORIES.map(({ id, label, icon: Icon }) => <button key={id} type="button" disabled={busy}
          aria-current={active === id ? "page" : undefined}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${active === id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"}`}
          onClick={() => { setActive(id); setMessage(""); setError("") }}>
          <Icon className="h-4 w-4" />{t(`settings.categories.${label}`)}
          {id === "about" && updateAvailable && <span className="ml-auto h-2 w-2 rounded-full bg-red-500" aria-label={t("nav.updateAvailable")} />}
        </button>)}
      </nav>
      <button type="button" className="mt-5 rounded-md border p-3 text-left text-xs text-muted-foreground hover:bg-accent"
        onClick={() => useWikiStore.getState().setActiveView("workflow")}>
        <Workflow className="mb-2 h-4 w-4" />模型、文件处理、检索与输出设置已迁入「知识流程」 →
      </button>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6"><fieldset disabled={busy} className="mx-auto max-w-2xl">{body}</fieldset></div>
      {editable && <div className="flex items-center justify-between gap-4 border-t px-6 py-3">
        <p role="status" className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{error || message || "保存仅应用当前设置分类。"}</p>
        <Button disabled={busy} onClick={save}>{busy ? "保存中…" : "保存当前设置"}</Button>
      </div>}
    </div>
  </div>
}
