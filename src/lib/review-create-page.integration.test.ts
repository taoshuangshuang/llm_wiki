/** 走待审阅按钮共用的创建入口，验证真实 schema、页面、导航和日志的完整输出。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))

import { streamChat } from "./llm-client"
import { createPagesFromReview } from "./review-create-page"
import { parseFrontmatter } from "./frontmatter"
import { useWikiStore } from "@/stores/wiki-store"
import type { ReviewItem } from "@/stores/review-store"

const config = useWikiStore.getState().llmConfig
const item: ReviewItem = {
  id: "review-schema", type: "suggestion", title: "待明确特征实体与普通实体的表处理逻辑具体差异",
  description: "说明两类实体的存储结构及差异。", options: [], resolved: false, createdAt: 0,
}
let project: Awaited<ReturnType<typeof createTempProject>>

beforeEach(async () => {
  project = await createTempProject("review-schema")
  vi.resetAllMocks()
  vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken('{"type":"data-model"}')
    callbacks.onDone()
  })
})
afterEach(async () => { await project.cleanup() })

/** 使用自定义类型及嵌套目录，防止实现仅替换为另一套固定分类。 */
async function writeSchema(): Promise<void> {
  await writeFileRaw(`${project.path}/schema.md`, [
    "## Page Types", "| Type | Directory | Purpose |", "| --- | --- | --- |",
    "| source | wiki/sources/ | 来源摘要 |",
    "| data-model | wiki/knowledge/storage/ | 表和字段等存储结构 |",
    "| constraint | wiki/rules/ | 使用限制 |",
  ].join("\n"))
}

describe("待审阅创建页面遵循 schema", () => {
  it("正文提到实体时，仍按 schema 用途分类，页面和导航均不产生默认实体分类", async () => {
    await writeSchema()
    const [created] = await createPagesFromReview(project.path, item, "Create Page", config)
    const page = await readFileRaw(created.filePath)

    expect(created.filePath).toBe(`${project.path}/wiki/knowledge/storage/${created.fileName}`)
    expect(parseFrontmatter(page).frontmatter?.type).toBe("data-model")
    expect(page).toContain(item.description)
    expect(await readFileRaw(`${project.path}/wiki/index.md`)).toContain(`[[knowledge/storage/${created.fileName.replace(/\.md$/, "")}|${item.title}]]`)
    expect(await readFileRaw(`${project.path}/wiki/log.md`)).toContain(created.fileName)
    for (const dir of ["entities", "concepts", "queries"]) {
      expect(await fileExists(`${project.path}/wiki/${dir}`)).toBe(false)
    }
    const messages = vi.mocked(streamChat).mock.calls[0][1]
    const input = JSON.parse(String(messages[1].content))
    expect(input.allowedTypes).toEqual(["data-model", "constraint"])
    expect(input.schema).toContain("表和字段等存储结构")
    expect(input.description).toBe(item.description)
  })

  it("待审阅中的保存正文也不能绕过 schema 写入 queries", async () => {
    await writeSchema()
    const content = "# 存储结构\n\n已确认的页面正文。"
    const [created] = await createPagesFromReview(project.path, item, "Save to Wiki", config, content)

    expect(created.dir).toBe("knowledge/storage")
    expect(parseFrontmatter(await readFileRaw(created.filePath)).body).toBe(content)
    expect(await fileExists(`${project.path}/wiki/queries`)).toBe(false)
  })

  it.each(['{"type":"entity"}', '{"type":"source"}', '{"type":"constructor"}', 'null', 'not json'])(
    "分类结果非法时不写入页面、索引或日志：%s", async (output) => {
      await writeSchema()
      vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
        callbacks.onToken(output)
        callbacks.onDone()
      })

      await expect(createPagesFromReview(project.path, item, "Create Page", config)).rejects.toThrow()
      expect(await fileExists(`${project.path}/wiki`)).toBe(false)
    },
  )

  it.each(["模型请求失败", "输出截断"])("分类%s时不回退为默认类型", async (failure) => {
    await writeSchema()
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken('{"type":"data-model"}')
      if (failure === "模型请求失败") callbacks.onError(new Error(failure))
      else callbacks.onDone({ truncated: true })
    })

    await expect(createPagesFromReview(project.path, item, "Create Page", config)).rejects.toThrow()
    expect(await fileExists(`${project.path}/wiki`)).toBe(false)
  })

  it("只有一个内容类型时直接使用声明，同时保留一项待审阅创建多页的能力", async () => {
    await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| source | wiki/sources/ |\n| reference | wiki/references/ |")
    const created = await createPagesFromReview(project.path, {
      ...item, type: "missing-page", title: "缺少实体页面：CallMethod、StartFunc", description: "",
    }, "Create Page", config)

    expect(created.map(({ title, pageType, dir }) => ({ title, pageType, dir }))).toEqual([
      { title: "CallMethod", pageType: "reference", dir: "references" },
      { title: "StartFunc", pageType: "reference", dir: "references" },
    ])
    for (const page of created) expect(await fileExists(page.filePath)).toBe(true)
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("遵守根目录映射，文件名重复时保留已有页面", async () => {
    await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| reference | wiki/ |")
    const first = await createPagesFromReview(project.path, item, "Create Page", config)
    const original = await readFileRaw(first[0].filePath)
    const second = await createPagesFromReview(project.path, item, "Create Page", config)

    expect(first[0].filePath).toBe(`${project.path}/wiki/${first[0].fileName}`)
    expect(second[0].filePath).not.toBe(first[0].filePath)
    expect(await readFileRaw(first[0].filePath)).toBe(original)
    expect(await readFileRaw(`${project.path}/wiki/index.md`)).toContain(`[[${second[0].fileName.replace(/\.md$/, "")}|`)
  })

  it.each(["index", "log"])("根目录页面标题为 %s 时不能覆盖应用维护文件", async (title) => {
    await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| reference | wiki/ |")
    const [created] = await createPagesFromReview(project.path, { ...item, title }, "Create Page", config)

    expect(created.fileName).not.toBe(`${title}.md`)
    expect(parseFrontmatter(await readFileRaw(created.filePath)).frontmatter?.title).toBe(title)
    expect(await readFileRaw(`${project.path}/wiki/index.md`)).toContain("# Wiki Index")
    expect(await readFileRaw(`${project.path}/wiki/log.md`)).toContain("# Wiki Log")
  })

  it("每次创建读取最新 schema，配置变更后不复用旧类型和目录", async () => {
    await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| reference | wiki/old/ |")
    await createPagesFromReview(project.path, item, "Create Page", config)
    await writeFileRaw(`${project.path}/schema.md`, "## Page Types\n| practice | wiki/new/ |")
    const [created] = await createPagesFromReview(project.path, item, "Create Page", config)

    expect(created.dir).toBe("new")
    expect(parseFrontmatter(await readFileRaw(created.filePath)).frontmatter?.type).toBe("practice")
  })

  it.each(["# 未配置 Page Types", "## Page Types\n| source | wiki/sources/ |", "## Page Types\n| reference | wiki/../outside/ |"])(
    "schema 缺少有效内容类型时不静默回退：%s", async (schema) => {
      await writeFileRaw(`${project.path}/schema.md`, schema)
      await expect(createPagesFromReview(project.path, item, "Create Page", config)).rejects.toThrow(/schema/)
      expect(await fileExists(`${project.path}/wiki`)).toBe(false)
      expect(streamChat).not.toHaveBeenCalled()
    },
  )

  it("旧项目不存在 schema 时仍保持原有创建行为", async () => {
    const [created] = await createPagesFromReview(project.path, item, "Create Page", config)

    expect(parseFrontmatter(await readFileRaw(created.filePath)).frontmatter?.type).toBe("entity")
    expect(created.dir).toBe("entities")
    expect(streamChat).not.toHaveBeenCalled()
  })
})
