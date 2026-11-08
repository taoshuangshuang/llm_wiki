import { describe, it, expect } from "vitest"
import {
  normalizeMalformedWikilinks,
  normalizeWikiFileLinks,
  sanitizeIngestedFileContent,
} from "./ingest-sanitize"

describe("文件名引用约定", () => {
  const paths = ["wiki/constraints/查询边界.md", "wiki/concepts/实际文件.md", "wiki/interfaces/接口#get.md"]

  // 依据实际文件路径转换，不用页面标题猜测文件名；锚点与显示文字必须保留。
  it("统一路径和扩展名，并保留章节、块引用和别名", () => {
    const input = "[[constraints/查询边界]] [[wiki/concepts/实际文件.md#范围|说明]] [[./constraints/查询边界#^block]] [[interfaces/接口#get.md]]"
    expect(normalizeWikiFileLinks(input, paths)).toBe("[[查询边界]] [[实际文件#范围|说明]] [[查询边界#^block]] [[接口#get]]")
  })

  it("不改写代码、媒体嵌入、来源字段和无法确认的目标", () => {
    const input = "---\nsources: [constraints/查询边界.md]\n---\n`[[constraints/查询边界]]` ![[constraints/查询边界]] [[unknown/未知]]\n```md\n[[constraints/查询边界]]\n```\n[[constraints/查询边界]]"
    expect(normalizeWikiFileLinks(input, paths)).toBe(input.replace(/\[\[constraints\/查询边界\]\]$/, "[[查询边界]]"))
  })

  it("同名文件不丢弃路径，重复执行结果不变", () => {
    const input = "[[constraints/查询边界]] [[concepts/查询边界]]"
    expect(normalizeWikiFileLinks(input, [...paths, "wiki/concepts/查询边界.md"])).toBe(input)
    const normalized = normalizeWikiFileLinks("[[constraints/查询边界#范围|说明]]", paths)
    expect(normalizeWikiFileLinks(normalized, paths)).toBe(normalized)
  })

  it("将有明确文件依据的历史标题引用转成文件名，不截断标题中的斜线和井号", () => {
    const titles = new Map([["数据库规范（MySQL/Oracle）", "wiki/concepts/实际文件.md"], ["接口#get", "wiki/interfaces/接口#get.md"]])
    expect(normalizeWikiFileLinks("[[数据库规范（MySQL/Oracle）#范围|规范]] [[接口#get]]", paths, titles))
      .toBe("[[实际文件#范围|规范]] [[接口#get]]")
  })

  it("文件名优先于其他页面的同名标题", () => {
    expect(normalizeWikiFileLinks("[[查询边界.md#范围]]", paths, new Map([["查询边界", "wiki/concepts/实际文件.md"]])))
      .toBe("[[查询边界#范围]]")
  })

  // 模型写出的引用与实际文件名常只差空格或大小写，这类引用不应作为失效引用留到审核。
  it("忽略空格与大小写差异后唯一时改写为实际文件名，并保留锚点与别名", () => {
    const spaced = ["wiki/cases/工单分析-2025.11 元数据工单记录.md", "wiki/interfaces/BizObject API.md"]
    expect(normalizeWikiFileLinks("[[工单分析-2025.11元数据工单记录#主要发现|记录]] [[bizobject\u3000api]]", spaced))
      .toBe("[[工单分析-2025.11 元数据工单记录#主要发现|记录]] [[BizObject API]]")
    const titles = new Map([["查询 边界 说明", "wiki/concepts/实际文件.md"]])
    expect(normalizeWikiFileLinks("[[查询边界说明]]", paths, titles)).toBe("[[实际文件]]")
  })

  it("归一化后仍有多个候选时保持原引用", () => {
    const ambiguous = [...paths, "wiki/cases/查询 边界.md"]
    expect(normalizeWikiFileLinks("[[查询边 界]]", ambiguous)).toBe("[[查询边 界]]")
  })
})

describe("sanitizeIngestedFileContent", () => {
  it("returns clean content unchanged", () => {
    const input = `---\ntype: entity\ntitle: Foo\n---\n\n# Foo\n\nbody`
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("strips a ```yaml-wrapped document and leaves the frontmatter block standard", () => {
    const input =
      "```yaml\n---\ntype: entity\ntitle: Accumulibacter\n---\n\n# Body\n```"
    const out = sanitizeIngestedFileContent(input)
    expect(out).toBe("---\ntype: entity\ntitle: Accumulibacter\n---\n\n# Body")
  })

  it("strips a ```md-wrapped document", () => {
    const input = "```md\n---\ntype: x\n---\nbody\n```"
    const out = sanitizeIngestedFileContent(input)
    expect(out).toBe("---\ntype: x\n---\nbody")
  })

  it("strips a ```markdown-wrapped document", () => {
    const input = "```markdown\n---\ntype: x\n---\nbody\n```"
    expect(sanitizeIngestedFileContent(input)).toBe("---\ntype: x\n---\nbody")
  })

  it("strips a bare ```-wrapped document (no lang)", () => {
    const input = "```\n---\ntype: x\n---\nbody\n```"
    expect(sanitizeIngestedFileContent(input)).toBe("---\ntype: x\n---\nbody")
  })

  it("strips a ```yaml fence wrapping only the frontmatter", () => {
    const input = "```yaml\n---\ntype: x\n---\n```\n\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe("---\ntype: x\n---\n\n# Body")
  })

  it("strips a frontmatter fence after leading blank lines with a case-insensitive label", () => {
    const input = "\n  \n```YAML\n---\ntype: x\n---\n```\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe("---\ntype: x\n---\n# Body")
  })

  it("strips a CRLF fence around empty frontmatter", () => {
    const input = "```yaml\r\n---\r\n---\r\n```\r\n\r\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe("---\r\n---\r\n\r\n# Body")
  })

  it("does NOT strip a non-fence-wrapped document containing a fenced code block in the body", () => {
    const input =
      "---\ntype: x\n---\n\n# Heading\n\n```js\nconsole.log('hi')\n```\n\nmore body"
    // The leading line is `---`, not a fence opener, so stripping
    // doesn't fire. Body fences are preserved verbatim.
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("does NOT strip a partially-fenced document (open fence but no matching close)", () => {
    const input = "```yaml\n---\ntype: x\n---\nbody"
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("strips a leading `frontmatter:` key prefix when followed by a real --- block", () => {
    const input =
      "frontmatter:\n---\ntype: entity\ntitle: LSTM\n---\n\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe(
      "---\ntype: entity\ntitle: LSTM\n---\n\n# Body",
    )
  })

  it("repairs a missing opening frontmatter fence when the closing fence is present", () => {
    const input =
      "\n\ntype: entity\ntitle: \"Foo: Bar\"\nsources: [foo.pdf]\n---\n\n# Foo\n\nBody"
    expect(sanitizeIngestedFileContent(input)).toBe(
      "---\ntype: entity\ntitle: \"Foo: Bar\"\nsources: [foo.pdf]\n---\n\n# Foo\n\nBody",
    )
  })

  it("does NOT invent frontmatter when a body line only looks like metadata", () => {
    const input = "title: A research question\n\n# Notes\n\nBody"
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("does NOT strip the word `frontmatter:` when it appears mid-document (in prose)", () => {
    const input = "---\ntype: x\n---\n\nThe frontmatter: of this doc is above."
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("repairs an invalid `key: [[a]], [[b]]` wikilink list inside frontmatter", () => {
    const input =
      "---\ntype: entity\nrelated: [[a]], [[b]], [[c]]\n---\n\nbody"
    expect(sanitizeIngestedFileContent(input)).toBe(
      `---\ntype: entity\nrelated: ["[[a]]", "[[b]]", "[[c]]"]\n---\n\nbody`,
    )
  })

  it("repairs a wikilink list without corrupting CRLF frontmatter", () => {
    const input = "---\r\ntype: entity\r\nrelated: [[a]], [[b]]\r\n---\r\n# Body\r\n"
    expect(sanitizeIngestedFileContent(input)).toBe(
      "---\r\ntype: entity\r\nrelated: [\"[[a]]\", \"[[b]]\"]\r\n---\r\n# Body\r\n",
    )
  })

  it("doesn't touch a single `key: [[a]]` (not a list — leave the user's intent alone)", () => {
    const input = `---\nrelated: [[a]]\n---\nbody`
    // Single-element nested-array form is rare but legal YAML;
    // we only repair the multi-comma form which is unambiguously
    // an LLM mistake.
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("doesn't touch wikilink-style text that appears in the body", () => {
    const input = "---\ntype: x\n---\n\nrelated: [[a]], [[b]] in body prose"
    // Repair only fires inside the frontmatter block; body
    // content is verbatim.
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("composes all three repairs on a real-corpus-shaped input", () => {
    const input =
      "```yaml\nfrontmatter:\n---\ntype: entity\nrelated: [[a]], [[b]]\n---\n\n# Body\n```"
    const out = sanitizeIngestedFileContent(input)
    expect(out).toBe(
      `---\ntype: entity\nrelated: ["[[a]]", "[[b]]"]\n---\n\n# Body`,
    )
  })
})

describe("normalizeMalformedWikilinks", () => {
  it("converts numeric wikilinks and wrapped citation sequences to citations", () => {
    const input = "One [[1]], several [[12], [14], [15]], and page [[2026]]."
    expect(normalizeMalformedWikilinks(input)).toBe(
      "One [1], several [12], [14], [15], and page [[2026]].",
    )
  })

  it("repairs an aliased wikilink with one missing closing bracket", () => {
    expect(normalizeMalformedWikilinks("See **[[target|label]** now."))
      .toBe("See **[[target|label]]** now.")
  })

  it("preserves frontmatter, code, embeds, and Markdown links", () => {
    const input = [
      "---",
      "related: ['[[4]]']",
      "---",
      "`[[5]]` and ![[asset|preview]",
      "[label](https://example.test) with [[target|alias]",
      "```md",
      "[[6]] [[code|sample]",
      "```",
    ].join("\n")
    expect(normalizeMalformedWikilinks(input)).toBe(input)
  })

  it.each([
    "[[1]](https://example.test)",
    "![[1]]",
    "[[2024]]",
    "[[a|b]]",
    "[[a]",
    "[[a|see [1]]",
    "[[a|b]]]",
  ])("does not rewrite valid or ambiguous syntax: %s", (input) => {
    expect(normalizeMalformedWikilinks(input)).toBe(input)
  })

  it("preserves numeric wikilinks in inline and blockquoted fenced code", () => {
    const input = [
      "a `` b `[[1]]` c",
      "> ```md",
      "> [[2]]",
      "> ```",
      "> > ~~~~md",
      "> > [[3]]",
      "> > ~~~~",
    ].join("\n")
    expect(normalizeMalformedWikilinks(input)).toBe(input)
  })

  it("recognizes empty frontmatter and preserves CRLF", () => {
    expect(normalizeMalformedWikilinks("---\n---\nbody [[1]]\n---\nx"))
      .toBe("---\n---\nbody [1]\n---\nx")
    expect(normalizeMalformedWikilinks("x\r\n[[1]]\r\n"))
      .toBe("x\r\n[1]\r\n")
  })

  it("does not mistake body horizontal rules for frontmatter", () => {
    const input = "Intro\n\n---\n\nSee [[1]]\n\n---\n\nTail [[2]]\n"
    expect(normalizeMalformedWikilinks(input)).toBe(
      "Intro\n\n---\n\nSee [1]\n\n---\n\nTail [2]\n",
    )
  })

  it("normalizes nested list citations while preserving code and math blocks", () => {
    const input = [
      "- item",
      "    - nested [[1]]",
      "    const matrix = [[2]]",
      "$$",
      "[[3], [4]]",
      "$$",
      "<pre>",
      "[[5]]",
      "</pre>",
    ].join("\n")
    expect(normalizeMalformedWikilinks(input)).toBe([
      "- item",
      "    - nested [1]",
      "    const matrix = [[2]]",
      "$$",
      "[[3], [4]]",
      "$$",
      "<pre>",
      "[[5]]",
      "</pre>",
    ].join("\n"))
  })

  it("preserves BOM frontmatter and is idempotent for triple brackets", () => {
    const input = "\uFEFF---\nrelated: ['[[1]]']\n---\n[[[1]]] and [[2]]"
    const once = normalizeMalformedWikilinks(input)
    expect(once).toBe("\uFEFF---\nrelated: ['[[1]]']\n---\n[[[1]]] and [2]")
    expect(normalizeMalformedWikilinks(once)).toBe(once)
  })

  it("applies body normalization through the public ingest sanitizer", () => {
    const input = "---\ntype: entity\nrelated: ['[[4]]']\n---\nBody [[1]] and [[target|alias]"
    expect(sanitizeIngestedFileContent(input)).toBe(
      "---\ntype: entity\nrelated: ['[[4]]']\n---\nBody [1] and [[target|alias]]",
    )
  })

  it("is idempotent", () => {
    const once = normalizeMalformedWikilinks("[[1]] [[target|alias] [[2], [3]]")
    expect(normalizeMalformedWikilinks(once)).toBe(once)
  })
})
