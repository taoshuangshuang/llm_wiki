/** 四项检查的公共输入输出契约：直接传材料，不创建入库记录或真实模型请求。 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../llm-client", () => ({ streamChat: vi.fn() }))

import coverageResponses from "./coverage-response-fixtures.json"
import { streamChat } from "../llm-client"
import { contentRevision } from "../content-revision"
import { reviewMaterialSegments } from "./segments"
import { checkFormat, checkCoverage, checkKnowledge, checkSupplements, type CoverageCheckOptions, type KnowledgeCheckOptions, type ReviewMaterial } from "./index"

const config = { provider: "openai" as const, apiKey: "test", model: "test", ollamaUrl: "", customEndpoint: "", maxContextSize: 128_000 }
const pagePath = "wiki/concepts/cache.md"
const markdown = "---\ntype: concept\ntitle: 缓存\nsources: [a.md]\n---\n# 缓存\n读取缓存。"
const positive = { sameSubject: true, sameVersion: true, sameConditions: true, incompatible: true, explainedDifference: false }

function material(id: string, path: string, text: string, startLine = 1): ReviewMaterial {
  return { id, path, text, revision: `${id}-revision`, startLine, endLine: startLine + text.split("\n").length - 1 }
}

function knowledge(materials: ReviewMaterial[]): KnowledgeCheckOptions {
  return { materials, policy: "只检查已提供的事实。", outputLanguage: "zh", llmConfig: config }
}

function coverage(overrides: Partial<CoverageCheckOptions> = {}): CoverageCheckOptions {
  return {
    sourceIdentity: "a.md", sourcePath: "raw/sources/a.md", sourceContent: "读取缓存。",
    pages: { [pagePath]: markdown }, knownPagePaths: [pagePath], schema: "", purpose: "缓存知识",
    prompt: "核对来源和旧页关键事实是否保留。", llmConfig: config,
    readPage: vi.fn(async () => { throw new Error("没有授权读取关联页") }), ...overrides,
  }
}

function respond(value: unknown) {
  vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken(JSON.stringify(value))
    callbacks.onDone()
  })
}

beforeEach(() => { vi.resetAllMocks() })

describe("格式检查", () => {
  it("直接检查页面规范并返回版本范围，不调用模型", () => {
    const valid = material("valid", pagePath, markdown)
    const invalid = material("invalid", "wiki/concepts/bad.md", "# 缺少元数据")
    const result = checkFormat({ pages: [valid, invalid], schema: "" })

    expect(result.status).toBe("complete")
    expect(result.issues).toEqual([expect.objectContaining({ kind: "structure", pages: [invalid.path], description: expect.stringContaining("frontmatter") })])
    expect(result.checkedScope).toEqual([expect.objectContaining({ path: valid.path, revision: valid.revision }), expect.objectContaining({ path: invalid.path })])
    expect(result.checkedScope[0]).not.toHaveProperty("text")
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("空材料和取消不会被当作检查通过", () => {
    expect(checkFormat({ pages: [], schema: "" }).status).toBe("incomplete")
    const controller = new AbortController()
    controller.abort()
    expect(checkFormat({ pages: [material("page", pagePath, markdown)], schema: "", signal: controller.signal })).toMatchObject({ status: "cancelled", issues: [], checkedScope: [] })
  })
})

describe("内容覆盖检查", () => {
  // 回放 2026-11-01 两次真实模型输出；协议失败后必须重新审阅，不能靠补空数组判通过。
  it.each(Object.entries(coverageResponses))("实际日志响应 %s 校验失败后纠正一次并保留完整材料", async (_name, response) => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(vi.mocked(streamChat).mock.calls.length === 1 ? response : JSON.stringify({ summary: "重新核对完成", issues: [] }))
      callbacks.onDone()
    })
    const result = await checkCoverage(coverage())

    expect(result).toMatchObject({ status: "complete", summaries: ["重新核对完成"], issues: [] })
    expect(streamChat).toHaveBeenCalledTimes(2)
    const [, messages] = vi.mocked(streamChat).mock.calls[1]
    expect(messages[0].content).toContain("issues")
    expect(messages[0].content).toContain("summary")
    expect(messages[1].content).toBe(vi.mocked(streamChat).mock.calls[0][1][1].content)
  })

  it.each(Object.entries(coverageResponses))("实际日志响应 %s 纠正后仍无效时保持未完成", async (_name, response) => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(response)
      callbacks.onDone()
    })
    const result = await checkCoverage(coverage())

    expect(result).toMatchObject({ status: "incomplete", summaries: [], issues: [], checkedScope: [] })
    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(result.reason).toContain("原文范围")
  })

  it.each(["空响应", "截断", "网络失败", "取消"])("覆盖检查的%s不触发协议纠正重试", async (scenario) => {
    const controller = new AbortController()
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      if (scenario === "取消") controller.abort()
      if (scenario === "网络失败") callbacks.onError(new Error("网络失败"))
      else {
        callbacks.onToken(scenario === "空响应" ? "" : '{"summary":"完成","issues":[]}')
        callbacks.onDone({ truncated: scenario === "截断" })
      }
    })
    const result = await checkCoverage(coverage({ signal: controller.signal }))

    expect(result).toMatchObject({ status: scenario === "取消" ? "cancelled" : "incomplete", summaries: [], issues: [], checkedScope: [] })
    expect(streamChat).toHaveBeenCalledTimes(1)
  })

  it("遗漏定向复查也能纠正协议，成功后才缓存检查结果", async () => {
    const issue = { kind: "coverage", description: "候选遗漏", sourceEvidence: "读取缓存。", pageEvidence: "", pages: [pagePath] }
    const onCoverageSegment = vi.fn(async () => {})
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      callbacks.onToken(!input.candidateIssues ? JSON.stringify({ summary: "候选遗漏", issues: [issue] })
        : vi.mocked(streamChat).mock.calls.length === 2 ? coverageResponses["missing-issues"]
        : JSON.stringify({ summary: "已承载", issues: [] }))
      callbacks.onDone()
    })
    const result = await checkCoverage(coverage({ onCoverageSegment }))

    expect(result).toMatchObject({ status: "complete", summaries: ["已承载"], issues: [] })
    expect(streamChat).toHaveBeenCalledTimes(3)
    expect(onCoverageSegment).toHaveBeenCalledExactlyOnceWith(expect.any(String), { summary: "已承载", issues: [] })
    const calls = vi.mocked(streamChat).mock.calls
    expect(calls[2][1][1].content).toBe(calls[1][1][1].content)
  })

  it("显式对照来源、旧页及全部写入后页面，检查模块不需要项目路径或入库记录", async () => {
    respond({ summary: "来源与旧页贡献均保留", issues: [] })
    const before = "旧页独有事实。"
    const result = await checkCoverage(coverage({ beforePages: { [pagePath]: before } }))
    const input = JSON.parse(String(vi.mocked(streamChat).mock.calls[0][1][1].content))

    expect(input).toMatchObject({ source: "读取缓存。\n", beforePages: { [pagePath]: before }, pages: { [pagePath]: markdown } })
    expect(result).toMatchObject({ status: "complete", issues: [], summaries: ["来源与旧页贡献均保留"] })
    expect(result.checkedScope).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "source", path: "raw/sources/a.md", startLine: 1, endLine: 1 }),
      expect.objectContaining({ role: "before", path: pagePath, revision: await contentRevision(before) }),
      expect.objectContaining({ role: "page", path: pagePath, revision: await contentRevision(markdown) }),
    ]))
  })

  it("候选遗漏通过注入读取器补读关联页，已承载事实不产生遗漏事项", async () => {
    const related = "wiki/concepts/linked.md"
    const issue = { kind: "coverage", description: "缺少读取缓存", sourceEvidence: "读取缓存。", pageEvidence: "", pages: [pagePath] }
    const readPage = vi.fn(async () => "# 相关页\n读取缓存。")
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      callbacks.onToken(JSON.stringify(input.relatedPages ? { summary: "关联页已保留事实", issues: [] } : { summary: "发现候选遗漏", issues: [issue] }))
      callbacks.onDone()
    })
    const result = await checkCoverage(coverage({ pages: { [pagePath]: `${markdown}\n[[linked]]` }, knownPagePaths: [pagePath, related], readPage }))

    expect(result).toMatchObject({ status: "complete", issues: [] })
    // 一次读取核实承载内容，一次回读确认模型核实期间版本没有变化。
    expect(readPage.mock.calls).toEqual([[related], [related]])
    expect(result.checkedScope).toContainEqual(expect.objectContaining({ role: "related", path: related }))
  })

  it("保留部分成功的来源范围，后续模型失败不能解释为全量通过", async () => {
    let calls = 0
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      if (++calls === 1) { callbacks.onToken('{"summary":"第一段完成","issues":[]}'); callbacks.onDone() }
      else callbacks.onError(new Error("后续片段检查失败"))
    })
    const result = await checkCoverage(coverage({ sourceContent: `${"事实".repeat(30)}\n`.repeat(210), llmConfig: { ...config, maxContextSize: 14_000 } }))

    expect(result).toMatchObject({ status: "partial", summaries: ["第一段完成"], issues: [] })
    expect(result.reason).toContain("后续片段检查失败")
    expect(result.checkedScope.filter((scope) => scope.role === "source")).toEqual([expect.objectContaining({ startLine: 1, endLine: 100 })])
    expect(calls).toBeGreaterThan(1)
  })

  it("来源证据无法逐字定位时只纠正一次，仍无效则返回未完成", async () => {
    respond({ summary: "遗漏", issues: [{ kind: "coverage", description: "不存在的事实", sourceEvidence: "编造的引用", pageEvidence: "", pages: [pagePath] }] })
    const result = await checkCoverage(coverage())

    expect(result).toMatchObject({ status: "incomplete", issues: [], checkedScope: [] })
    expect(result.reason).toContain("来源引用")
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it("覆盖结果只包含覆盖事项，旧模型响应中的格式事项由格式检查负责", async () => {
    respond({ summary: "格式事项独立处理", issues: [{ kind: "structure", description: "旧格式建议", sourceEvidence: "", pageEvidence: pagePath, pages: [pagePath] }] })
    expect(await checkCoverage(coverage())).toMatchObject({ status: "complete", issues: [] })
  })

  it("遗漏定向复核返回格式事项时拒绝，不能误当作遗漏已消除", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      callbacks.onToken(JSON.stringify({ summary: "核查", issues: input.candidateIssues
        ? [{ kind: "structure", description: "错误类型", sourceEvidence: "", pageEvidence: pagePath, pages: [pagePath] }]
        : [{ kind: "coverage", description: "遗漏事实", sourceEvidence: "读取缓存。", pageEvidence: "", pages: [pagePath] }] }))
      callbacks.onDone()
    })
    const result = await checkCoverage(coverage())

    expect(result).toMatchObject({ status: "incomplete", issues: [] })
    expect(result.reason).toContain("类型或范围")
    expect(streamChat).toHaveBeenCalledTimes(2)
  })
})

describe("内容冲突检查", () => {
  const text = "# 接口行为\n新版接口：支持批量查询。\n旧说明：不支持批量查询。"
  const page = material("page", pagePath, text, 20)
  const issue = { type: "contradiction", title: "批量查询能力冲突", description: "核对两段说法", evidence: [{ id: page.id, quote: "支持批量查询。" }, { id: page.id, quote: "不支持批量查询。" }] }

  it.each([true, false])("初筛与复核组成一个检查，复核是否确认冲突：%s", async (incompatible) => {
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const verification = String(messages[0].content).includes("事实适用范围复核器")
      callbacks.onToken(JSON.stringify(verification ? { ...positive, incompatible, explainedDifference: !incompatible } : { issues: [issue] }))
      callbacks.onDone()
    })
    const result = await checkKnowledge(knowledge([page]))

    expect(result.status).toBe("complete")
    expect(result.issues).toHaveLength(incompatible ? 1 : 0)
    const input = JSON.parse(String(vi.mocked(streamChat).mock.calls[1][1][1].content))
    expect(input.materials).toEqual([page])
    expect(input.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ startLine: 21, quote: "支持批量查询。" }), expect.objectContaining({ startLine: 22, quote: "不支持批量查询。" })]))
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it("原文声明差异但未消解时冲突转待确认，不静默丢弃", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const verification = String(messages[0].content).includes("事实适用范围复核器")
      callbacks.onToken(JSON.stringify(verification ? { ...positive, declaredDifference: true } : { issues: [issue] }))
      callbacks.onDone()
    })
    const result = await checkKnowledge(knowledge([page]))

    expect(result.status).toBe("complete")
    expect(result.issues).toHaveLength(0)
    expect(result.pending).toHaveLength(1)
    expect(result.pending![0].title).toBe("批量查询能力冲突")
    expect(result.pending![0].description).toContain("未消解")
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it("原文已有消解说明时不生成冲突或待确认事项", async () => {
    // 即使初筛仍返回冲突，复核的消解结论也必须使该候选退出审核。
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const verification = String(messages[0].content).includes("事实适用范围复核器")
      callbacks.onToken(JSON.stringify(verification ? { ...positive, explainedDifference: true, declaredDifference: true } : { issues: [issue] }))
      callbacks.onDone()
    })
    const result = await checkKnowledge(knowledge([page]))
    expect(result.status).toBe("complete")
    expect(result.issues).toEqual([])
    expect(result.pending ?? []).toEqual([])
  })

  it("复核缺少必要条件时完成执行并保留人工确认事项", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      callbacks.onToken(JSON.stringify(String(messages[0].content).includes("事实适用范围复核器")
        ? { incomplete: true, reason: "缺少接口适用版本", missingContext: ["版本范围"] } : { issues: [issue] }))
      callbacks.onDone()
    })
    const result = await checkKnowledge(knowledge([page]))

    expect(result.status).toBe("complete")
    expect(result.issues).toEqual([])
    expect(result.pending).toHaveLength(1)
    expect(result.pending![0].description).toContain("版本范围")
    expect(result.checkedScope).toContainEqual(expect.objectContaining({ path: pagePath, revision: page.revision }))
    expect(streamChat).toHaveBeenCalledTimes(2)
  })
})

describe("内容重复与知识补充检查", () => {
  const first = material("first", pagePath, "读取缓存。")
  const second = material("second", "wiki/concepts/cache-guide.md", "读取缓存。\n独有的过期条件。")

  it("重复结果保留双方正文证据，事项按钮和持久化身份由调用方补充", async () => {
    respond({ issues: [{ type: "duplicate", title: "缓存读取重复", description: "读取部分重复，合并时保留过期条件", evidence: [{ id: first.id, quote: "读取缓存。" }, { id: second.id, quote: "读取缓存。" }] }] })
    const result = await checkKnowledge(knowledge([first, second]))

    expect(result).toMatchObject({ status: "complete", issues: [{ type: "duplicate", affectedPages: [first.path, second.path], evidence: [expect.objectContaining({ revision: first.revision }), expect.objectContaining({ revision: second.revision })] }] })
    expect(result.issues[0]).not.toHaveProperty("options")
    expect(result.issues[0]).not.toHaveProperty("resolved")
    expect(streamChat).toHaveBeenCalledTimes(1)
  })

  it("同批冲突与重复共用一次初筛，只有冲突候选追加适用范围复核", async () => {
    const third = material("third", "wiki/concepts/batch.md", "支持批量查询。")
    const fourth = material("fourth", "wiki/concepts/query.md", "不支持批量查询。")
    const duplicate = { type: "duplicate", title: "缓存重复", description: "保留过期条件", evidence: [{ id: first.id, quote: "读取缓存。" }, { id: second.id, quote: "读取缓存。" }] }
    const conflict = { type: "contradiction", title: "批量查询冲突", description: "能力表述相反", evidence: [{ id: third.id, quote: third.text }, { id: fourth.id, quote: fourth.text }] }
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      callbacks.onToken(JSON.stringify(String(messages[0].content).includes("事实适用范围复核器") ? positive : { issues: [duplicate, conflict] }))
      callbacks.onDone()
    })

    const result = await checkKnowledge(knowledge([first, second, third, fourth]))

    expect(result.status).toBe("complete")
    expect(result.issues.map((issue) => issue.type)).toEqual(["contradiction", "duplicate"])
    expect(streamChat).toHaveBeenCalledTimes(2)
    const request = JSON.parse(String(vi.mocked(streamChat).mock.calls[0][1][1].content))
    expect(request.materials).toEqual([first, second, third, fourth])
    expect(request.task).toContain("同批页面之间")
  })

  it.each([true, false, "incomplete"])("重复先返回也必须等待冲突复核：%s", async (incompatible) => {
    const conflict = { type: "contradiction", title: "缓存条件需核对", description: "核对双方条件", evidence: [{ id: first.id, quote: first.text }, { id: second.id, quote: "独有的过期条件。" }] }
    const duplicate = { ...conflict, type: "duplicate", title: "缓存重复" }
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const verdict = incompatible === "incomplete" ? { incomplete: true, reason: "缺少版本条件" } : { ...positive, incompatible, explainedDifference: !incompatible }
      callbacks.onToken(JSON.stringify(String(messages[0].content).includes("事实适用范围复核器") ? verdict : { issues: [duplicate, conflict] }))
      callbacks.onDone()
    })

    const result = await checkKnowledge(knowledge([first, second]))

    expect(result.issues.map((issue) => issue.type)).toEqual(incompatible === "incomplete" ? [] : [incompatible ? "contradiction" : "duplicate"])
    expect(result.status).toBe("complete")
    if (incompatible === "incomplete") expect(result.pending![0].description).toContain("版本条件")
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it("一个冲突缺少版本时继续复核其他冲突并检查无关重复", async () => {
    const third = material("third", "wiki/concepts/batch.md", "支持批量查询。\n不支持批量查询。")
    const fourth = material("fourth", "wiki/concepts/other.md", "其他知识。")
    const pending = { type: "contradiction", title: "缓存条件待确认", description: "缺少版本", evidence: [{ id: first.id, quote: first.text }, { id: second.id, quote: "独有的过期条件。" }] }
    const conflict = { type: "contradiction", title: "批量查询冲突", description: "同页矛盾", evidence: [{ id: third.id, quote: "支持批量查询。" }, { id: third.id, quote: "不支持批量查询。" }] }
    const blockedDuplicate = { ...pending, type: "duplicate", title: "不能自动合并的缓存重复" }
    const duplicate = { type: "duplicate", title: "无关重复", description: "独立重复", evidence: [{ id: fourth.id, quote: fourth.text }, { id: third.id, quote: "支持批量查询。" }] }
    // 已确认冲突页也不能进入合并候选，因此独立重复使用另一个独立页面。
    const fifth = material("fifth", "wiki/concepts/other-copy.md", "其他知识。")
    duplicate.evidence[1] = { id: fifth.id, quote: fifth.text }
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      const input = JSON.parse(String(messages[1].content))
      const verification = String(messages[0].content).includes("事实适用范围复核器")
      callbacks.onToken(JSON.stringify(!verification ? { issues: [pending, conflict, blockedDuplicate, duplicate] }
        : input.issue.title === pending.title ? { incomplete: true, reason: "缺少版本范围" } : positive))
      callbacks.onDone()
    })

    const result = await checkKnowledge(knowledge([first, second, third, fourth, fifth]))

    expect(result.status).toBe("complete")
    expect(result.pending?.map((entry) => entry.title)).toEqual([pending.title])
    expect(result.issues.map((entry) => entry.title)).toEqual([conflict.title, duplicate.title])
    expect(streamChat).toHaveBeenCalledTimes(3)
  })

  it("单页重复证据不足两个页面时拒绝，不生成可合并事项", async () => {
    respond({ issues: [{ type: "duplicate", title: "错误重复", description: "只有同页证据", evidence: [{ id: first.id, quote: "读取缓存。" }, { id: first.id, quote: "读取缓存。" }] }] })
    const result = await checkKnowledge(knowledge([first]))

    expect(result).toMatchObject({ status: "incomplete", issues: [] })
    expect(result.reason).toContain("两个页面")
  })

  it("补充检查使用显式项目用途与检索范围，返回有正文依据的重要问题", async () => {
    respond({ issues: [{ type: "suggestion", title: "补充过期条件", description: "过期条件影响缓存使用", evidence: [{ id: second.id, quote: "独有的过期条件。" }] }] })
    const result = await checkSupplements({ ...knowledge([second]), context: { projectPurpose: "缓存使用说明", targetResults: [{ status: "no_match" }] } })

    expect(result).toMatchObject({ status: "complete", issues: [{ type: "suggestion", evidence: [expect.objectContaining({ text: "独有的过期条件。", startLine: 2 })] }] })
    const input = JSON.parse(String(vi.mocked(streamChat).mock.calls[0][1][1].content))
    expect(input).toMatchObject({ projectPurpose: "缓存使用说明", outputLanguage: "zh", targetResults: [{ status: "no_match" }] })
  })

  it("错类型不能跨越检查契约，重试后仍无效则未完成", async () => {
    respond({ issues: [{ type: "duplicate", title: "错误类型", description: "补充检查不能返回重复", evidence: [{ id: "fake", quote: "读取缓存。" }] }] })
    const result = await checkSupplements(knowledge([first]))

    expect(result).toMatchObject({ status: "incomplete", issues: [] })
    expect(result.reason).toContain("只允许 type=suggestion")
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it("问题引用不存在的材料时拒绝，不将模型自编编号当作证据", async () => {
    respond({ issues: [{ type: "suggestion", title: "补充问题", description: "核对证据", evidence: [{ id: "fake", quote: "读取缓存。" }] }] })
    const result = await checkSupplements(knowledge([first]))

    expect(result).toMatchObject({ status: "incomplete", issues: [], checkedScope: [] })
    expect(result.reason).toContain("材料编号")
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it.each(["空响应", "输出截断", "调用失败"])("%s不能视为检查通过", async (scenario) => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      if (scenario === "调用失败") { callbacks.onError(new Error("模型调用失败")); return }
      callbacks.onToken(scenario === "空响应" ? "" : '{"issues":[]}')
      callbacks.onDone({ truncated: scenario === "输出截断" })
    })
    const result = await checkSupplements(knowledge([first]))

    expect(result).toMatchObject({ status: "incomplete", issues: [], checkedScope: [] })
    expect(result.reason).toBeTruthy()
  })

  it("取消、输入超预算与空材料都保持非通过状态，不发送模型请求", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await checkKnowledge({ ...knowledge([first]), signal: controller.signal })).toMatchObject({ status: "cancelled", issues: [] })
    expect(await checkSupplements({ ...knowledge([first]), llmConfig: { ...config, maxContextSize: 100 } })).toMatchObject({ status: "incomplete", issues: [] })
    expect(await checkKnowledge(knowledge([]))).toMatchObject({ status: "incomplete", issues: [] })
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("只由对照页提供证据的问题不能作为本次目标页面的问题发布", async () => {
    const third = material("third", "wiki/concepts/other.md", "读取缓存。")
    respond({ issues: [{ type: "duplicate", title: "对照页互相重复", description: "与目标无关", evidence: [{ id: second.id, quote: "读取缓存。" }, { id: third.id, quote: "读取缓存。" }] }] })
    const result = await checkKnowledge({ ...knowledge([first, second, third]), targetPaths: [first.path] })
    expect(result).toMatchObject({ status: "incomplete", issues: [] })
    expect(result.reason).toContain("目标页面")
  })

  it("超容量分段保留任意目标页之间及目标与对照的关系，不逐页重复组装大量请求", () => {
    const targets = Array.from({ length: 50 }, (_, index) => ({ ...material(`target-${index}`, `wiki/t-${index}.md`, "事实。".repeat(600)), role: "page" as const }))
    const reference = { ...material("reference", "wiki/reference.md", "对照事实。".repeat(300)), role: "related" as const }
    const segments = reviewMaterialSegments([...targets, reference], 90_000, 0)
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.length).toBeLessThan(12)
    for (const [index, target] of targets.entries()) {
      for (const other of [...targets.slice(index + 1), reference]) expect(segments.some((segment) => segment.some((entry) => entry.path === target.path) && segment.some((entry) => entry.path === other.path))).toBe(true)
    }
    expect(segments.flat().every((entry) => entry.text === targets.find((page) => page.path === entry.path)?.text || entry.text === reference.text)).toBe(true)
  })
})
