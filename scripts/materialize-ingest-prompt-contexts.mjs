/** 将旧模板隐含的说明写入文件并去除常规上下文判空；默认预览，--apply 才备份并修改。 */
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const projectPath = process.argv[2]
if (!projectPath) throw new Error("用法：node scripts/materialize-ingest-prompt-contexts.mjs <知识库目录> [--apply]")
const root = fs.realpathSync(projectPath)
const directory = path.join(root, "prompts")
const repo = fileURLToPath(new URL("../", import.meta.url))
const apply = process.argv.includes("--apply")
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex")

/** 直接复用当前默认模板及渲染器，迁移不在模型调用时添加兼容提示。 */
function loadTemplates() {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(repo, "src/lib/ingest-prompts.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const sandbox = { exports: {}, require: (id) => {
    if (id === "@/commands/fs") return {}
    if (id.endsWith(".md?raw")) return { default: fs.readFileSync(path.resolve(repo, "src/lib", id.slice(0, -4)), "utf8") }
    throw new Error(`迁移不支持的导入：${id}`)
  } }
  vm.runInNewContext(compiled, sandbox)
  return sandbox.exports
}

const { renderIngestPromptTemplate, DEFAULT_INGEST_PROMPTS: defaults } = loadTemplates()
const language = `## 输出语言

MANDATORY OUTPUT LANGUAGE: {{language_rule}}
自然语言正文、标题和章节标题使用 {{language_rule}}。保留组织、产品、模型、数据集、工具、库、缩写、代码标识、文件名、URL、论文名、引用及没有通行译名的技术术语原始写法；来源中的既有规范译名可沿用。来源语言与输出语言不同时，来源只作为依据，生成正文仍使用 {{language_rule}}。`
const headers = {
  "01-01-来源文档分析.md": {
    schema_context: "## 项目页面规范\n根据页面类型和用途判断来源内容的归属。",
    purpose_context: "## 知识库目标与收录范围",
  },
  "01-02-长文分块分析.md": {
    purpose_context: "## 知识库目标与收录范围", schema_context: "## 项目页面规范",
  },
  "02-01-Wiki页面生成.md": {
    purpose_context: "## 知识库目标与收录范围",
  },
  "03-01-待审查事项分析.md": {
    purpose_context: "## 知识库目标与收录范围", index_context: "## 已有知识库目录", source_context: "## 原始来源身份",
  },
}
const generationData = defaults.generationTemplate.slice(
  defaults.generationTemplate.indexOf("用户消息以 JSON 提供"), defaults.generationTemplate.indexOf("## Output Format"),
)
const linkRule = defaults.generationTemplate.split("\n")[0]
const snapshots = new Map()
const updates = new Map()
const routineContextBoundary = /^\{\{[#/](?:schema|schema_context|purpose_context|index_context|overview_context|source_context)\}\}(?:\r?\n|$)/gm

/** 来源分析和生成不再使用旧库目录；已知旧章节随变量退役，自定义正文保留。 */
function retireDraftLookupContext(content) {
  return content.replace(/^## (?:已有知识库目录|已有页面目录|知识库概览|Current Wiki Index[^\n]*|Current Overview[^\n]*)\r?\n(?:(?!^## )[^\n]*\n)*?\{\{(?:index_context|overview_context)\}\}(?:\r?\n|$)/gm, "")
    .replaceAll("{{index_context}}", "").replaceAll("{{overview_context}}", "")
}

/** 移除已下线的摘要开关和路径变量，保留知识页来源要求及自定义正文。 */
function retireSourceSummaryInstructions(content) {
  return content
    .replace(/\{\{#来源摘要生成要求\}\}\r?\n[\s\S]*?\{\{\/来源摘要生成要求\}\}(?:\r?\n|$)/g, "")
    .replace(/\{\{[#/]来源摘要关闭\}\}(?:\r?\n|$)/g, "")
    .replaceAll("{{来源摘要生成要求}}", "不生成来源摘要页；知识页 sources 直接引用原始文档。")
    .replaceAll("{{来源摘要关闭}}", "")
    .replace(/^.*\{\{summary_path\}\}.*(?:\r?\n|$)/gm, "")
    .replaceAll("本次项目关闭来源摘要：", "")
    .replaceAll("\n2. 针对分析中 ", "\n1. 针对分析中 ")
    .replaceAll("\n3. 为 wiki/log.md", "\n2. 为 wiki/log.md")
    .replaceAll("来源摘要是否生成由项目选项决定，默认不生成；", "不生成来源摘要；")
    .replaceAll("；仅显式开启来源摘要时，该应用维护页使用 source", "")
    .replaceAll("来源摘要为可选应用维护页，不要求加入业务类型表，也不要求生成摘要才能通过验收。知识页的 sources 指向原文。", "新入库不生成来源摘要页，知识页通过 sources 追溯原文；不要建议补建来源摘要。历史 type: source 页面可保留，不要求加入业务类型表。")
    .replaceAll("来源摘要为可选应用维护页，type: source 不要求加入业务类型表；来源摘要缺失不属于待审阅问题，知识页通过 sources 追溯原文。", "新入库不生成来源摘要页，知识页通过 sources 追溯原文；不要建议补建来源摘要。历史 type: source 页面可保留，不要求加入业务类型表。")
}

/** 保留自定义正文，仅补出已知旧变量原先承载的标题及说明。 */
function prepare(name, transform) {
  const file = path.join(directory, name)
  if (!fs.existsSync(file)) return
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`拒绝改写符号链接：${file}`)
  const before = fs.readFileSync(file, "utf8")
  let after = retireSourceSummaryInstructions(transform(before)).replace(routineContextBoundary, "")
  if (name.startsWith("01-") || name.startsWith("02-")) after = retireDraftLookupContext(after)
  snapshots.set(name, before)
  if (after !== before) updates.set(name, after.endsWith("\n") ? after : `${after}\n`)
}

for (const [name, slots] of Object.entries(headers)) prepare(name, (content) => {
  if (!content.includes("MANDATORY OUTPUT LANGUAGE: {{language_rule}}")) content = content.replaceAll("{{language_rule}}", language)
  for (const [slot, title] of Object.entries(slots)) {
    if (content.includes(`{{#${slot}}}`) || content.includes(title.split("\n")[0])) continue
    // 已有自定义章节时保留其标题，只给尚无章节的裸变量补充说明。
    content = content.replaceAll(`{{${slot}}}`, (value, offset) =>
      /(?:^|\n)#{1,6} [^\n]+\n(?:[^\n{}]*\n)*$/u.test(content.slice(0, offset)) ? value : `${title}\n${value}`)
  }
  if (name === "01-01-来源文档分析.md" && !content.includes("source_identity、folder_context 和 source")) {
    content += "\n\n用户消息以 JSON 提供 source_identity、folder_context 和 source；source 是本次来源正文。\n"
  }
  if (name === "01-02-长文分块分析.md" && !content.includes("chunk.main")) {
    content += "\n\n用户消息以 JSON 提供来源身份、文件夹提示、当前 chunk 和 global_digest。chunk.main 是本次主片段，chunk.overlapBefore 仅用于衔接；global_digest 为空时表示尚无先前摘要。只返回规定的两个分析章节，不把仅出现在重叠部分的内容当作当前片段的新事实。\n"
  }
  if (name === "02-01-Wiki页面生成.md") {
    if (!content.includes(linkRule)) content = `${linkRule}\n\n${content}`
    if (!content.includes("{{completed_paths}}")) {
      const anchor = content.search(/^##\s*(?:输出格式|Output Format)/m)
      content = anchor >= 0 ? content.slice(0, anchor) + generationData + content.slice(anchor) : `${content}\n${generationData}`
    }
  }
  return content
})
prepare("04-01-页面合并任务.md", (s) => s.includes("previously_collected_material") ? s : `${s.trimEnd()}\n\n用户消息以 JSON 提供 previously_collected_material（已有材料）与 additional_material（新增材料），各自包含 provenance 和 content。按实际来源归属合并材料，不把材料容器的先后顺序当成来源优先级。\n`)
prepare("06-01-最终验收规则.md", (s) => s.includes("sourceStartLine") ? s : `${s.trimEnd()}\n\n用户消息以 JSON 提供 sourceIdentity、sourceStartLine、source、sourceScope、schema、purpose、pages、knownPagePaths 和应用维护类型信息。sourceScope 为 complete 时提供完整原文，为 fragment 时仅提供从 sourceStartLine 开始的片段。片段中未出现的内容不能据此判为整份来源无依据；其他来源贡献和入库前已有内容不能仅因当前来源未提及而要求删除。\n`)

for (const [name, key] of Object.entries({
  "01-04-交互来源分析.md": "interactiveAnalysisTemplate", "02-04-截断页面修复.md": "truncatedRepairTemplate",
  "02-05-会话页面生成.md": "interactiveGenerationTemplate", "04-03-页面主题核对.md": "pageMatchTemplate",
})) {
  if (fs.existsSync(path.join(directory, name))) {
    prepare(name, (content) => content)
    continue
  }
  snapshots.set(name, null)
  updates.set(name, defaults[key])
}

// 验证所有已知状态下的变量与条件块，保留用户已有的规则文件引用。
const values = {
  language_rule: "Chinese", schema_context: "SCHEMA", purpose_context: "PURPOSE", index_context: "INDEX", overview_context: "OVERVIEW",
  schema: "SCHEMA", source_identity: "source.md", today: "2026-10-24",
  独立成页与名称复用规则: "RULE", 独立成页与名称复用规则_列表: "RULE", 独立页面写作规则: "RULE",
  待审查事项筛选规则: "RULE", 页面内容合并规则: "RULE", 业务模块选择规则: "RULE",
  completed_paths: '["wiki/topics/example.md"]',
  source_context: "source.md", analysis: "ANALYSIS", source: "SOURCE", generation: "GENERATION", module_dictionary: "{}",
}
for (const [name, content] of updates) {
  if (name !== "06-01-最终验收规则.md") {
    renderIngestPromptTemplate(content, values)
    renderIngestPromptTemplate(content, { ...values, schema_context: "", purpose_context: "", index_context: "", overview_context: "", schema: "", completed_paths: "" })
  }
  const before = snapshots.get(name)
  if (before === null) continue
  for (const [, key] of before.matchAll(/\{\{([^{}#/]+)\}\}/g)) {
    const retired = ["来源摘要生成要求", "来源摘要关闭", "summary_path"]
    if (name.startsWith("01-") || name.startsWith("02-")) retired.push("index_context", "overview_context")
    if (!retired.includes(key) && !content.includes(`{{${key}}}`)) throw new Error(`变量丢失：${name} ${key}`)
  }
}

const report = { project: root, applied: apply, updated: [...updates.keys()].filter((name) => snapshots.get(name) !== null), created: [...updates.keys()].filter((name) => snapshots.get(name) === null) }
if (!apply || !updates.size) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}
const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date()).replace(/[-: ]/g, "")
const backup = path.join(root, ".llm-wiki/prompt-backups", `${stamp}-data-only`)
fs.mkdirSync(backup, { recursive: true })
for (const [name, before] of snapshots) if (before !== null) fs.writeFileSync(path.join(backup, name), before, { flag: "wx", mode: 0o600 })
for (const [name, before] of snapshots) {
  const file = path.join(directory, name)
  if (before === null ? fs.existsSync(file) : fs.readFileSync(file, "utf8") !== before) throw new Error(`迁移期间文件发生变化：${name}`)
}
const written = []
try {
  for (const [name, content] of updates) {
    const file = path.join(directory, name)
    const temp = `${file}.${process.pid}.data-only.tmp`
    try { fs.writeFileSync(temp, content, { flag: "wx" }); fs.renameSync(temp, file) }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
    written.push(name)
  }
  for (const [name, content] of updates) if (fs.readFileSync(path.join(directory, name), "utf8") !== content) throw new Error(`落盘校验失败：${name}`)
  const hashes = [...updates].map(([name, content]) => ({ name, beforeSha256: snapshots.get(name) === null ? null : sha(snapshots.get(name)), afterSha256: sha(content) }))
  fs.writeFileSync(path.join(backup, "manifest.json"), `${JSON.stringify({ ...report, backup, hashes }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  console.log(JSON.stringify({ ...report, backup }, null, 2))
} catch (error) {
  for (const name of written) {
    const file = path.join(directory, name)
    if (fs.readFileSync(file, "utf8") !== updates.get(name)) continue
    const before = snapshots.get(name)
    if (before === null) fs.unlinkSync(file)
    else fs.writeFileSync(file, before)
  }
  throw error
}
