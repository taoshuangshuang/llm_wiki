import { describe, expect, it } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import type { IngestRun } from "./ingest-run"
import { hasOnlyOptionalReviewFailures, needsReviewAttention, reviewImportance } from "./review-priority"

describe("各入口共用的重要待审口径", () => {
  it("质量问题提示审阅，研究建议和两种缺页均为非重要", () => {
    for (const type of ["merge", "structure", "coverage", "contradiction", "duplicate", "confirm"] as const) {
      expect(reviewImportance({ type })).toBe("important")
    }
    for (const type of ["suggestion", "missing-page"] as const) expect(reviewImportance({ type })).toBe("optional")
    const issue: ReviewItem = { id: "issue", type: "coverage", title: "遗漏", description: "依据", options: [], resolved: false, createdAt: 0 }
    expect(needsReviewAttention(issue)).toBe(true)
    for (const state of [{ resolved: true }, { historical: true }, { hidden: true }, { type: "suggestion" as const }, { type: "missing-page" as const }]) {
      expect(needsReviewAttention({ ...issue, ...state })).toBe(false)
    }
  })

  const cases: { name: string; statuses: Record<string, "complete" | "incomplete">; expected: boolean }[] = [
    { name: "新合并检查完成", statuses: { "existing-knowledge": "complete" }, expected: true },
    { name: "新合并检查失败", statuses: { "existing-knowledge": "incomplete" }, expected: false },
    { name: "旧报告两项均完成", statuses: { "existing-conflict": "complete", duplicate: "complete" }, expected: true },
    { name: "旧完成结果不能覆盖新失败", statuses: { "existing-conflict": "complete", duplicate: "complete", "existing-knowledge": "incomplete" }, expected: false },
    { name: "新分段有一段未完成", statuses: { "existing-knowledge:segment-1": "complete", "existing-knowledge:segment-2": "incomplete" }, expected: false },
  ]

  it.each(cases)("仅建议失败时按实际重要检查状态判断：$name", ({ statuses, expected }) => {
    const run: IngestRun = {
      version: 1, runId: "test", projectId: "test", sourcePath: "raw/sources/a.md", sourceIdentity: "a.md", sourceRevision: "source",
      attempt: 1, createdAt: 0, updatedAt: 0, writeStatus: "complete", reviewStatus: "incomplete", revision: 1, reviewRequested: false,
      pages: {}, events: [], completedUnits: {}, reviewError: "建议检查失败",
      review: {
        revision: 1, updatedAt: 0, issueIds: [], stepItems: {},
        steps: { format: { status: "complete" }, content: { status: "complete" }, knowledge: { status: "complete" }, supplement: { status: "incomplete", reason: "建议检查失败" } },
        knowledgeChecks: { ...Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, items: [] }])), suggestion: { status: "incomplete", items: [] } },
        retrieval: { status: "completed", evidence: [], relations: [], targetResults: [], execution: {
          configVersion: "test", queries: [], channelStates: [], warnings: [], budgetReached: [], elapsedMs: 0,
          usage: { candidates: 0, queries: 1, contextChars: 0, readChars: 0 },
        } },
      },
    }
    expect(hasOnlyOptionalReviewFailures(run)).toBe(expected)
  })
})
