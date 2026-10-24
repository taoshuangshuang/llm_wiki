/** 入库语义候选召回：复用向量库，并补查本批次尚未索引的页面；相似度不代表可合并。 */
import { fetchEmbedding, getLastEmbeddingError, vectorSearchChunks, wikiPageIdFromPath } from "@/lib/embedding"
import { parseFrontmatter } from "@/lib/frontmatter"
import type { EmbeddingConfig } from "@/stores/wiki-store"

const CANDIDATE_LIMIT = 8
const MIN_LOCAL_COSINE = 0.68

/** 只允许真实知识页作为合并候选，排除摘要、导航及不安全路径。 */
export function isSemanticKnowledgePath(path: string): boolean {
  return path.startsWith("wiki/") && /\.md$/i.test(path) &&
    !/[\\\x00-\x1f]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..") &&
    !path.startsWith("wiki/sources/") && !/(?:^|\/)(?:index|overview|log)\.md$/i.test(path)
}

/** 查询文本只用于候选召回；后续判断必须读取完整正文。 */
export function semanticPageQuery(content: string): string {
  const { frontmatter, body } = parseFrontmatter(content)
  return [frontmatter?.title, frontmatter?.description, body.slice(0, 2_000)]
    .filter((part) => typeof part === "string" && part.trim()).join("\n")
}

/** 计算临时页面与查询的余弦相似度；维度不兼容时拒绝命中。 */
function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || !left.length) return -1
  let dot = 0
  let a = 0
  let b = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    a += left[index] ** 2
    b += right[index] ** 2
  }
  return a && b ? dot / Math.sqrt(a * b) : -1
}

/** 每次写入调用独立创建，固定项目及配置，避免项目切换或并发入库串用临时页面。 */
export class IngestSemanticRecall {
  private readonly recent = new Map<string, { content: string; embedding?: number[] }>()

  constructor(
    private readonly projectPath: string,
    private readonly config: EmbeddingConfig,
    private readonly warn: (message: string) => void,
    private readonly signal?: AbortSignal,
  ) {}

  /** 记住实际写入的完整正文，合并后清除旧的临时向量，按需重新生成。 */
  remember(path: string, content: string): void {
    if (this.config.enabled && isSemanticKnowledgePath(path)) this.recent.set(path, { content })
  }

  private checkCancelled(): void {
    if (this.signal?.aborted) throw new Error("入库语义检索已取消")
  }

  /** 按真实文件清单解析索引身份，返回持久库与本批次候选；服务异常明确降级。 */
  async find(query: string, knownPaths: string[], exclude: string[] = []): Promise<string[]> {
    this.checkCancelled()
    if (!this.config.enabled) return []
    const eligible = knownPaths.filter((path) => isSemanticKnowledgePath(path) && !exclude.includes(path))
    if (!eligible.length) return []
    try {
      if (!this.config.model || !this.config.endpoint) throw new Error("Embedding 模型或服务地址未配置")
      const vector = await fetchEmbedding(query, this.config)
      this.checkCancelled()
      if (!vector) throw new Error(getLastEmbeddingError() ?? "查询向量生成失败")
      const scores = new Map<string, number>()
      const byId = new Map<string, string>()
      const byStem = new Map<string, string[]>()
      for (const path of eligible) {
        byId.set(wikiPageIdFromPath(this.projectPath, path), path)
        const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")
        byStem.set(stem, [...(byStem.get(stem) ?? []), path])
      }
      try {
        // 库中 score 为 1/(1+L2距离)，仅用于排序，不套用余弦相似度阈值。
        const chunks = await vectorSearchChunks(this.projectPath, vector, 80)
        this.checkCancelled()
        for (const chunk of chunks) {
          const legacy = byStem.get(chunk.page_id)
          const path = byId.get(chunk.page_id) ?? (legacy?.length === 1 ? legacy[0] : undefined)
          if (path && Number.isFinite(chunk.score)) scores.set(path, Math.max(scores.get(path) ?? -1, chunk.score))
        }
      } catch (error) {
        this.checkCancelled()
        this.warn(`向量库检索降级：${error instanceof Error ? error.message : String(error)}；继续检查本批次页面`)
      }
      const localScores = new Map<string, number>()
      for (const [path, page] of this.recent) {
        if (!eligible.includes(path)) continue
        page.embedding ??= await fetchEmbedding(semanticPageQuery(page.content), this.config) ?? undefined
        this.checkCancelled()
        if (!page.embedding) {
          this.warn(`本批次页面语义检查降级：${path}：${getLastEmbeddingError() ?? "向量生成失败"}`)
          continue
        }
        const similarity = cosine(vector, page.embedding)
        if (similarity >= MIN_LOCAL_COSINE) localScores.set(path, similarity)
      }
      const topPaths = (ranked: Map<string, number>) => [...ranked]
        .sort((left, right) => right[1] - left[1]).slice(0, CANDIDATE_LIMIT).map(([path]) => path)
      return [...new Set([...topPaths(scores), ...topPaths(localScores)])]
    } catch (error) {
      this.checkCancelled()
      this.warn(`语义检查降级：${error instanceof Error ? error.message : String(error)}；未命中不代表不存在重复`)
      return []
    }
  }
}
