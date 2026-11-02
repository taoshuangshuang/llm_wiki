/** 后台审阅的检索上下文投影：只提供执行范围，原始关系保留在诊断记录中。 */
import type { RetrievalResult } from "./evidence-retrieval"

/** 模型只接收检索范围及执行状态；关系结构、检索查询原文和附近文字留在运行记录中。 */
export function reviewRetrievalContext(retrieval: RetrievalResult) {
  const { trace: _trace, channelResults: _channels, corpusVersion: _corpus, queries, ...execution } = retrieval.execution
  return {
    targetResults: retrieval.targetResults,
    execution: { ...execution, queries: queries.map(({ text: _text, title: _title, ...query }) => query) },
  }
}

