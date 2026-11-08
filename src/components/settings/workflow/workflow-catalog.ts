/** 知识流程的用户契约：节点顺序、职责、配置唯一归属及修改影响。 */
import type { IngestPrompts } from "@/lib/ingest-prompts"
import type { ParameterSection } from "../settings-persistence"

export type WorkflowStageId = "common" | "preprocess" | "analysis" | "generation" | "write" | "review" | "retrieval" | "output"
export type InlineSection = "llm" | "retrieval" | "web-search" | "review-migration" | "variables"
export type ProjectDocument = "purpose.md" | "schema.md" | "page-rules.md" | "business-modules.md" | "code-sources.json"
export interface WorkflowFile { title: string; description?: string; prompt?: keyof IngestPrompts; document?: ProjectDocument }
export interface WorkflowNode {
  id: string
  title: string
  description: string
  input: string
  output: string
  impact: string
  condition?: string
  scope?: string
  parameter?: ParameterSection
  inline?: InlineSection
  files?: WorkflowFile[]
  references?: string[]
}
export interface WorkflowStage {
  id: WorkflowStageId
  title: string
  description: string
  nodes: WorkflowNode[]
}

export const WORKFLOW_STAGES: WorkflowStage[] = [
  { id: "common", title: "公共设置", description: "为后续节点提供共同配置；每项注明实际生效范围。", nodes: [
    { id: "purpose", title: "知识库目标", description: "定义知识库用途、收录范围与领域约定。", input: "用户定义的知识目标", output: "供分析、生成与审阅使用的项目背景", impact: "影响后续相关模型判断，不自动清理已有页面。", scope: "当前项目", files: [{ title: "知识库目标与收录范围", description: "说明知识库要收录什么，以及分析、生成和审阅应遵循的项目目标。", document: "purpose.md" }] },
    { id: "schema", title: "页面类型与通用约束", description: "定义页面类型、目录路由及项目通用规则。", input: "类型与领域约束", output: "分析、生成、目录校验及问答使用的核心 Schema", impact: "同时影响后续入库和问答；已有页面不会因保存自动迁移。", scope: "当前项目", files: [{ title: "核心 Schema", description: "定义页面类型、存储目录和各阶段共同遵守的领域约束。", document: "schema.md" }] },
    { id: "business-types", title: "业务类型与模块字典", description: "维护业务模块、绑定仓库和模块或包范围，供页面分类、业务树展示与冲突源码核验使用。", input: "业务模块标识、名称、说明、层级及源码绑定", output: "页面业务分类字典、业务树及冲突核验使用的源码范围", impact: "字典和源码绑定分别保存；子模块可继承仓库并指定模块或包范围。绑定用于后续冲突源码核验，已有事项可手动核验；保存不会自动重跑已完成的检查。已有页面标签需重新分类后更新，页面类型和存储目录沿用原规则。", files: [{ title: "业务模块字典", description: "维护模块分类依据，并在模块详情绑定仓库和代码范围，供冲突源码核验使用。", document: "business-modules.md" }], scope: "当前项目" },
    { id: "vector-store", title: "向量库配置", description: "统一配置向量模型、连接、分块与批量参数，管理当前项目向量索引。", input: "向量服务地址、模型、访问凭据与分块参数", output: "向量索引构建和语义检索使用的有效配置", impact: "同时影响入库后的向量构建、候选匹配、后台审阅与问答检索；更换模型、维度或分块参数后需重建历史索引。", parameter: "embedding", scope: "全应用配置；索引按项目保存" },
    { id: "models", title: "模型与任务路由", description: "配置模型连接、全局默认、项目覆盖及不同任务使用的模型。", input: "可用模型与连接凭据", output: "各任务的有效模型配置", impact: "影响后续模型请求；不会重新执行已完成任务。", inline: "llm", scope: "应用默认 / 项目覆盖" },
    { id: "network", title: "公共网络代理", description: "配置应用出站请求使用的网络代理。", input: "代理地址及访问选项", output: "模型、解析和外部检索请求的网络环境", impact: "同时影响应用其他出站请求，下一次请求使用新配置。", parameter: "network", scope: "全应用" },
    { id: "variables", title: "变量与配置说明", description: "说明提示词变量从哪里来、哪些节点可用，以及配置何时生效。", input: "项目配置与本次任务上下文", output: "运行时注入模板的数据", impact: "变量说明本身不改变运行行为；各节点只接受其实际支持的变量。", inline: "variables" },
  ] },
  { id: "preprocess", title: "文件预处理", description: "发现来源、筛选文件并提取正文和图片信息。", nodes: [
    { id: "monitoring", title: "来源发现与触发", description: "监控来源目录变化，决定是否自动提交入库任务。", input: "raw/sources 下的新增或修改文件", output: "来源变更与待处理任务", impact: "影响后续外部文件变更的发现与自动入库，不控制手动入库按钮。", parameter: "monitoring", scope: "当前项目；跨项目监控开关为全应用" },
    { id: "filters", title: "文件筛选", description: "按文件类型、目录、匹配模式与大小决定来源是否进入处理。", input: "来源路径、扩展名和文件大小", output: "允许处理的文件或跳过原因", impact: "目录导入和自动发现遵守允许列表；手动选文件绕过允许列表，仍遵守排除规则和大小上限。", parameter: "filters", scope: "当前项目" },
    { id: "schedule", title: "定时导入", description: "定期扫描指定目录并提交符合条件的来源。", input: "扫描目录、间隔和来源筛选规则", output: "新增或变化来源的入库任务", impact: "影响后续扫描，不重做已有页面。", parameter: "scheduled-import", references: ["filters"], scope: "当前项目" },
    { id: "preparation", title: "任务准备与执行", description: "配置文档解析数量，并按需保留提取文本；入库与审阅固定串行。", input: "待处理来源队列", output: "供后续分析使用的提取文本", impact: "并发影响资源占用；保留 Markdown 控制 raw/parsed 可见副本，不改变正文写作规则。", parameter: "processing", scope: "当前项目" },
    { id: "parsing", title: "文档正文提取", description: "提取文档正文、表格和公式；PDF 可使用 MinerU，失败时按现有策略回退。", input: "原始文档", output: "可供模型分析的文本及图片引用", impact: "影响后续提取结果；历史解析缓存不会仅因保存配置全部重建。", parameter: "mineru", scope: "全应用；MinerU 主要用于 PDF" },
    { id: "images", title: "图片提取与理解", description: "提取配图，并通过视觉模型补充图片文字描述。", input: "来源图片及附近文本", output: "图片文件、引用和描述", impact: "影响后续图片理解；图片描述使用内置提示词，已有描述可能命中缓存。", condition: "存在图片且启用相关能力时执行", parameter: "multimodal", scope: "全应用", references: ["models", "language"] },
  ] },
  { id: "analysis", title: "分析规划", description: "理解来源并规划页面，长文按需分块处理。", nodes: [
    { id: "source-analysis", title: "来源分析", description: "识别来源中的知识、主题关系及候选页面。", input: "来源正文、项目目标和核心 Schema", output: "供页面生成使用的分析结果", impact: "影响后续分析结果；缓存命中时可能跳过，保存不会自动重新分析。", files: [{ title: "来源文档分析", description: "指导模型从来源原文识别知识、主题关系及候选页面。", prompt: "analysisTemplate" }, { title: "交互来源分析（交互入口）", description: "用于交互式来源分析，结合项目目标与页面规范整理来源知识。", prompt: "interactiveAnalysisTemplate" }], references: ["purpose", "schema", "page-planning", "models", "language"], scope: "当前项目" },
    { id: "chunk-analysis", title: "长文分块分析", description: "逐块分析长文，携带前序摘要；分析截断时按需细分恢复。", input: "当前片段、重叠上下文和累计摘要", output: "分块分析与全文摘要", impact: "影响后续长文分析；分块预算及有限恢复由程序控制。", condition: "来源超出预算或普通分析截断时执行", files: [{ title: "长文分块分析", description: "规定长文每个分块的分析内容，以及跨块摘要如何累积。", prompt: "chunkAnalysisTemplate" }], references: ["page-planning", "models", "schema", "purpose", "language"], scope: "当前项目" },
    { id: "page-planning", title: "成页规划与来源命名", description: "作为分析请求内的规则，仅依据来源判断成页条件并统一本次命名。", input: "来源事实与项目规范", output: "分析中的成页建议", impact: "同时影响普通分析和长文分析；这是嵌入规则，不独立调用模型。", files: [{ title: "独立成页与名称复用规则", description: "指导普通分析和长文分析判断独立成页条件及本次来源命名。", prompt: "analysis" }], scope: "当前项目" },
  ] },
  { id: "generation", title: "页面生成", description: "根据分析生成知识页，按需续传未完成内容。", nodes: [
    { id: "page-generation", title: "知识页面生成", description: "按分析、来源及写作规范生成完整知识页，保留来源归属。", input: "分析结果、来源正文、项目规范", output: "待匹配与写入的完整页面块", impact: "影响后续生成的页面；保存不会改写已有页面，需要重新入库应用。", files: [{ title: "Wiki 页面生成", description: "依据来源和分析结果生成符合项目规范的完整 Wiki 页面块。", prompt: "generationTemplate" }, { title: "独立页面写作规则", description: "约定独立页面的主题边界、命名与正文写作方式。", prompt: "generation" }, { title: "会话页面生成（交互入口）", description: "将交互会话确认的知识整理为可写入的 Wiki 页面。", prompt: "interactiveGenerationTemplate" }], references: ["writing-rules", "schema", "language", "purpose", "models"], scope: "当前项目" },
    { id: "writing-rules", title: "页面写作规范", description: "定义命名、元数据、交叉引用等页面规范。", input: "项目写作约定", output: "生成和来源内容校验共享的写作规范", impact: "同时影响后续页面生成和内容校验；不会自动修复已有页面。", files: [{ title: "页面写作规范", description: "约定页面命名、元数据字段及交叉引用，供生成与内容校验共同使用。", document: "page-rules.md" }], scope: "当前项目" },
    { id: "repair", title: "截断与继续补写", description: "保留已完成页面，只继续尚未完成的输出。", input: "未完成内容、来源上下文与已完成路径", output: "可继续提交的完整页面块", impact: "影响后续截断补写；完成记录与版本保护由程序执行。", condition: "生成截断或部分写入时执行", files: [{ title: "截断页面修复", description: "指导模型补齐指定路径的截断内容，返回完整页面块。", prompt: "truncatedRepairTemplate" }], references: ["page-generation", "models", "language"], scope: "当前项目" },
  ] },
  { id: "write", title: "匹配与写入", description: "匹配已有页面、整合内容并可靠提交，更新知识索引。", nodes: [
    { id: "candidates", title: "已有页面候选查找", description: "结合同路径、同名与共享检索寻找可能承载新内容的页面。", input: "新生成页面及已有页面清单", output: "交给主题核对的候选页", impact: "共享检索修改也影响审阅、问答和搜索；无检索命中不代表没有相关页面。", references: ["local-retrieval"] },
    { id: "topic-match", title: "页面主题核对", description: "读取候选正文，判断是否为同一主题并选择目标；目标不明确时另存。", input: "新页面与候选页面正文", output: "合并目标或独立建页判断", impact: "影响后续目标选择，不自动调整已有页面归属。", files: [{ title: "页面主题核对", description: "核对新稿与候选旧页的主题是否一致，决定合并目标或独立建页。", prompt: "pageMatchTemplate" }], condition: "存在需要核对的候选时执行", scope: "当前项目", references: ["models"] },
    { id: "merge", title: "页面内容合并", description: "整合新旧页面事实；实际失败修复一轮，仍失败保留旧页与完整新稿供人工核查。", input: "选定旧页、新稿与来源信息", output: "待写入正文及合并处理事件", impact: "影响后续内容取舍；保存配置不会重写已合并页面。", files: [{ title: "页面合并任务", description: "组织已有正文、新稿与来源信息，要求返回完整合并结果。", prompt: "mergeTemplate" }, { title: "页面内容合并规则", description: "约定新旧事实如何保留、去重和整合，以及如何处理内容分歧。", prompt: "merge" }], condition: "需要整合已有内容时执行", scope: "当前项目", references: ["models"] },
    { id: "classification", title: "业务模块分类", description: "基于最终页面正文选择业务模块，分类失败保留正文。", input: "最终页面、模块字典与选择规则", output: "module/ 业务标签", impact: "影响业务标签，不决定页面类型和目录；重新入库缓存命中时也可刷新分类。", files: [{ title: "业务模块分类", description: "指导模型根据页面最终正文，从业务模块字典中返回分类标识。", prompt: "classificationTemplate" }, { title: "业务模块选择规则", description: "约定业务模块的选择依据，减少无依据或过度分类。", prompt: "classification" }], condition: "项目配置了业务模块字典时执行", scope: "当前项目", references: ["business-types", "models"] },
    { id: "commit", title: "页面提交与图片归位", description: "保存提交意图、核对页面版本并原子写入，保留快照和配图引用。", input: "最终页面正文、配图及预期版本", output: "已落盘页面、处理事件与恢复记录", impact: "由程序自动执行；版本校验与快照保护不能通过提示词关闭。" },
    { id: "references", title: "全库引用维护", description: "页面写入完成、格式检查之前，程序根据明确的目标映射维护正文链接和 related，无需调用模型。", input: "已落盘页面、持久化的 A → B 映射，以及共享关系索引的出链、入链和未解析引用依赖", output: "本轮页面及受影响历史页面的引用更新、提交快照和增量关系索引", impact: "A 仍保留时维持原引用；A 归并到 B 后检查 B 的章节，章节不存在则退回页面链接，保留显示文字。没有映射的缺失目标照常写入，交格式检查转待审阅，不创建占位页。先保存目标再按版本提交引用方；中断后复用映射和提交记录继续维护。", references: ["commit", "format-check", "embedding"] },
    { id: "index", title: "目录索引与链接更新", description: "维护实际落盘页面的导航目录索引；链接关系由全库引用维护节点统一处理。", input: "实际写入路径及正文", output: "最新导航索引与链接", impact: "由程序自动执行；仅更新索引不等于重新生成知识正文。" },
    { id: "embedding", title: "向量索引构建", description: "为已写入页面分块并建立向量索引，供后续语义检索使用。", input: "实际页面正文、向量模型和分块参数", output: "页面向量及索引状态", impact: "影响后续向量构建；更换模型、维度或分块参数后，需重建历史索引。", condition: "启用 Embedding 时执行", references: ["vector-store"] },
  ] },
  { id: "review", title: "后台审阅", description: "页面写入后独立执行；发现冲突时可自动结合绑定源码核验。审阅失败不回退已写入页面，可单独重试。", nodes: [
    { id: "format-check", title: "页面格式检查", description: "检查 YAML、必要字段、页面类型、目录归属及引用目标和章节是否存在。", input: "实际落盘页和项目 Schema", output: "一轮规范化及复查记录，失败转人工", impact: "检查由程序执行；缺页、缺章节和名称歧义转待审阅，不调用模型补页，不自动创建占位页；同一问题去重。项目类型和目录约束在公共设置中编辑。", references: ["schema"] },
    { id: "coverage-check", title: "来源内容覆盖检查", description: "对照来源快照与实际写入页，识别遗漏与失真；部分入库不把待补写内容判成遗漏。", input: "固定来源快照、写入后页面及项目规范", output: "关键内容修复记录，材料不足或失败转人工", impact: "可通过重新审阅应用规则，不必重新生成页面。", files: [{ title: "来源内容校验（现有最终验收规则）", description: "对照来源快照与实际落盘页，识别关键内容的遗漏与失真。", prompt: "acceptance" }], references: ["writing-rules", "purpose", "models", "schema"], scope: "当前项目" },
    { id: "knowledge-check", inline: "review-migration", title: "已有知识核对与共用规则", description: "检索相关已有知识，分项检查冲突、重复与必要的知识补充建议；发现冲突或待确认差异时，已绑定模块自动进入源码核验。", input: "本轮页面、已有知识证据及项目目标", output: "有证据和范围说明的待审阅事项，符合条件时附源码核验结果", impact: "影响已有知识核对和补充建议；保存后可重新审阅，检索范围有限时会注明。源码核验按业务模块绑定自动执行，证据不足时保留原事项。", files: [{ title: "统一后台审阅", description: "定义冲突、重复和知识补充建议的审阅要求及证据协议。", prompt: "backgroundReview" }, { title: "待审查事项筛选规则", description: "筛选有材料依据、值得人工核查的问题，避免无依据地生成待办。", prompt: "review" }], references: ["local-retrieval", "models", "purpose", "code-conflict-check"], scope: "当前项目" },
    { id: "code-conflict-check", title: "冲突源码核验", description: "发现冲突 → 匹配模块绑定 → 检索源码与调用关系 → 分析实现 → 附上代码位置和结论。优先使用现有 CodeGraph 索引。", input: "冲突或待确认差异的原文证据、页面业务标签、生效的仓库与代码范围", output: "附在原审阅事项下的核验结论、文件行号、逐字代码引用及提交版本", impact: "在业务模块字典中绑定仓库，子模块可继承并指定模块或包范围；范围内优先检索，调用链可扩展到同一仓库。没有可用 CodeGraph 时退回文本检索。核验依据当前本机实现，材料变化时标记失效；证据不足时保留待确认，不自动修改文档或关闭冲突。已完成的检查不会自动重跑，已有事项可点击「源码核验」。", condition: "发现事实冲突或待确认差异，且证据页面的业务模块已有生效的源码绑定时执行", references: ["business-types", "models", "language"], scope: "当前项目；使用当前本机源码" },
    { id: "supplement-check", title: "知识补充建议", description: "合并缺页与研究，只报告直接影响当前主题理解或使用的重要未知。", input: "本次页面、复用的检索证据及项目目标", output: "供人工按需处理的知识补充建议", impact: "同一未知只生成一条；不自动生成无依据页面；普通信息不完整不例行报待办。", references: ["knowledge-check", "purpose", "models"] },
  ] },
  { id: "retrieval", title: "检索", description: "既服务问答，也被入库匹配和后台审阅复用；不代表入库后才首次检索。", nodes: [
    { id: "local-retrieval", title: "知识库检索通道", description: "统一控制向量、关键词、索引页及图关系检索通道。", input: "问题或待匹配主题、范围和有效通道配置", output: "相关正文、关系及执行状态", impact: "同时影响入库候选查找、后台审阅、问答和搜索；项目覆盖优先于全局默认。", inline: "retrieval", references: ["vector-store", "embedding"], scope: "全应用默认 / 当前项目覆盖" },
    { id: "external-retrieval", title: "联网与本地外部检索", description: "配置联网搜索及 AnyTXT 等可用外部资料来源。", input: "搜索服务、访问凭据和外部检索范围", output: "供问答检索使用的外部材料", impact: "影响后续外部检索；不因配置服务而自动开启每次问答的联网开关。", inline: "web-search", scope: "全应用" },
    { id: "evidence", title: "候选融合与证据读取", description: "融合各通道候选，去除重复票数、读取正文并附带位置和版本。", input: "各通道候选和读取预算", output: "可引用正文、路径、位置、版本与完成范围", impact: "融合、预算及版本核验由程序执行；失败不会自动开启已关闭通道。", references: ["local-retrieval"] },
  ] },
  { id: "output", title: "输出", description: "组装问答上下文、生成回答并向用户呈现结果。", nodes: [
    { id: "context", title: "问答上下文组装", description: "结合当前问题、历史消息、检索证据及项目约束组装模型输入。", input: "当前问题、历史记录、正文证据及模型上下文容量", output: "回答模型实际接收的上下文", impact: "历史长度影响后续问答上下文，不会删除聊天记录。", references: ["language", "models", "local-retrieval"] },
    { id: "answer", title: "回答生成", description: "模型基于实际材料生成回答；工具执行、证据范围和失败状态按真实结果处理。", input: "组装后的问答上下文", output: "回答正文及工具结果", impact: "使用公共模型配置；知识页生成提示词不控制问答回答。", references: ["models", "language"] },
    { id: "language", title: "输出语言与历史长度", description: "配置 AI 输出语言和问答使用的历史消息数量。", input: "语言偏好与历史长度", output: "后续请求使用的语言与消息预算", impact: "输出语言同时影响入库生成和图片描述等相关 AI 输出；历史长度仅影响问答。", parameter: "output", scope: "语言按当前项目保存；历史长度为全应用" },
    { id: "presentation", title: "回答展示与引用", description: "展示回答、引用及工具执行结果，支持继续追问。", input: "模型输出和实际证据", output: "可阅读、可追溯的回答", impact: "由程序自动执行；应用主题和缩放请前往应用设置。" },
  ] },
]

export function findWorkflowNode(id: string): { stage: WorkflowStage; node: WorkflowNode } {
  for (const stage of WORKFLOW_STAGES) {
    const node = stage.nodes.find((entry) => entry.id === id)
    if (node) return { stage, node }
  }
  throw new Error(`未知知识流程节点：${id}`)
}
