import { describe, expect, it } from "vitest"
import { assessIngestSource } from "./ingest-source-content"

describe("来源正文前置过滤", () => {
  it.each([
    ["", "empty"], [" \n\t\u200b\ufeff", "empty"],
    ["# 自动建表\n\n## 流程\n### 注意事项", "headings-only"],
    ["自动建表\n===\n\n流程\n---", "headings-only"],
    ["自动建表", "headings-only"], ["# 自动建表\nTODO", "placeholder-only"],
    ["---\ntitle: 自动建表\ntags: [设计]\n---\n<!-- 待补充 -->", "structure-only"],
    ["***\n---\n……！！！\n😀", "structure-only"],
    ["- [ ]\n- [x]\n>\n| | |\n| --- | :---: |", "structure-only"],
    ["```typescript\n\n```\n~~~json\n{}\n~~~", "structure-only"],
    ["<div>&nbsp;<br></div>", "structure-only"],
    ["# 自动建表\n- TODO\n- 待补充。", "placeholder-only"],
  ])("过滤无正文输入：%j", (content, reason) => {
    expect(assessIngestSource(content, "raw/sources/自动建表.md")?.reason).toBe(reason)
  })

  // 短文本不等于无意义；结构内部的真实信息和图片仍交给原来的分析流程。
  it.each([
    "支持重试。", "OK", "# 说明\n支持重试。", "- 最大重试次数：3", "| 1 | 2 |\n|---|---|",
    "```java\nreturn true;\n```", "```sh\n# 查看状态\n```", "https://example.com/docs",
    "[接口说明](https://example.com)", "<https://example.com/docs>", "![](diagram.png)", "![架构图][diagram]\n[diagram]: diagram.png",
    '<img src="diagram.png">', "<div>正常正文</div>", "# 限制\nTODO 字段表示待办状态。",
  ])("保留可能包含知识的输入：%j", (content) => {
    expect(assessIngestSource(content, "raw/sources/自动建表.md")).toBeUndefined()
  })
})
