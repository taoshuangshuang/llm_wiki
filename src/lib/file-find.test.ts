import { describe, expect, it } from "vitest"
import { findTextMatches } from "./file-find"

describe("文件内文本查找", () => {
  it("忽略大小写，并保留中文和原文偏移", () => {
    expect(findTextMatches("文件 Wiki 和 wiki", "WIKI")).toEqual([{ start: 3, end: 7 }, { start: 10, end: 14 }])
    expect(findTextMatches("中文中文", "中文")).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }])
  })

  it("将正则字符作为普通文本，不因特殊字符报错", () => {
    expect(findTextMatches("a.*[x] a.*[x]", ".*[x]")).toEqual([{ start: 1, end: 6 }, { start: 8, end: 13 }])
    expect(findTextMatches("path\\file", "\\")).toEqual([{ start: 4, end: 5 }])
  })

  it("空查询和未匹配查询返回空结果，大小写折叠不改变 Unicode 偏移", () => {
    expect(findTextMatches("文本", "")).toEqual([])
    expect(findTextMatches("文本", "无结果")).toEqual([])
    expect(findTextMatches("İx X", "x")).toEqual([{ start: 1, end: 2 }, { start: 3, end: 4 }])
  })
})
