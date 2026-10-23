/**
 * wiki-graph.test.ts — regression tests for frontmatter-scoped title/type extraction
 *
 * extractTitle/extractType previously searched for `title:`/`type:` anywhere in the
 * whole file content, not just inside the `---...---` frontmatter block, because the
 * lazy `[\s\S]*?` in their regexes was never required to stop at the closing `---`.
 * A body line that merely starts with `title:` or `type:` (plain prose, not YAML)
 * could be misread as the frontmatter value.
 */
import { describe, it, expect, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const mockListDirectory = vi.fn()
const mockReadFile = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => mockListDirectory(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

async function loadBuildWikiGraph() {
  const mod = await import("../wiki-graph")
  return mod.buildWikiGraph
}

function mdFile(name: string): FileNode {
  return { name, path: `/project/wiki/${name}`, is_dir: false }
}

describe("buildWikiGraph frontmatter extraction", () => {
  it("excludes source summaries and their links before counting knowledge relationships", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    const projectPath = "/knowledge-only-graph"
    const sourcePath = `${projectPath}/wiki/sources/原始资料摘要.md`
    const customSourcePath = `${projectPath}/wiki/archive/来源摘要.md`
    const conceptPath = `${projectPath}/wiki/concepts/概念.md`
    const designPath = `${projectPath}/wiki/designs/设计.md`
    mockListDirectory.mockResolvedValue([
      { name: "sources", path: `${projectPath}/wiki/sources`, is_dir: true, children: [
        { name: "原始资料摘要.md", path: sourcePath, is_dir: false },
      ] },
      { name: "来源摘要.md", path: customSourcePath, is_dir: false },
      { name: "概念.md", path: conceptPath, is_dir: false },
      { name: "设计.md", path: designPath, is_dir: false },
    ])
    const contents: Record<string, string> = {
      // 旧来源页即使没有 type，也应按目录排除。
      [sourcePath]: "# 原始资料摘要\n\n[[概念]]\n[[设计]]",
      [customSourcePath]: "---\ntype: Source\nrelated: [概念, 设计]\n---\n# 来源摘要",
      [conceptPath]: "---\ntype: concept\n---\n# 概念\n\n[[设计]]\n[[来源摘要]]",
      [designPath]: "---\ntype: design\n---\n# 设计",
    }
    mockReadFile.mockImplementation(async (path: string) => contents[path] ?? "")

    const graph = await buildWikiGraph(projectPath)

    // 来源页及其关联不影响节点数量、连线、连接数或社区统计。
    expect(graph.nodes.map((node) => node.id)).toEqual(["概念", "设计"])
    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "概念", target: "设计" }),
    ])
    expect(graph.nodes.map((node) => node.linkCount)).toEqual([1, 1])
    expect(graph.communities.reduce((total, community) => total + community.nodeCount, 0)).toBe(2)
  })

  it("does not read a title: line from the document body as the frontmatter title", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\ntype: entity\n---\n# Real Heading\n\nSome text.\ntitle: not-frontmatter-at-all\n",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0].label).toBe("Real Heading")
  })

  it("does not read a type: line from the document body as the frontmatter type", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\ntitle: Real Page\n---\n# Real Page\n\nSome text.\ntype: query\nMore text.\n",
    )

    const graph = await buildWikiGraph("/project")

    // A misread type of "query" would match HIDDEN_TYPES and silently drop the page.
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0].type).toBe("other")
  })

  it("parses CRLF frontmatter consistently with the rest of the application", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\r\ntitle: CRLF Page\r\ntype: entity\r\n---\r\n# Fallback Heading\r\n",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ label: "CRLF Page", type: "entity" })
  })

  it("uses YAML parsing for quoted values that contain a colon", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      '---\ntitle: "Attention: Architecture"\ntype: "Concept"\n---\n# Fallback Heading\n',
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ label: "Attention: Architecture", type: "concept" })
  })

  it("resolves case and space variants without dropping links", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([
      mdFile("Source.md"),
      mdFile("target-page.md"),
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.endsWith("Source.md")
        ? "# Source\n\n[[Target Page]]"
        : "# Target",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "Source", target: "target-page" }),
    ])
  })

  it("includes frontmatter related entries as graph edges", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([
      mdFile("source.md"),
      mdFile("target.md"),
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.endsWith("source.md")
        ? "---\nrelated: [wiki/concepts/target.md]\n---\n# Source"
        : "# Target",
    )

    const graph = await buildWikiGraph("/related-project")

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "source", target: "target" }),
    ])
  })

  it("prefers an exact page id when case-folded aliases collide", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([
      mdFile("source.md"),
      mdFile("Foo.md"),
      mdFile("foo.md"),
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.endsWith("source.md") ? "# Source\n\n[[foo]]" : "# Target",
    )

    const graph = await buildWikiGraph("/case-project")

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "source", target: "foo" }),
    ])
  })

  it("reuses an unchanged graph by project data version", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockClear()
    mockReadFile.mockClear()
    mockListDirectory.mockResolvedValue([mdFile("cached.md")])
    mockReadFile.mockResolvedValue("# Cached")

    const first = await buildWikiGraph("/cached-project", 42)
    const second = await buildWikiGraph("/cached-project", 42)

    expect(second).toBe(first)
    // The first graph build reads once for graph topology and once for
    // relevance metadata; the second call is fully served by the cache.
    expect(mockListDirectory).toHaveBeenCalledTimes(2)
    expect(mockReadFile).toHaveBeenCalledTimes(2)
  })
})
