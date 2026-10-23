import { describe, expect, it } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import { availableReviewPageFileName, createReviewPageDrafts } from "./review-create-page"
import { parseWikiSchemaRouting } from "./wiki-schema"

function review(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "review-1",
    type: "missing-page",
    title: "Missing page",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...overrides,
  }
}

describe("createReviewPageDrafts", () => {
  it("从待审阅创建页面时，类型和目录必须遵守项目 schema", () => {
    const routing = parseWikiSchemaRouting("## Page Types\n| Type | Directory |\n| concept | wiki/knowledge/terms/ |")
    const drafts = createReviewPageDrafts(review({ title: "缺少概念页面：查询模型" }), "Create Page", routing)

    expect(drafts).toEqual([{ title: "查询模型", pageType: "concept", dir: "knowledge/terms" }])
  })

  it("schema 未声明 entity 时，不得因为正文提到实体就创建实体分类", () => {
    const routing = parseWikiSchemaRouting("## Page Types\n| Type | Directory |\n| data-model | wiki/data-models/ |")

    expect(() => createReviewPageDrafts(review({ title: "实体存储结构" }), "Create Page", routing))
      .toThrow(/schema/)
  })

  it("creates one entity page per missing entity named in Chinese review text", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "核心测试项实体页缺失：CallMethod、StartFunc、Print",
        description: "缺少 CallMethod、StartFunc、Print 等实体页面。",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "CallMethod", pageType: "entity", dir: "entities" },
      { title: "StartFunc", pageType: "entity", dir: "entities" },
      { title: "Print", pageType: "entity", dir: "entities" },
    ])
  })

  it("keeps non-missing review creation as a single query page", () => {
    const drafts = createReviewPageDrafts(
      review({
        type: "suggestion",
        title: "Create: Policy version gap",
        description: "Review the policy changes.",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Policy version gap", pageType: "query", dir: "queries" },
    ])
  })
})

describe("availableReviewPageFileName", () => {
  const now = new Date("2026-09-16T12:34:56.000Z")

  it("uses a stable slug when the destination is free", async () => {
    await expect(availableReviewPageFileName("Clash Detection", async () => false, now)).resolves.toEqual({
      fileName: "clash-detection.md",
      date: "2026-09-16",
    })
  })

  it("adds a timestamp only when the stable slug already exists", async () => {
    const result = await availableReviewPageFileName(
      "Clash Detection",
      async (fileName) => fileName === "clash-detection.md",
      now,
    )
    expect(result.fileName).toBe("clash-detection-2026-09-16-123456.md")
  })

  it("adds a numeric suffix when both stable and timestamped names exist", async () => {
    const existing = new Set([
      "clash-detection.md",
      "clash-detection-2026-09-16-123456.md",
      "clash-detection-2026-09-16-123456-2.md",
    ])
    const result = await availableReviewPageFileName(
      "Clash Detection",
      async (fileName) => existing.has(fileName),
      now,
    )
    expect(result.fileName).toBe("clash-detection-2026-09-16-123456-3.md")
  })
})
