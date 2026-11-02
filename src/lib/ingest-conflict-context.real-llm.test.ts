/** 显式启用的真实模型回放：原始故障材料与版本、条件差异的对照均不写用户项目。 */
import fs from "node:fs/promises"
import { afterAll, describe, expect, it, vi } from "vitest"
import { realFs, createTempProject, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./evidence-retrieval", () => ({ retrieveEvidence: vi.fn() }))

import type { LlmConfig } from "@/stores/wiki-store"
import { verifyConflictScope, type ConflictMaterial } from "./ingest-conflict-verification"
import { IngestProcessLog, readSourceProcessLog } from "./ingest-process-log"
import { observeLlmCalls } from "./llm-observer"
import { retrieveEvidence } from "./evidence-retrieval"
import { runIngestReview } from "./ingest-review"
import { loadIngestRun } from "./ingest-run"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"

const enabled = process.env.RUN_CONFLICT_REPLAY === "1"
const results: object[] = []

/** 凭据只从显式指定的本机配置读取；不复制到报告、命令行或测试输出。 */
async function configFromFile(): Promise<LlmConfig> {
  const path = process.env.CONFLICT_REPLAY_CONFIG
  if (!path) throw new Error("真实回放需指定 CONFLICT_REPLAY_CONFIG 配置文件")
  return (JSON.parse(await fs.readFile(path, "utf8")) as { llmConfig: LlmConfig }).llmConfig
}

async function runCase(id: string, issue: Parameters<typeof verifyConflictScope>[1], materials: ConflictMaterial[]) {
  const project = await createTempProject("real-conflict-replay")
  try {
    const logger = new IngestProcessLog(project.path, "raw/sources/replay.md", id, "conflict-replay")
    const config = await configFromFile()
    const verdict = await verifyConflictScope(observeLlmCalls(config, (call) => logger.observeCall(call)), issue, materials, AbortSignal.timeout(90_000), logger)
    await logger.flush()
    const records = (await readSourceProcessLog(project.path, "raw/sources/replay.md")).text.trim().split("\n").map((line) => JSON.parse(line))
    results.push({ id, model: config.model, verdict, inputs: records.filter((entry) => entry.event === "review-conflict-verification-input").map((entry) => entry.data), outputs: records.filter((entry) => entry.event === "review-conflict-verification-result").map((entry) => entry.data) })
    return verdict
  } catch (error) {
    results.push({ id, error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally { await project.cleanup() }
}

describe.skipIf(!enabled)("冲突上下文真实模型回放", () => {
  it("本次失败的原始候选获得实际消费的完整材料后可以完成判定", async () => {
    const log = process.env.CONFLICT_REPLAY_LOG
    if (!log) throw new Error("真实回放需指定 CONFLICT_REPLAY_LOG 来源日志")
    const rows = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const start = rows.filter((entry) => entry.phase === "background-review" && entry.event === "llm-start" && entry.stage === "background-review")
      .reverse().find((entry) => JSON.parse(entry.data.messages[1].content).task?.includes("本轮同页"))!
    const input = JSON.parse(start.data.messages[1].content) as { materials: ConflictMaterial[] }
    const output = rows.filter((entry) => entry.event === "llm-output" && entry.data.callId === start.data.callId).map((entry) => entry.data.text).join("")
    const issue = JSON.parse(output).issues[0]
    const evidence = issue.evidence.map(({ id, quote }: { id: string; quote: string }) => {
      const material = input.materials.find((entry) => entry.id === id)!
      const offset = material.text.indexOf(quote)
      expect(offset).toBeGreaterThanOrEqual(0)
      const startLine = material.startLine + material.text.slice(0, offset).split("\n").length - 1
      return { ...material, text: quote, startLine, endLine: startLine + quote.split("\n").length - 1 }
    })
    const verdict = await runCase("original-table-conflict", { ...issue, evidence }, input.materials)
    expect(Object.keys(verdict)).toHaveLength(5)
    expect(Object.values(verdict).every((value) => typeof value === "boolean")).toBe(true)
  }, 120_000)

  it.each([
    { id: "same-scope-conflict", first: "珊瑚引擎 V7 在标准模式下并发上限为 9。", second: "珊瑚引擎 V7 在标准模式下并发上限为 17。", conflict: true },
    { id: "different-version", first: "珊瑚引擎 V6 在标准模式下并发上限为 9。", second: "珊瑚引擎 V7 在标准模式下并发上限为 17。", conflict: false },
    { id: "different-condition", first: "珊瑚引擎 V7 在标准模式下并发上限为 9。", second: "珊瑚引擎 V7 在扩展模式下并发上限为 17。", conflict: false },
  ])("$id", async ({ id, first, second, conflict }) => {
    const materials = [first, second].map((text, index) => ({ id: `material-${index}`, path: `wiki/designs/limit-${index}.md`, revision: `sha256:fixture-${index}`, text: `# 珊瑚引擎并发规则\n${text}`, startLine: 1, endLine: 2 }))
    const evidence = materials.map((material, index) => ({ ...material, text: index ? second : first, startLine: 2, endLine: 2 }))
    const verdict = await runCase(id, { title: "并发上限不同", description: "核对是否存在相同适用范围内的事实冲突", evidence }, materials)
    expect(verdict.sameSubject && verdict.sameVersion && verdict.sameConditions && verdict.incompatible && !verdict.explainedDifference).toBe(conflict)
  }, 120_000)

  it("真实任务快照走完整审阅入口，页面正文不变且冲突步骤不再卡住", async () => {
    const sourceProject = process.env.CONFLICT_REPLAY_PROJECT
    const runId = process.env.CONFLICT_REPLAY_RUN
    if (!sourceProject || !runId) throw new Error("完整回放需指定 CONFLICT_REPLAY_PROJECT 和 CONFLICT_REPLAY_RUN")
    const project = await createTempProject("real-review-snapshot")
    try {
      const original = await loadIngestRun(sourceProject, runId)
      const directory = `.llm-wiki/ingest-runs/${runId}`
      for (const name of ["manifest.json", "source.json"]) await writeFileRaw(`${project.path}/${directory}/${name}`, await fs.readFile(`${sourceProject}/${directory}/${name}`, "utf8"))
      for (const name of ["schema.md", "page-rules.md", "purpose.md", "prompts"]) {
        const exists = await fs.stat(`${sourceProject}/${name}`).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false
          throw error
        })
        if (exists) await fs.cp(`${sourceProject}/${name}`, `${project.path}/${name}`, { recursive: true })
      }
      for (const entry of Object.values(original.pages)) await writeFileRaw(`${project.path}/${entry.path}`, entry.after)
      for (const entry of original.review?.retrieval?.evidence ?? []) {
        if (!entry.path.startsWith("wiki/") || entry.path.split("/").includes("..")) throw new Error("回放检索材料路径无效")
        await writeFileRaw(`${project.path}/${entry.path}`, await fs.readFile(`${sourceProject}/${entry.path}`, "utf8"))
      }
      vi.mocked(retrieveEvidence).mockResolvedValue(original.review!.retrieval!)
      useWikiStore.setState({ project: { id: "snapshot-replay", name: "snapshot-replay", path: project.path }, outputLanguage: "Chinese" })
      useReviewStore.setState({ items: [] })

      await runIngestReview(project.path, runId, await configFromFile(), AbortSignal.timeout(180_000))

      const report = await loadIngestRun(project.path, runId)
      results.push({ id: "full-snapshot-review", status: report.reviewStatus, steps: report.review?.steps, error: report.reviewError, statistics: report.review?.statistics, items: useReviewStore.getState().items.map(({ type, title }) => ({ type, title })) })
      expect(report.review?.steps.conflict.status).toBe("complete")
      expect(report.reviewStatus).toBe("complete")
      for (const entry of Object.values(original.pages)) expect(await fs.readFile(`${project.path}/${entry.path}`, "utf8")).toBe(entry.after)
    } finally { await project.cleanup() }
  }, 240_000)
})

afterAll(async () => {
  if (!enabled) return
  await fs.mkdir("plans/evaluations", { recursive: true })
  await fs.writeFile("plans/evaluations/ingest-conflict-context-replay.json", JSON.stringify({ results }, null, 2))
})
