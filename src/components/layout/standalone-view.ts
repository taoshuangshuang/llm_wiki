import type { WikiState } from "@/stores/wiki-store"

export function isStandaloneView(view: WikiState["activeView"]): boolean {
  return view === "sources" || view === "chat" || view === "skills" || view === "settings" || view === "imports" || view === "workflow"
}
