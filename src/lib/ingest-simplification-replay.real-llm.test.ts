/** 显式启用的真实资料回放：实际模型、Rust 检索/版本保护/向量，仅用文件传输替换桌面 IPC。 */
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { realFs } from "@/test-helpers/fs-temp"
import type { LlmConfig, EmbeddingConfig } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => ({ ...realFs, compareAndWriteFile: async (projectPath: string, relativePath: string, expected: string | null, contents: string) => nativeCall({ operation: "invoke", command: "compare_and_write_file", args: { projectPath, relativePath, expected, contents } }) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: Record<string, unknown>) => {
  if (command === "retrieval_config") return retrievalConfig(String(args.projectPath))
  return nativeCall({ operation: "invoke", command, args })
} }))
vi.mock("./evidence-retrieval", async (original) => ({ ...await original<typeof import("./evidence-retrieval")>(), retrieveEvidence: async (request: object) => nativeCall(request) }))

import { runIngestReview } from "./ingest-review"
import { retryIngestReview } from "./ingest-review-queue"
import { listIngestRuns, loadIngestRun } from "./ingest-run"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { loadReviewItems } from "./persist"

const enabled = process.env.RUN_INGEST_SIMPLIFICATION_REPLAY === "1"
const configPath = process.env.INGEST_SIMPLIFICATION_CONFIG

/** 凭据留在配置文件中，不进入命令行或报告。原生命令错误明确抛出，禁止静默假成功。 */
async function nativeCall(request: object): Promise<unknown> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-native-replay-"))
  try {
    const input = path.join(directory, "input.json")
    const output = path.join(directory, "output.json")
    await fs.writeFile(input, JSON.stringify(request), { mode: 0o600 })
    const binary = process.env.INGEST_SIMPLIFICATION_NATIVE_TEST_BINARY
    const command = binary ?? `${os.homedir()}/.cargo/bin/cargo`
    const args = binary ? ["commands::search::evidence::tests::retrieval_transport_for_node_evaluation", "--ignored", "--exact"] : ["test", "--lib", "commands::search::evidence::tests::retrieval_transport_for_node_evaluation", "--", "--ignored", "--exact"]
    execFileSync(command, args, {
      cwd: path.resolve("src-tauri"), timeout: 180_000, stdio: "pipe",
      env: { ...process.env, LLM_WIKI_EVALUATION_REQUEST: input, LLM_WIKI_EVALUATION_RESULT: output, LLM_WIKI_EVALUATION_CONFIG: configPath },
    })
    const result = JSON.parse(await fs.readFile(output, "utf8"))
    if (result.error) throw new Error(result.error)
    return Object.prototype.hasOwnProperty.call(result, "result") ? result.result : result
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function retrievalConfig(projectPath: string) {
  const read = async (file: string): Promise<Record<string, boolean>> => JSON.parse(await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}"; throw error }))
  const defaults = { title: true, keyword: true, vector: true, indexPage: true, graph: false, ...await read(path.join(path.dirname(configPath!), "retrieval-defaults.json")) }
  const overrides = await read(`${projectPath}/.llm-wiki/retrieval.json`)
  return { defaults, overrides, effective: { ...defaults, ...overrides } }
}

it.skipIf(!enabled)("三份真实来源完成修复后复查，原修复额度和人工状态保持", async () => {
  const projectPath = process.env.INGEST_SIMPLIFICATION_PROJECT
  if (!projectPath || !configPath) throw new Error("需显式指定隔离回放副本和本机模型配置")
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as { llmConfig: LlmConfig; embeddingConfig: EmbeddingConfig; outputLanguage: ReturnType<typeof useWikiStore.getState>["outputLanguage"] }
  const manual = (await loadReviewItems(projectPath)).filter((item) => item.resolutionUpdatedAt)
  const records = await listIngestRuns(projectPath)
  useWikiStore.setState({ project: { id: "real-simplification-replay", name: "真实资料回放", path: projectPath }, llmConfig: config.llmConfig, embeddingConfig: config.embeddingConfig, outputLanguage: config.outputLanguage })
  useReviewStore.setState({ items: await loadReviewItems(projectPath) })
  const reportPath = "plans/evaluations/入库简化真实资料回放-20261030.json"
  const previous = await fs.readFile(reportPath, "utf8").then((text) => JSON.parse(text), () => undefined)
  const results: { runId: string; [key: string]: unknown }[] = previous?.projectPath === projectPath ? previous.results : []
  for (const original of records.filter((run) => !process.env.INGEST_SIMPLIFICATION_RUN || run.runId === process.env.INGEST_SIMPLIFICATION_RUN).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
    const started = Date.now()
    // 沿用桌面“重新审阅”入口固定当前消费版本，不把已被后续来源更新的旧快照冒充当前结论。
    await retryIngestReview(projectPath, original.runId)
    await runIngestReview(projectPath, original.runId, config.llmConfig, AbortSignal.timeout(1_200_000))
    const current = await loadIngestRun(projectPath, original.runId)
    const items = await loadReviewItems(projectPath)
    const oldAttemptsPreserved = (original.repairAttempts ?? []).every((attempt) => current.repairAttempts?.some((saved) => saved.id === attempt.id && saved.startedAt === attempt.startedAt))
    const manualPreserved = manual.every((item) => items.some((saved) => saved.id === item.id && saved.resolved === item.resolved && saved.resolvedAction === item.resolvedAction))
    const result = { sourcePath: original.sourcePath, runId: original.runId, elapsedMs: Date.now() - started, reviewStatus: current.reviewStatus, reviewError: current.reviewError, steps: current.review?.steps, batches: current.review?.batches?.map((batch) => ({ index: batch.index, status: batch.status, retrieval: batch.retrieval?.status, elapsedMs: batch.retrieval?.execution.elapsedMs, warnings: batch.retrieval?.execution.warnings })), repairs: current.repairAttempts?.map(({ id, stage, status, reason }) => ({ id, stage, status, reason })), oldAttemptsPreserved, manualPreserved }
    const index = results.findIndex((entry) => entry.runId === current.runId)
    if (index < 0) results.push(result)
    else results[index] = result
    await fs.mkdir("plans/evaluations", { recursive: true })
    await fs.writeFile(reportPath, JSON.stringify({ projectPath, limitation: "真实桌面首轮已执行。锁屏后本回放直接执行同一生产流程并通过 Rust 传输接缝调用原生检索与提交，不替代修复版桌面 UI 的再次验收。", results }, null, 2))
    expect(oldAttemptsPreserved).toBe(true)
    expect(manualPreserved).toBe(true)
    expect(current.writeStatus).toBe("complete")
    expect(current.review?.steps.content.reason ?? "").not.toContain("超过定向核实预算")
    expect(current.review?.steps.knowledge.reason ?? "").not.toContain("检索超时")
  }
}, 3_600_000)

it.skipIf(!enabled)("独立进程恢复三份已完成来源，页面、修复账本和人工状态保持", async () => {
  const projectPath = process.env.INGEST_SIMPLIFICATION_PROJECT
  if (!projectPath || !configPath) throw new Error("需指定隔离回放副本和本机配置")
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as { llmConfig: LlmConfig; embeddingConfig: EmbeddingConfig }
  const { createHash } = await import("node:crypto")
  const { restoreIngestReviewQueue, pauseIngestReviewQueue } = await import("./ingest-review-queue")
  const before = await listIngestRuns(projectPath)
  expect(before.every((run) => run.writeStatus === "complete" && !run.reviewRequested)).toBe(true)
  const hashes = async (): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await visit(file)
        else if (entry.name.endsWith(".md")) result[path.relative(projectPath, file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex")
      }
    }
    await visit(`${projectPath}/wiki`)
    return result
  }
  const beforePages = await hashes()
  const beforeReviews = await loadReviewItems(projectPath)
  useWikiStore.setState({ project: { id: "real-simplification-replay", name: "真实资料回放", path: projectPath }, llmConfig: config.llmConfig, embeddingConfig: config.embeddingConfig })
  useReviewStore.setState({ items: beforeReviews })
  await restoreIngestReviewQueue(projectPath)
  await pauseIngestReviewQueue()
  const after = await listIngestRuns(projectPath)
  expect(await hashes()).toEqual(beforePages)
  expect(after.map((run) => ({ id: run.runId, repairs: run.repairAttempts, status: run.reviewStatus }))).toEqual(before.map((run) => ({ id: run.runId, repairs: run.repairAttempts, status: run.reviewStatus })))
  const afterReviews = await loadReviewItems(projectPath)
  for (const item of beforeReviews.filter((item) => item.resolutionUpdatedAt)) expect(afterReviews.find((saved) => saved.id === item.id)?.resolved).toBe(item.resolved)
  const reportPath = "plans/evaluations/入库简化真实资料回放-20261030.json"
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"))
  report.recovery = { runCount: after.length, pageCount: Object.keys(beforePages).length, pagesUnchanged: true, repairLedgerUnchanged: true, manualStateUnchanged: true }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
}, 120_000)
