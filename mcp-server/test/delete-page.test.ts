import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

/** 使用真正的 MCP 进程和临时 HTTP 服务，验证工具发现、项目绑定与四个文件管理工具的调用。 */
test("MCP discovers file tools and calls the scoped authenticated lifecycle endpoints", async () => {
  const calls: string[] = []
  const project = { id: "project-a", name: "测试", path: "/temporary/project", current: true }
  const http = createServer(async (req, res) => {
    const url = req.url ?? ""
    if (url !== "/api/v1/health") assert.equal(req.headers.authorization, "Bearer test-only-token")
    let raw = ""
    for await (const chunk of req) raw += String(chunk)
    const body: unknown = raw ? JSON.parse(raw) : undefined
    calls.push(url)
    res.setHeader("Content-Type", "application/json")
    if (url === "/api/v1/health") res.end(JSON.stringify({ status: "running", mcpEnabled: true }))
    else if (url === "/api/v1/projects") res.end(JSON.stringify({ projects: [project], currentProject: project }))
    else if (url.startsWith("/api/v1/projects/project-a/pages?")) {
      const params = new URL(url, "http://test").searchParams
      assert.equal(params.get("prefix"), "wiki/concepts/")
      res.end(JSON.stringify({ ok: true, result: { pages: [{ path: "wiki/concepts/old.md", bytes: 10 }], total: 1, offset: 0, nextOffset: null, truncated: false, snapshot: "sha256:list" } }))
    } else if (url === "/api/v1/projects/project-a/sources/read") {
      assert.deepEqual(body, { path: "raw/sources/doc.md", startLine: 2, endLine: 3, maxChars: 100, revision: "sha256:source" })
      res.end(JSON.stringify({ ok: true, result: { path: "raw/sources/doc.md", content: "原文  保留\n", revision: "sha256:source", totalLines: 3, startLine: 2, startColumn: 1, endLine: 3, nextStartLine: null, nextStartColumn: null, truncated: false, representation: "original_text" } }))
    } else if (url === "/api/v1/projects/project-a/pages/move") {
      assert.deepEqual(body, { path: "wiki/concepts/old.md", toPath: "wiki/data/new.md", expectedRevision: "sha256:old" })
      res.end(JSON.stringify({ ok: true, result: { fromPath: "wiki/concepts/old.md", toPath: "wiki/data/new.md", rewrittenPaths: ["wiki/data/new.md"], indexingPendingPaths: ["wiki/data/new.md"], warnings: [], verified: true } }))
    }
    else if (url === "/api/v1/projects/project-a/pages/delete") {
      assert.equal(req.method, "POST")
      assert.deepEqual(body, { path: "wiki/concepts/old.md" })
      res.end(JSON.stringify({ ok: true, result: {
        deletedPaths: ["wiki/concepts/old.md"], rewrittenPaths: ["wiki/index.md"],
        rewrittenFiles: 1, warnings: [], verified: true,
      } }))
    } else { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: "unexpected request" })) }
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  assert.ok(address && typeof address !== "string")
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      LLM_WIKI_API_BASE_URL: `http://127.0.0.1:${address.port}`, LLM_WIKI_API_TOKEN: "test-only-token",
    },
  })
  const client = new Client({ name: "deletion-test", version: "1" })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    for (const name of ["llm_wiki_list_pages", "llm_wiki_read_source", "llm_wiki_move_page", "llm_wiki_delete_page"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name))
    }
    await client.callTool({ name: "llm_wiki_set_project", arguments: { project_id: "current" } })
    const listed = await client.callTool({ name: "llm_wiki_list_pages", arguments: { prefix: "wiki/concepts/", limit: 10 } })
    assert.ok(JSON.stringify(listed).includes("sha256:list"))
    const read = await client.callTool({ name: "llm_wiki_read_source", arguments: { path: "raw/sources/doc.md", start_line: 2, end_line: 3, max_chars: 100, revision: "sha256:source" } })
    assert.ok(JSON.stringify(read).includes("原文  保留"))
    const moved = await client.callTool({ name: "llm_wiki_move_page", arguments: { path: "wiki/concepts/old.md", to_path: "wiki/data/new.md", expected_revision: "sha256:old" } })
    assert.ok(JSON.stringify(moved).includes("wiki/data/new.md"))
    const result = await client.callTool({ name: "llm_wiki_delete_page", arguments: { path: "wiki/concepts/old.md" } })
    assert.ok(JSON.stringify(result).includes("wiki/concepts/old.md"))
    assert.ok(calls.includes("/api/v1/projects/project-a/pages/delete"))
    const before = calls.length
    await assert.rejects(client.callTool({ name: "llm_wiki_delete_page", arguments: { path: "../outside.md" } }))
    await assert.rejects(client.callTool({ name: "llm_wiki_delete_page", arguments: { project_id: "another-project", path: "wiki/old.md" } }))
    await assert.rejects(client.callTool({ name: "llm_wiki_read_source", arguments: { path: "raw/sources/.cache/private.txt" } }))
    await assert.rejects(client.callTool({ name: "llm_wiki_move_page", arguments: { path: "wiki/old.md", to_path: "../outside.md" } }))
    await assert.rejects(client.callTool({ name: "llm_wiki_move_page", arguments: { project_id: "another-project", path: "wiki/old.md", to_path: "wiki/new.md" } }))
    await assert.rejects(client.callTool({ name: "llm_wiki_list_pages", arguments: { project_id: "another-project" } }))
    assert.ok(calls.slice(before).every((path) => path === "/api/v1/health"), "非法路径和跨项目请求不能调用删除接口")
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
  }
})
