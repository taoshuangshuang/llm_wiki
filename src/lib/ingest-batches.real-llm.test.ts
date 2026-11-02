/** 按需开启的真实服务评估：合成事实、临时文件、实际 Rust 检索与本地 Ollama。 */
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string) => command === "retrieval_config" ? { effective: { keyword: true, vector: false, indexPage: true, graph: false } } : undefined) }))
vi.mock("./evidence-retrieval", async (original) => ({
  ...await original<typeof import("./evidence-retrieval")>(),
  retrieveEvidence: async (request: import("./evidence-retrieval").RetrievalRequest) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-batch-retrieval-"))
    try {
      const input = path.join(directory, "request.json")
      const output = path.join(directory, "result.json")
      await fs.writeFile(input, JSON.stringify(request))
      execFileSync(`${os.homedir()}/.cargo/bin/cargo`, ["test", "--lib", "commands::search::evidence::tests::retrieval_transport_for_node_evaluation", "--", "--ignored", "--exact"], {
        cwd: path.resolve("src-tauri"), timeout: 120_000,
        env: { ...process.env, LLM_WIKI_EVALUATION_REQUEST: input, LLM_WIKI_EVALUATION_RESULT: output }, stdio: "pipe",
      })
      return JSON.parse(await fs.readFile(output, "utf8"))
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  },
}))

import { beginIngestRun, commitIngestPage, loadIngestRun, updateIngestRun } from "./ingest-run"
import { runIngestReview } from "./ingest-review"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"

it.skipIf(process.env.RUN_BATCH_REVIEW_EVALUATION !== "1")("11 页真实审阅分成 10＋1，保留每批时间、范围和模型实际结果", async () => {
  const project = await createTempProject("real-batch-review")
  const started = Date.now()
  const facts = Array.from({ length: 11 }, (_, index) => `试验协议 P${index + 1} 的校验宽度为 ${index + 17} 位。`)
  const model = process.env.REVIEW_EVALUATION_MODEL ?? "qwen3.5:4b"
  try {
    await writeFileRaw(`${project.path}/schema.md`, "# 页面规则\n概念页在 wiki/concepts/；type、title、sources 为必填。按实际版本核对，不为缺少实验数据制造结论。")
    useWikiStore.setState({ project: { id: "batch-evaluation", name: "batch-evaluation", path: project.path }, outputLanguage: "Chinese", embeddingConfig: { ...useWikiStore.getState().embeddingConfig, enabled: false } })
    useReviewStore.setState({ items: [] })
    const run = await beginIngestRun(project.path, "batch-evaluation", "raw/sources/facts.md", "facts.md", facts.join("\n"))
    for (const [index, fact] of facts.entries()) {
      const target = `wiki/concepts/protocol-${String(index).padStart(2, "0")}.md`
      const title = `试验协议 P${index + 1}`
      await commitIngestPage(project.path, run.runId, target, null, `---\ntype: concept\ntitle: ${title}\nsources: [facts.md]\n---\n# ${title}\n${fact}\n`, title, "create")
    }
    await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "complete" })
    await runIngestReview(project.path, run.runId, { ...useWikiStore.getState().llmConfig, provider: "ollama", apiKey: "", ollamaUrl: "http://127.0.0.1:11434", model, maxContextSize: 48_000 })
    const report = await loadIngestRun(project.path, run.runId)
    const result = { model, elapsedMs: Date.now() - started, status: report.reviewStatus, steps: report.review?.steps, statistics: report.review?.statistics,
      batches: report.review?.batches, items: useReviewStore.getState().items,
      limitation: "合成短文与关键词／索引通道评估；不代表长文、向量服务或真实资料在 60 秒内必定完成。" }
    await fs.mkdir("plans/evaluations", { recursive: true })
    await fs.writeFile("plans/evaluations/chunk-batch-review-2026-10-29.json", JSON.stringify(result, null, 2))
    expect(report.review?.batches?.map((batch) => batch.pageRefs.length)).toEqual([10, 1])
    expect(report.review?.batches?.every((batch) => batch.attempts === 1 && batch.retrieval?.targetResults.length === batch.pageRefs.length)).toBe(true)
    expect(report.writeStatus).toBe("complete")
  } finally { await project.cleanup() }
}, 300_000)
