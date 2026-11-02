/** 有限真实模型评估：自定义事实，实际文件、Rust 检索与后台审阅入口。 */
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./evidence-retrieval", async (original) => ({
  ...await original<typeof import("./evidence-retrieval")>(),
  retrieveEvidence: async (request: import("./evidence-retrieval").RetrievalRequest) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-retrieval-evaluation-"))
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
import * as llmClient from "./llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"

const enabled = process.env.RUN_REVIEW_EVALUATION === "1"
const results: object[] = []
const page = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\nsources: [facts.md]\n---\n# ${title}\n\n${body}\n`
const cases = [
  { id: "same-condition-conflict", source: "珊瑚引擎 V7 在标准模式下并发上限为 17。", before: "珊瑚引擎 V7 在标准模式下并发上限为 9。", expected: "contradiction", forbidden: [] },
  { id: "version-difference", source: "珊瑚引擎 V7 在标准模式下并发上限为 17。", before: "珊瑚引擎 V6 在标准模式下并发上限为 9。", expected: "", forbidden: ["contradiction"] },
  { id: "distinct-conditions", source: "珊瑚引擎 V7 在扩展模式下并发上限为 17。", before: "珊瑚引擎 V7 在标准模式下并发上限为 9。", expected: "", forbidden: ["contradiction"] },
  { id: "omitted-detail", source: "珊瑚引擎 V7 在标准模式下并发上限为 17，超时为 43 秒；超时后只重试一次。", body: "珊瑚引擎 V7 在标准模式下并发上限为 17。", expected: "coverage", forbidden: [] },
  { id: "existing-embedded-fact", source: "青隼协议使用 31 位校验码。该事实记录在设计说明的校验章节中，项目无需单独术语页。", related: "# 设计说明\n\n## 校验\n青隼协议使用 31 位校验码。项目无需独立术语页面。", expected: "", forbidden: ["missing-page"] },
  { id: "research-gap", source: "霁蓝缓存策略有 A、B 两种实现。两者在极寒场景下的吞吐尚未做对照实验，目前不能判断哪种更快。", expected: "suggestion", forbidden: ["contradiction"] },
  { id: "duplicate-pages", source: "月栈队列容量为 23 条；溢出请求立即拒绝，消费采用先进先出顺序。", related: "# 月栈排队规范\n月栈队列容量为 23 条；溢出请求立即拒绝，消费采用先进先出顺序。", expected: "duplicate", forbidden: ["contradiction"] },
  { id: "dedicated-page-needed", source: "项目已决定把澄桥协议作为独立维护的核心规范。澄桥协议包含握手、校验与重连三个阶段：握手码为 41，校验宽度为 29 位，重连间隔为 19 秒。此规范需要独立页面承载版本历史和外部引用；本页是项目周报中的临时记录。", expected: "missing-page", forbidden: ["contradiction"] },
]

describe.skipIf(!enabled)("统一后台审阅真实模型评估", () => {
  it.each(cases)("$id", async (scenario) => {
    const project = await createTempProject(`review-evaluation-${scenario.id}`)
    const started = Date.now()
    const calls = vi.spyOn(llmClient, "streamChat")
    try {
      await writeFileRaw(`${project.path}/schema.md`, "# 页面规则\n概念页位于 wiki/concepts/；type、title、sources 为必填。允许多个知识点保存在同一页。")
      if (scenario.related) await writeFileRaw(`${project.path}/wiki/concepts/design.md`, page("设计说明", scenario.related))
      useWikiStore.setState({ project: { id: scenario.id, name: scenario.id, path: project.path }, outputLanguage: "Chinese" })
      useReviewStore.setState({ items: [] })
      const target = "wiki/concepts/facts.md"
      const before = scenario.before ? page("珊瑚引擎", scenario.before) : null
      if (before) await writeFileRaw(`${project.path}/${target}`, before)
      const run = await beginIngestRun(project.path, scenario.id, "raw/sources/facts.md", "facts.md", scenario.source)
      await commitIngestPage(project.path, run.runId, target, before, page("观测事实", scenario.body ?? scenario.source), "facts", before ? "merge" : "create")
      await updateIngestRun(project.path, run.runId, (state) => { state.writeStatus = "complete" })
      await runIngestReview(project.path, run.runId, {
        ...useWikiStore.getState().llmConfig, provider: "ollama", apiKey: "", ollamaUrl: process.env.REVIEW_EVALUATION_URL ?? "http://127.0.0.1:11434", model: process.env.REVIEW_EVALUATION_MODEL ?? "qwen3.5:4b", maxContextSize: 48_000,
      })
      const report = await loadIngestRun(project.path, run.runId)
      const items = useReviewStore.getState().items
      const types = items.map((item) => item.type)
      results.push({ id: scenario.id, expected: scenario.expected || "无指定正例", foundExpected: !scenario.expected || types.includes(scenario.expected as typeof types[number]), forbiddenFound: types.filter((type) => (scenario.forbidden as string[]).includes(type)), types, status: report.reviewStatus, steps: report.review?.steps, scopeChecks: report.review?.scopeChecks, elapsedMs: Date.now() - started, requests: calls.mock.calls.length, inputChars: calls.mock.calls.reduce((total, call) => total + JSON.stringify(call[1]).length, 0), issues: items.map(({ type, subtype, title, description, evidence }) => ({ type, subtype, title, description, evidence })) })
      expect(report.writeStatus).toBe("complete")
      expect(report.review).toBeDefined()
      expect(items.every((item) => item.schemaVersion === 2 && item.evidence?.length)).toBe(true)
    } finally { calls.mockRestore(); await project.cleanup() }
  }, 300_000)
})

afterAll(async () => {
  if (!enabled) return
  await fs.mkdir("plans/evaluations", { recursive: true })
  await fs.writeFile("plans/evaluations/ingest-review-model-evaluation.json", JSON.stringify({ model: process.env.REVIEW_EVALUATION_MODEL ?? "qwen3.5:4b", results }, null, 2))
})
