import { describe, it, expect, beforeEach } from "vitest"
import {
  buildReviewSuggestionPrompt,
  buildAnalysisPrompt,
  buildChunkAnalysisSystemPrompt,
  buildGenerationPrompt,
  buildPageMergeSystemPrompt,
  computeIngestGenerationMaxTokens,
  computeIngestAnalysisMaxTokens,
  computeIngestReviewMaxTokens,
  computeIngestSourceBudget,
  formatIngestWarningLogEntry,
  splitSourceIntoSemanticChunks,
} from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"

beforeEach(() => {
  useWikiStore.getState().setOutputLanguage("auto")
})

describe("buildAnalysisPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildAnalysisPrompt("purpose", "index", "english source content")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("uses user setting even when source is in a different language", () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    const prompt = buildAnalysisPrompt("", "", "这段内容是中文")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Chinese")
  })

  it("auto mode falls back to detecting source content language", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildAnalysisPrompt("", "", "これは日本語の文章です")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
  })

  it("auto mode with empty source defaults to English", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })

  it("contains structural analysis sections", () => {
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("## Key Entities")
    expect(prompt).toContain("## Key Concepts")
    expect(prompt).toContain("## Main Arguments & Findings")
    expect(prompt).toContain("## Recommendations")
  })

  it("requires claims to stay attached to their named subject", () => {
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("Which named subject is each claim about")
    expect(prompt).toContain("Do not transfer claims, limits, or evaluations")
  })

  it("applies a significance and canonical-name threshold to entities", () => {
    const prompt = buildAnalysisPrompt("", "", "")

    expect(prompt).toContain("standalone-page significance threshold")
    expect(prompt).toContain("passing mentions")
    expect(prompt).toContain("ordinary story props")
    expect(prompt).toContain("unnamed or generic-role people")
    expect(prompt).toContain("Page-worthy: yes")
    expect(prompt).toContain("preserve the source spelling")
    expect(prompt).toContain("never invent or phonetically guess a name")
    expect(prompt).not.toContain("central vs. peripheral")
  })

  it("injects the project schema so analysis can recommend custom-typed pages", () => {
    const schema = "## Page Types\n| goal | wiki/goals/ | Outcomes |\n| habit | wiki/habits/ | Behaviours |"
    const prompt = buildAnalysisPrompt("", "", "", schema)
    expect(prompt).toContain("## Project Schema")
    expect(prompt).toContain("wiki/goals/")
    // Recommendations guidance must mention schema-defined types
    expect(prompt).toContain("goal, habit")
  })

  it("常规上下文为空时也保留模板标题，不再包裹判空条件", () => {
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("## Project Schema")
    expect(prompt).not.toContain("{{#schema_context}}")
  })

  it("does not invent schema content not present in the source", () => {
    const prompt = buildAnalysisPrompt("", "", "", "| goal | wiki/goals/ | x |")
    expect(prompt).toContain("never invent")
  })
})

describe("ingest warning log formatting", () => {
  it("records all warnings with timestamp and source identity", () => {
    const entry = formatIngestWarningLogEntry(
      "book.pdf",
      ["FILE block was truncated", "Aggregate repair failed"],
      new Date("2026-06-30T01:02:03.000Z"),
    )

    expect(entry).toContain("## 2026-06-30T01:02:03.000Z | book.pdf")
    expect(entry).toContain("1. FILE block was truncated")
    expect(entry).toContain("2. Aggregate repair failed")
  })
})

describe("buildGenerationPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildGenerationPrompt("schema", "purpose", "index", "source.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("honors Vietnamese setting", () => {
    useWikiStore.getState().setOutputLanguage("Vietnamese")
    const prompt = buildGenerationPrompt("", "", "", "file.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Vietnamese")
  })

  it("auto mode detects from source content", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildGenerationPrompt("", "", "", "file.pdf", undefined, "这是中文源文档内容")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("includes the source filename in output instructions", () => {
    const prompt = buildGenerationPrompt("", "", "", "my-paper.pdf")
    expect(prompt).toContain("my-paper.pdf")
  })

  it("tells the model to keep generated filenames aligned with the output language", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildGenerationPrompt("", "", "", "source.pdf")

    expect(prompt).toContain("文件名依据输出语言下的标题生成")
    expect(prompt).toContain("中文、日文和韩文保留原文字")
  })

  it("preserves technical proper nouns instead of translating them into the output language", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildGenerationPrompt("", "", "", "source.pdf")

    expect(prompt).toContain("专有名称、代码标识、技术术语")
    expect(prompt).toContain("GPT-5")
    expect(prompt).toContain("Transformer")
    expect(prompt).toContain("规范原文")
    expect(prompt).toContain("路径不直接使用 URL、引用字符串或完整论文标题")
    // 完整语言规则只保留一处；专有名称和技术术语保留来源写法。
    expect(prompt).toContain("来源已有的通行译名")
    expect(prompt).not.toContain("No exceptions — not even for page names")
  })

  it("tells generation to preserve subject and source boundaries", () => {
    const prompt = buildGenerationPrompt("", "", "", "source.pdf")

    expect(prompt).toContain("论断、限制、评价和比较归属于来源明确描述的主题")
    expect(prompt).toContain("不能仅因共享术语而混写事实")
    expect(prompt).toContain("跨主题比较写清对象和来源")
  })

  it("requires standalone entity pages to establish identity without promoting incidental mentions", () => {
    const prompt = buildGenerationPrompt("", "", "", "source.pdf")

    expect(prompt).toContain("独立实体页仅用于分析明确标记 `Page-worthy: yes`")
    expect(prompt).toContain("本次相关新稿")
    expect(prompt).toContain("实体或概念页先说明“是什么”")
    expect(prompt).not.toContain("stable, high-confidence public knowledge")
    expect(prompt).toContain("仅依据来源与项目规范组织新稿")
    expect(prompt).toContain("来源无法确认身份时不为该主体单独成页")
    expect(prompt).toContain("名称采用来源原始拼写")
    expect(prompt).toContain("Final Global Digest / final_global_digest 中的成页判断为准")
  })

  it("defers long-source entity significance decisions to the global digest", () => {
    const prompt = buildChunkAnalysisSystemPrompt("", "", "", "long source")
    const chunkStart = prompt.indexOf("## Chunk Analysis")
    const digestStart = prompt.indexOf("## Updated Global Digest")
    const entityRules = prompt.indexOf("Entity handling rules:")

    expect(chunkStart).toBeGreaterThanOrEqual(0)
    expect(digestStart).toBeGreaterThan(chunkStart)
    expect(entityRules).toBeGreaterThan(digestStart)
    expect(prompt).toContain("without making a final standalone-page decision from one chunk alone")
    expect(prompt).toContain("accumulate recurrence across chunks")
    expect(prompt).toContain("supporting chunks")
    expect(prompt).toContain("Page-worthy: yes")
  })

  it("makes project schema routing authoritative over default entity and concept folders", () => {
    const prompt = buildGenerationPrompt(
      "Use wiki/people/ for people. Use wiki/technologies/ for technical methods.",
      "",
      "",
      "source.pdf",
    )
    expect(prompt).toContain("## 项目规范与页面分类")
    expect(prompt).toContain("类型与目录优先采用 schema 的定义")
    expect(prompt).toContain("frontmatter type 与 FILE 目录保持一致")
    expect(prompt).toContain("实体使用 entity / wiki/entities/")
    expect(prompt).not.toContain("Entity pages in wiki/entities/ for key entities")
  })

  it("respects user setting regardless of source content language", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const prompt = buildGenerationPrompt("", "", "", "x.pdf", undefined, "私は日本語の文章を書きます")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Japanese")
  })
})

describe("analysis + generation prompt consistency", () => {
  // Both stages MUST declare the same target language — otherwise the wiki
  // files generated in stage 2 may disagree with the analysis from stage 1.
  it("both stages declare the same language for a given setting", () => {
    useWikiStore.getState().setOutputLanguage("Korean")
    const analysis = buildAnalysisPrompt("", "", "")
    const generation = buildGenerationPrompt("", "", "", "f.pdf")
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("both stages in auto mode agree on detected language from source", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const korean = "이것은 한국어 문장입니다"
    const analysis = buildAnalysisPrompt("", "", korean)
    const generation = buildGenerationPrompt("", "", "", "f.pdf", undefined, korean)
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })
})

describe("page merge prompt", () => {
  it("keeps comparisons attribution-exact instead of folding them into the main subject", () => {
    const prompt = buildPageMergeSystemPrompt()
    expect(prompt).toContain("inputs are internal containers, not revisions or competing versions")
    expect(prompt).toContain("may mention additional subjects for comparison or context")
    expect(prompt).toContain("keep those comparisons attribution-exact")
    expect(prompt).toContain("do not fold them into claims about the main page subject")
    expect(prompt).toContain("prefer keeping them separate")
    expect(prompt).toContain("attribute a claim to a real source filename only when the supporting file is unambiguous")
    expect(prompt).toContain("otherwise do not guess")
    expect(prompt).toContain("Never create comparison sections/tables about the merge inputs")
    expect(prompt).toContain("Never invent URLs")
    expect(prompt).not.toContain("describe the same entity")
  })
})

describe("旧审阅模板兼容与搜索词规则移除", () => {
  it("旧审阅模板保留来源材料，不再注入搜索词生成规则", () => {
    const prompt = buildReviewSuggestionPrompt(
      "A private cognitive-analysis project",
      "- [[attention-filter]]",
      "internal-notes.md",
      "AF is the project's attention-filter signal.",
      "The pipeline dispatches AF events between internal modules.",
      "---FILE: wiki/concepts/attention-filter.md---",
      128_000,
    )

    expect(prompt).not.toContain("project-local vocabulary")
    expect(prompt).not.toContain("Never emit a bare ambiguous term as a web query")
    expect(prompt).not.toContain("Do not substitute a popular public meaning")
    expect(prompt).not.toContain("SEARCH:")
    expect(prompt).toContain("AF is the project's attention-filter signal")
  })

  it("keeps formal reviews and web query generation out of the page generation path", () => {
    const prompt = buildGenerationPrompt(
      "A private cognitive-analysis project",
      "- [[attention-filter]]",
      "Project overview",
      "internal-notes.md",
      "AF is the project's attention-filter signal.",
    )

    expect(prompt).toContain("本阶段只输出完整 FILE 块")
    expect(prompt).not.toContain("OPTIONS: Create Page")
    expect(prompt).not.toContain("SEARCH:")
  })
})

describe("long-source ingest planning", () => {
  it.each([
    ["目录点线", `查询方案${".".repeat(2100)}45`],
    ["连续中英文标点", `？！${".!?。！？".repeat(400)}结束`],
    ["短句后接超长句", `开头。${"甲".repeat(2400)}。结尾。`],
    ["超长标题", `# ${"查询方案".repeat(600)}`],
  ])("细分%s时保留全部非空白字符及其顺序", (_scenario, content) => {
    // 模拟分析截断后的减半细分，校验公开输出契约，不依赖内部切分步骤。
    const target = Math.floor(content.length / 2)
    const chunks = splitSourceIntoSemanticChunks(content, target, 80)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.main.length <= target * 1.25)).toBe(true)
    expect(chunks.map((chunk) => chunk.main).join("").replace(/\s/g, ""))
      .toBe(content.replace(/\s/g, ""))
  })

  it("scales generation output tokens with the configured context window", () => {
    expect(computeIngestGenerationMaxTokens(64_000)).toBe(8_192)
    expect(computeIngestGenerationMaxTokens(128_000)).toBe(16_384)
    expect(computeIngestGenerationMaxTokens(256_000)).toBe(24_576)
    expect(computeIngestGenerationMaxTokens(1_000_000)).toBe(32_768)
    expect(computeIngestAnalysisMaxTokens(64_000)).toBe(4_096)
    expect(computeIngestAnalysisMaxTokens(128_000)).toBe(4_800)
    expect(computeIngestAnalysisMaxTokens(256_000)).toBe(9_600)
    expect(computeIngestAnalysisMaxTokens(512_000)).toBe(19_200)
    expect(computeIngestAnalysisMaxTokens(1_000_000)).toBe(32_768)
    expect(computeIngestReviewMaxTokens(1_000_000)).toBe(8_192)
  })

  it("scales source budget from the configured context window instead of a fixed 50k cap", () => {
    const small = computeIngestSourceBudget(64_000, 8_000)
    const large = computeIngestSourceBudget(1_000_000, 8_000)

    expect(small).toBeGreaterThan(20_000)
    expect(large).toBeGreaterThan(200_000)
    expect(large).toBeLessThanOrEqual(300_000)
  })

  it("splits long sources on heading and paragraph boundaries with overlap", () => {
    const content = [
      "# Chapter One",
      "",
      "A".repeat(1200),
      "",
      "B".repeat(1200),
      "",
      "## Section Two",
      "",
      "C".repeat(1200),
      "",
      "D".repeat(1200),
    ].join("\n")

    const chunks = splitSourceIntoSemanticChunks(content, 1800, 200)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].headingPath).toBe("Chapter One")
    expect(chunks.some((chunk) => chunk.headingPath.includes("Section Two"))).toBe(true)
    expect(chunks[1].overlapBefore.length).toBeGreaterThan(0)
    expect(chunks[1].main.startsWith(chunks[0].main.slice(-200))).toBe(false)
  })
})
