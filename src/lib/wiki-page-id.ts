/**
 * 校验 wiki 相对路径去除 .md 后的页面 ID，与 Rust vectorstore 的约定一致。
 * 生成入口和重建预检共用此规则，避免文件可写但向量索引不可写。
 */
export function wikiPageIdError(pageId: string): string | null {
  const characters = Array.from(pageId)
  if (characters.length === 0 || characters.length > 256) {
    return "页面 ID 必须为 1～256 个字符（包含目录，不包含 wiki/ 和 .md）"
  }
  const disallowed = /[\x00-\x1f\x7f-\x9f\\'"\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u
  const invalid = characters.find((character) => disallowed.test(character))
  if (!invalid) return null
  const code = invalid.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
  return `页面 ID 包含索引不支持的字符 ${JSON.stringify(invalid)}（U+${code}）；请修改文件名或目录名，标题和正文不受此限制`
}
