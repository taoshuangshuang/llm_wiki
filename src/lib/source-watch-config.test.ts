import { describe, expect, it } from "vitest"
import {
  DEFAULT_SOURCE_WATCH_CONFIG,
  excludedSourceTitleKeyword,
  isPathAllowedBySourceWatch,
  normalizeSourceWatchConfig,
} from "@/lib/source-watch-config"
import sourceWatchDefaults from "@/lib/source-watch-defaults.json"

describe("source watch config", () => {
  it("includes AnyDoc Office and RTF variants in the default watch set", () => {
    for (const extension of ["docm", "ppt", "ppsm", "xlsb", "rtf"]) {
      expect(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions).toContain(extension)
    }
  })
  it("includes standalone image sources in the default watch set", () => {
    for (const extension of ["png", "jpg", "jpeg"]) {
      expect(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions).toContain(extension)
    }
  })

  it("upgrades the previous default extension set without changing custom lists", () => {
    const previousDefaults = DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions.filter(
      (extension) => !["png", "jpg", "jpeg"].includes(extension),
    )
    expect(normalizeSourceWatchConfig({ includeExtensions: previousDefaults }).includeExtensions)
      .toEqual([...previousDefaults, "png", "jpg", "jpeg"])
    expect(normalizeSourceWatchConfig({ includeExtensions: ["md", "pdf"] }).includeExtensions)
      .toEqual(["md", "pdf"])
  })
  it("uses the shared default fixture", () => {
    expect(DEFAULT_SOURCE_WATCH_CONFIG).toEqual(sourceWatchDefaults)
    expect(normalizeSourceWatchConfig({}).persistExtractedMarkdown).toBe(false)
    expect(normalizeSourceWatchConfig({}).generateSourceSummary).toBe(false)
    expect(normalizeSourceWatchConfig({ generateSourceSummary: true }).generateSourceSummary).toBe(true)
    expect(normalizeSourceWatchConfig({}).parsingConcurrency).toBe(2)
    expect(normalizeSourceWatchConfig({}).ingestConcurrency).toBe(1)
    expect(
      normalizeSourceWatchConfig({ persistExtractedMarkdown: true }).persistExtractedMarkdown,
    ).toBe(true)
    expect(normalizeSourceWatchConfig({ parsingConcurrency: 100 }).parsingConcurrency).toBe(64)
    expect(normalizeSourceWatchConfig({ ingestConcurrency: 100 }).ingestConcurrency).toBe(64)
    expect(normalizeSourceWatchConfig({ ingestConcurrency: 0 }).ingestConcurrency).toBe(1)
    expect(
      normalizeSourceWatchConfig({ parsingConcurrency: Number.NaN }).parsingConcurrency,
    ).toBe(2)
    expect(
      normalizeSourceWatchConfig({ ingestConcurrency: Number.NaN }).ingestConcurrency,
    ).toBe(1)
  })

  it("allows document types by default and rejects config/media/binaries", () => {
    expect(isPathAllowedBySourceWatch("raw/sources/report.pdf", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/notes.md", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/notes.org", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/report.doc", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/secrets.json", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/video.mp4", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/tool.exe", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
  })

  it("applies directory and glob exclusions", () => {
    const config = normalizeSourceWatchConfig({
      includeExtensions: ["md"],
      excludeDirs: [".obsidian", "drafts"],
      excludeGlobs: ["*.private.*", "~$*"],
    })

    expect(isPathAllowedBySourceWatch("raw/sources/ready.md", config)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/drafts/ready.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/subdir/drafts/ready.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/.obsidian/index.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/plan.private.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/~$Document.docx", config)).toBe(false)
  })

  it("normalizes comma-separated exclusion values from text fields", () => {
    const config = normalizeSourceWatchConfig({
      includeExtensions: ["md, pdf", "docx"],
      excludeExtensions: ["json, yaml\nxml，dll"],
      excludeDirs: [".git, node_modules", "drafts，wip"],
      excludeGlobs: ["*.private.*, ~$*"],
    })

    expect(config.includeExtensions).toEqual(["md", "pdf", "docx"])
    expect(config.excludeExtensions).toEqual(["json", "yaml", "xml", "dll"])
    expect(config.excludeDirs).toEqual([".git", "node_modules", "drafts", "wip"])
    expect(config.excludeGlobs).toEqual(["*.private.*", "~$*"])
  })
})


describe("标题排除规则", () => {
  it("仅匹配文件名及主标题，目录、正文、子章节和代码示例不排除整篇文档", () => {
    const keywords = ["周会", "压测", "绩效"]
    expect(excludedSourceTitleKeyword("/周会/说明.md", "# 服务说明\n正文讨论压测。\n## 绩效\n", keywords)).toBeUndefined()
    expect(excludedSourceTitleKeyword("说明.md", "```md\n# 周会\n```\n# 服务说明", keywords)).toBeUndefined()
    expect(excludedSourceTitleKeyword("说明.md", "---\ntitle: 服务压测报告\n---\n正文", keywords)).toBe("压测")
    expect(excludedSourceTitleKeyword("周会.md", "", keywords)).toBe("周会")
    expect(excludedSourceTitleKeyword("周会.md", "", [])).toBeUndefined()
  })
})
