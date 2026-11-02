/** 正文版本使用 SHA-256，不把时间戳或文件大小当作内容身份。 */
export async function contentRevision(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

