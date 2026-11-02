/** 在固定正文中定位逐字引文，供检查与报告转换共用。 */
export function locateReviewQuote(content: string, quote: string): { startLine: number; endLine: number } | undefined {
  const offset = content.indexOf(quote)
  if (!quote.trim() || offset < 0) return undefined
  const startLine = content.slice(0, offset).split("\n").length
  return { startLine, endLine: startLine + quote.split("\n").length - 1 }
}

