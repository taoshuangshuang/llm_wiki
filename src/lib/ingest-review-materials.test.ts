/** 验证模型上下文不夹带原始关系、查询正文或详细检索追踪。 */
import { describe, expect, it } from "vitest"
import { reviewRetrievalContext } from "./ingest-review-materials"
import type { RetrievalResult } from "./evidence-retrieval"

describe("审阅检索上下文", () => {
  it("仅投影检索范围与执行状态，完整诊断仍保留在原始结果中", () => {
    const retrieval: RetrievalResult = {
      status: "completed", evidence: [], relations: [{
        id: "relation-2045", fromPath: "wiki/topics/source.md", fromRevision: "sha256:source",
        toPath: "wiki/topics/target.md", targetText: "目标", kind: "wikilink",
        range: { startLine: 3, endLine: 3 }, nearbyText: "仅存在于关系记录中的文字。",
        resolution: "resolved", usedForRecall: false,
      }], targetResults: [{ targetId: "page-0", status: "no_match", evidenceIds: [] }], execution: {
        configVersion: "test", queries: [{ id: "query-0", targetId: "page-0", text: "完整检索查询", title: "独立标题查询" }], channelStates: [],
        warnings: [], budgetReached: [], elapsedMs: 1,
        usage: { candidates: 1, queries: 1, contextChars: 0, readChars: 0 }, trace: [{ event: "完整检索追踪" }],
      },
    }
    const before = structuredClone(retrieval)
    const context = reviewRetrievalContext(retrieval)
    expect(context).toEqual({ targetResults: retrieval.targetResults, execution: {
      configVersion: "test", queries: [{ id: "query-0", targetId: "page-0" }], channelStates: [],
      warnings: [], budgetReached: [], elapsedMs: 1, usage: retrieval.execution.usage,
    } })
    expect(context).not.toHaveProperty("relations")
    expect(context.execution).not.toHaveProperty("trace")
    expect(context.execution.queries[0]).not.toHaveProperty("text")
    expect(context.execution.queries[0]).not.toHaveProperty("title")
    expect(retrieval).toEqual(before)
  })
})
