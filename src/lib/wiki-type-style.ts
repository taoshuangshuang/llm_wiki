import type { LucideIcon } from "lucide-react"
import {
  User,
  Lightbulb,
  HelpCircle,
  FileText,
  Target,
  TrendingUp,
  BookOpen,
  Calendar,
  Hash,
  Blocks, BookOpenText, Database, Network, CodeXml, ShieldCheck,
  Braces, Plug, MousePointer2, Wrench, Ticket, Archive, GitCompareArrows, GitMerge, FileQuestion,
} from "lucide-react"

export interface WikiTypeStyle {
  /** Display label for chips and tooltips. Capitalized. */
  label: string
  /** Lucide icon component for the type. */
  icon: LucideIcon
  /** 列表与树节点共用的图标颜色，兼顾明暗主题。 */
  iconClass: string
  /**
   * Tailwind classes for a colored chip (background + text). Includes
   * dark-mode variants so the chip stays readable on either theme.
   */
  chipClass: string
  /**
   * Tailwind class for the type's accent dot or border (without the
   * 15% opacity used by chips). Useful for connector lines.
   */
  dotClass: string
}

/** 项目类型与内置类型共用视觉定义，业务树、知识树和页面预览保持一致。 */
export const WIKI_TYPE_STYLES: Record<string, WikiTypeStyle> = {
  module: {
    label: "Module",
    icon: Blocks,
    chipClass: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    dotClass: "bg-blue-500",
    iconClass: "text-blue-600 dark:text-blue-400",
  },
  topic: {
    label: "Topic",
    icon: BookOpenText,
    chipClass: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    dotClass: "bg-violet-500",
    iconClass: "text-violet-600 dark:text-violet-400",
  },
  "data-model": {
    label: "Data Model",
    icon: Database,
    chipClass: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
    dotClass: "bg-cyan-500",
    iconClass: "text-cyan-600 dark:text-cyan-400",
  },
  design: {
    label: "Design",
    icon: Network,
    chipClass: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
    dotClass: "bg-indigo-500",
    iconClass: "text-indigo-600 dark:text-indigo-400",
  },
  implementation: {
    label: "Implementation",
    icon: CodeXml,
    chipClass: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
    dotClass: "bg-teal-500",
    iconClass: "text-teal-600 dark:text-teal-400",
  },
  constraint: {
    label: "Constraint",
    icon: ShieldCheck,
    chipClass: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    dotClass: "bg-amber-500",
    iconClass: "text-amber-600 dark:text-amber-400",
  },
  interface: {
    label: "Interface",
    icon: Braces,
    chipClass: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    dotClass: "bg-sky-500",
    iconClass: "text-sky-600 dark:text-sky-400",
  },
  integration: {
    label: "Integration",
    icon: Plug,
    chipClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dotClass: "bg-emerald-500",
    iconClass: "text-emerald-600 dark:text-emerald-400",
  },
  practice: {
    label: "Practice",
    icon: MousePointer2,
    chipClass: "bg-lime-500/15 text-lime-700 dark:text-lime-300",
    dotClass: "bg-lime-500",
    iconClass: "text-lime-600 dark:text-lime-400",
  },
  faq: {
    label: "Troubleshooting",
    icon: Wrench,
    chipClass: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
    dotClass: "bg-orange-500",
    iconClass: "text-orange-600 dark:text-orange-400",
  },
  case: {
    label: "Ticket",
    icon: Ticket,
    chipClass: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
    dotClass: "bg-rose-500",
    iconClass: "text-rose-600 dark:text-rose-400",
  },
  legacy: {
    label: "Legacy",
    icon: Archive,
    chipClass: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
    dotClass: "bg-slate-500",
    iconClass: "text-slate-600 dark:text-slate-400",
  },
  other: {
    label: "Other",
    icon: FileQuestion,
    chipClass: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
    dotClass: "bg-slate-500",
    iconClass: "text-slate-600 dark:text-slate-400",
  },
  comparison: {
    label: "Comparison",
    icon: GitCompareArrows,
    chipClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dotClass: "bg-emerald-500",
    iconClass: "text-emerald-600 dark:text-emerald-400",
  },
  synthesis: {
    label: "Synthesis",
    icon: GitMerge,
    chipClass: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
    dotClass: "bg-purple-500",
    iconClass: "text-purple-600 dark:text-purple-400",
  },

  entity: {
    label: "Entity",
    icon: User,
    chipClass: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    dotClass: "bg-blue-500",
    iconClass: "text-blue-600 dark:text-blue-400",
  },
  concept: {
    label: "Concept",
    icon: Lightbulb,
    chipClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dotClass: "bg-emerald-500",
    iconClass: "text-emerald-600 dark:text-emerald-400",
  },
  query: {
    label: "Query",
    icon: HelpCircle,
    chipClass: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    dotClass: "bg-amber-500",
    iconClass: "text-amber-600 dark:text-amber-400",
  },
  source: {
    label: "Source",
    icon: FileText,
    chipClass: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
    dotClass: "bg-slate-500",
    iconClass: "text-slate-600 dark:text-slate-400",
  },
  thesis: {
    label: "Thesis",
    icon: Target,
    chipClass: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
    dotClass: "bg-rose-500",
    iconClass: "text-rose-600 dark:text-rose-400",
  },
  finding: {
    label: "Finding",
    icon: TrendingUp,
    chipClass: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
    dotClass: "bg-purple-500",
    iconClass: "text-purple-600 dark:text-purple-400",
  },
  methodology: {
    label: "Methodology",
    icon: BookOpen,
    chipClass: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
    dotClass: "bg-teal-500",
    iconClass: "text-teal-600 dark:text-teal-400",
  },
  event: {
    label: "Event",
    icon: Calendar,
    chipClass: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
    dotClass: "bg-cyan-500",
    iconClass: "text-cyan-600 dark:text-cyan-400",
  },
  overview: {
    label: "Overview",
    icon: BookOpen,
    chipClass: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
    dotClass: "bg-indigo-500",
    iconClass: "text-indigo-600 dark:text-indigo-400",
  },
}

export const FALLBACK_TYPE_STYLE: WikiTypeStyle = {
  label: "Page",
  icon: Hash,
  chipClass: "bg-muted text-muted-foreground",
  dotClass: "bg-muted-foreground/60",
  iconClass: "text-muted-foreground",
}

export function getWikiTypeStyle(type: string | null | undefined): WikiTypeStyle {
  if (!type) return FALLBACK_TYPE_STYLE
  const key = type.trim().toLowerCase()
  return WIKI_TYPE_STYLES[key] ?? FALLBACK_TYPE_STYLE
}
