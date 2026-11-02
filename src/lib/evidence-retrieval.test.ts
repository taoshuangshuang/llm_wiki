/** 诊断材料必须留在日志中，不能增加后台审阅原有的模型上下文。 */
import { describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
import { retrieveEvidence } from "./evidence-retrieval"
import type { IngestProcessLog } from "./ingest-process-log"

describe("检索诊断隔离", () => {
  it("详细候选和预算过程只交给日志，业务返回维持原始执行信息", async () => {
    const response = { status: "partial", evidence: [], relations: [], targetResults: [], execution: {
      configVersion: "version", queries: [], channelStates: [], warnings: ["正文超额"], budgetReached: [], elapsedMs: 1,
      usage: { candidates: 1, queries: 1, contextChars: 0, readChars: 100 },
      trace: [{ event: "evidence-expansion", segments: [{ chars: 100, remainingChars: 5, accepted: false }] }],
    } }
    mocks.invoke.mockResolvedValue(response)
    const record = vi.fn()
    const result = await retrieveEvidence({ projectPath: "/project", scene: "review", targets: [{ id: "a", text: "输入" }] }, { record } as unknown as IngestProcessLog)
    expect(mocks.invoke).toHaveBeenCalledWith("retrieve_evidence", expect.objectContaining({ recordTrace: true }))
    expect(record).toHaveBeenCalledWith("retrieval-finish", expect.objectContaining({ result: response }), "retrieval")
    expect(result.execution).not.toHaveProperty("trace")
    expect(result.evidence).toEqual(response.evidence)
    expect(result.execution.warnings).toEqual(["正文超额"])
  })
})
