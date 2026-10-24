/** 临时诊断：缺少文件结束标记时，不应把后续知识页吞进前一篇。 */
import { describe, expect, it } from "vitest"
import { parseFileBlocks } from "./ingest"

describe("入库文件边界诊断", () => {
  it("正常的两个文件块可以分别识别", () => {
    const output = [
      "---FILE: wiki/concepts/first.md---", "# 第一篇", "---END FILE---",
      "---FILE: wiki/concepts/second.md---", "# 第二篇", "---END FILE---",
    ].join("\n")
    expect(parseFileBlocks(output).blocks.map((block) => block.path)).toEqual([
      "wiki/concepts/first.md", "wiki/concepts/second.md",
    ])
  })

  it("前一个文件缺少结束标记时，必须报告协议异常而非静默吞并", () => {
    const output = [
      "---FILE: wiki/concepts/first.md---", "# 第一篇",
      "---FILE: wiki/concepts/second.md---", "# 第二篇", "---END FILE---",
    ].join("\n")
    const result = parseFileBlocks(output)
    console.info("文件边界诊断结果", JSON.stringify(result))
    expect(result.warnings.length + result.truncatedPaths.length).toBeGreaterThan(0)
    expect(result.blocks.every((block) => !block.content.includes("---FILE:"))).toBe(true)
  })
})
