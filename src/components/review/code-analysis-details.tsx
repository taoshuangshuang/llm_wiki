/** 按核验时的仓库提交展示分析和逐字源码证据。 */
import type { CodeConflictAnalysis } from "@/lib/code-conflict-types"
import { locateReviewQuote } from "@/lib/review-checks/evidence"

const LABELS = { complete: "已核验当前实现", inconclusive: "证据不足", failed: "核验失败", stale: "材料已变化" }

export function CodeAnalysisDetails({ analysis }: { analysis: CodeConflictAnalysis }) {
  return <section aria-label="源码核验结果" className="mb-3 space-y-2 text-xs">
    <p className="font-medium">源码核验 · {LABELS[analysis.status]}</p>
    <p className="whitespace-pre-wrap">{analysis.summary}</p>
    <p className="text-muted-foreground">依据核验时的本机实现。文档适用版本及线上状态仍需核对。{new Date(analysis.checkedAt).toLocaleString()}</p>
    {analysis.repositories.map((repository) => <div key={repository.repository} className="break-all text-muted-foreground">
      <p>{repository.repository} · {repository.branch || "游离提交"} · {repository.commit.slice(0, 12)}{repository.dirty ? " · 含本机修改" : ""}</p>
      {repository.notes.map((note, index) => <p key={index}>{note}</p>)}
    </div>)}
    {analysis.findings.map((finding, index) => <div key={index} className="space-y-1">
      <p>{finding.description}</p>
      {finding.citations.map((citation, index) => {
        const evidence = analysis.evidence.find((entry) => entry.id === citation.id)
        const range = evidence && locateReviewQuote(evidence.text, citation.quote)
        return evidence && <details key={index}>
          <summary className="cursor-pointer break-all">{evidence.path}:{evidence.startLine + (range?.startLine ?? 1) - 1}-{evidence.startLine + (range?.endLine ?? 1) - 1}</summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap">{citation.quote}</pre>
        </details>
      })}
    </div>)}
    {!!analysis.evidence.length && <details>
      <summary className="cursor-pointer">本次读取的源码片段（{analysis.evidence.length}）</summary>
      {analysis.evidence.map((evidence) => <div key={evidence.id} className="mt-2">
        <p className="break-all text-muted-foreground">{evidence.repository}/{evidence.path}:{evidence.startLine}-{evidence.endLine} · {evidence.via} · {evidence.revision}</p>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap">{evidence.text}</pre>
      </div>)}
    </details>}
  </section>
}
