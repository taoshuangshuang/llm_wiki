/** 使用真实项目文件验证编辑、兼容读取与保存后的运行时有效值。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => realFs)
import { loadWorkflowDocument, saveWorkflowDocument, validateWorkflowDocument, workflowFilePath } from "./workflow-documents"
import { WORKFLOW_STAGES, findWorkflowNode } from "./workflow-catalog"
import { DEFAULT_INGEST_PROMPTS, initializeProjectIngestPrompts, loadProjectIngestPrompts } from "@/lib/ingest-prompts"
import { loadProjectSchema } from "@/lib/project-schema"

let project: Awaited<ReturnType<typeof createTempProject>> | undefined
afterEach(async () => { await project?.cleanup(); project = undefined })

describe("知识流程项目配置编辑", () => {
  it("主阶段覆盖完整流程，关键节点有说明，文件与参数只有一个编辑来源", () => {
    expect(WORKFLOW_STAGES.map((stage) => stage.title)).toEqual(["公共设置", "文件预处理", "分析规划", "页面生成", "匹配与写入", "后台审阅", "检索", "输出"])
    const nodes = WORKFLOW_STAGES.flatMap((stage) => stage.nodes)
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length)
    const files = nodes.flatMap((node) => node.files ?? []).map(workflowFilePath)
    expect(new Set(files).size).toBe(files.length)
    const sections = nodes.flatMap((node) => node.parameter ? [node.parameter] : [])
    expect(new Set(sections).size).toBe(sections.length)
    for (const node of nodes) {
      expect(node.description && node.input && node.output && node.impact).toBeTruthy()
      for (const reference of node.references ?? []) expect(findWorkflowNode(reference).node.id).toBe(reference)
      for (const file of node.files ?? []) expect(file.description).toBeTruthy()
      for (const file of node.files ?? []) if (file.prompt) {
        // 所有默认提示词均可通过编辑器自身校验，避免界面拒绝原有可运行配置。
        expect(() => validateWorkflowDocument(file, DEFAULT_INGEST_PROMPTS[file.prompt!])).not.toThrow()
      }
    }
    expect(files.some((path) => path.includes("研究搜索词"))).toBe(false)
    expect(findWorkflowNode("commit").node.parameter).toBeUndefined()
  })

  it("业务类型和向量参数归公共设置，执行节点只引用配置并保留自身职责", () => {
    expect(findWorkflowNode("business-types").stage.id).toBe("common")
    expect(findWorkflowNode("business-types").node.files?.map(workflowFilePath)).toEqual(["business-modules.md"])
    expect(findWorkflowNode("vector-store").stage.id).toBe("common")
    expect(findWorkflowNode("vector-store").node.parameter).toBe("embedding")
    const classification = findWorkflowNode("classification")
    expect(classification.stage.id).toBe("write")
    expect(classification.node.references).toContain("business-types")
    expect(classification.node.files?.some((file) => file.document === "business-modules.md")).toBe(false)
    const embedding = findWorkflowNode("embedding")
    expect(embedding.stage.id).toBe("write")
    expect(embedding.node.parameter).toBeUndefined()
    expect(embedding.node.references).toContain("vector-store")
    expect(findWorkflowNode("local-retrieval").node.references).toContain("vector-store")
  })

  it("提示词留在 prompts，继承旧别名后保存当前文件并被运行时读取", async () => {
    project = await createTempProject("workflow-prompt")
    const file = { title: "主题核对", prompt: "pageMatchTemplate" as const }
    await writeFileRaw(`${project.path}/prompts/04-03-相似页面主题核对.md`, "旧自定义规则")
    const draft = await loadWorkflowDocument(project.path, file)
    expect(draft.content).toBe("旧自定义规则")
    expect(draft.expected).toBeNull()
    await saveWorkflowDocument(project.path, file, { ...draft, content: "新的统一主题规则" })
    expect((await loadProjectIngestPrompts(project.path)).pageMatchTemplate).toBe("新的统一主题规则")
    expect(await readFileRaw(`${project.path}/prompts/04-03-相似页面主题核对.md`)).toBe("旧自定义规则")
  })

  it("读取后发生外部编辑时拒绝覆盖，原文件和用户草稿均保留", async () => {
    project = await createTempProject("workflow-conflict")
    const file = { title: "目标", document: "purpose.md" as const }
    await writeFileRaw(`${project.path}/purpose.md`, "最初内容")
    const draft = { ...await loadWorkflowDocument(project.path, file), content: "界面草稿" }
    await writeFileRaw(`${project.path}/purpose.md`, "外部新版本")
    await expect(saveWorkflowDocument(project.path, file, draft)).rejects.toThrow("VERSION_CONFLICT")
    expect(await readFileRaw(`${project.path}/purpose.md`)).toBe("外部新版本")
    expect(draft.content).toBe("界面草稿")
  })

  it("模块字典保存到根目录后立即成为分类有效配置，显式空值优先于旧目录", async () => {
    project = await createTempProject("workflow-modules")
    const file = { title: "模块", document: "business-modules.md" as const }
    const dictionary = '## Business Modules\n```json\n{"version":1,"modules":[{"id":"billing","name":"计费"}]}\n```'
    await writeFileRaw(`${project.path}/schema/business-modules.md`, dictionary)
    const draft = await loadWorkflowDocument(project.path, file)
    expect(draft.content).toBe(dictionary)
    await saveWorkflowDocument(project.path, file, { ...draft, content: "" })
    expect(await readFileRaw(`${project.path}/business-modules.md`)).toBe("")
    expect(await loadProjectSchema(project.path, "classification")).toBe("")
  })

  it("保存前检查必要变量、未知变量及审阅协议，不创建错误配置", async () => {
    project = await createTempProject("workflow-validation")
    const file = { title: "分析", prompt: "analysisTemplate" as const }
    const draft = await loadWorkflowDocument(project.path, file)
    await expect(saveWorkflowDocument(project.path, file, { ...draft, content: "缺少必要变量" })).rejects.toThrow("必要变量")
    expect(() => validateWorkflowDocument(file, `${draft.content}\n{{不存在的变量}}`)).toThrow("未知变量")
    expect(() => validateWorkflowDocument({ title: "审阅", prompt: "backgroundReview" }, "丢失协议")).toThrow("review-v2")
  })

  it("初始化不再创建或加载研究搜索词规则，旧文件保留但不生效", async () => {
    project = await createTempProject("workflow-no-research-rule")
    const path = `${project.path}/prompts/02-03-研究搜索词生成规则.md`
    await writeFileRaw(path, "旧规则保留原文")
    await initializeProjectIngestPrompts(project.path)
    expect(await loadProjectIngestPrompts(project.path)).not.toHaveProperty("researchQuery")
    expect(await readFileRaw(path)).toBe("旧规则保留原文")
    expect(await loadWorkflowDocument(project.path, { title: "生成", prompt: "generationTemplate" })).toMatchObject({ path: "prompts/02-01-Wiki页面生成.md" })
  })
})
