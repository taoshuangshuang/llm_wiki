/** 入库候选召回适配：复用统一证据检索，并保留本次写入的明确材料；相似度不代表可合并。 */
import { extractPageTitle, parseFrontmatter } from "@/lib/frontmatter"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import { retrieveEvidence } from "./evidence-retrieval"
import { isIngestKnowledgePath } from "./ingest-knowledge-path"
import type { IngestProcessLog } from "./ingest-process-log"

/** 只允许真实知识页作为合并候选，排除摘要、导航及不安全路径。 */
export const isSemanticKnowledgePath = isIngestKnowledgePath

/** 查询文本只用于候选召回；后续判断必须读取完整正文。 */
export function semanticPageQuery(content: string): string {
  const { frontmatter, body } = parseFrontmatter(content)
  return [frontmatter?.title, frontmatter?.description, body.slice(0, 2_000)]
    .filter((part) => typeof part === "string" && part.trim()).join("\n")
}

/** 每次写入调用独立创建，固定项目及配置，避免项目切换或并发入库串用临时页面。 */
export class IngestSemanticRecall {
  private readonly recent = new Set<string>()

  constructor(
    private readonly projectPath: string,
    _config: EmbeddingConfig,
    private readonly warn: (message: string) => void,
    private readonly signal?: AbortSignal,
    private readonly processLog?: IngestProcessLog,
  ) {}

  /** 本次已提交页属于调用方明确材料，尚未建立向量索引时仍可核对。 */
  remember(path: string, _content: string): void {
    if (!isSemanticKnowledgePath(path)) return
    this.recent.add(path)
  }

  private checkCancelled(): void {
    if (this.signal?.aborted) throw new Error("入库语义检索已取消")
  }

  /** 按真实文件清单解析索引身份，返回持久库与本批次候选；服务异常明确降级。 */
  async find(content: string, knownPaths: string[], exclude: string[] = []): Promise<string[]> {
    this.checkCancelled()
    const eligible = knownPaths.filter((path) => isSemanticKnowledgePath(path) && !exclude.includes(path))
    if (!eligible.length) return []
    try {
      const retrieval = await retrieveEvidence({
        projectPath: this.projectPath, scene: "ingest", targets: [{ id: "page-target", text: semanticPageQuery(content), title: extractPageTitle(content) }],
        scope: { corpus: "wiki", includePaths: eligible },
      }, this.processLog)
      this.checkCancelled()
      if (retrieval.status !== "completed") this.warn(`页面候选检索${retrieval.status}；未命中不代表不存在重复`)
      return [...new Set([...retrieval.evidence.map((entry) => entry.path), ...this.recent.keys()])].filter((path) => eligible.includes(path))
    } catch (error) {
      this.checkCancelled()
      this.warn(`页面候选检索失败：${error instanceof Error ? error.message : String(error)}`)
      return [...this.recent.keys()].filter((path) => eligible.includes(path))
    }
  }
}
