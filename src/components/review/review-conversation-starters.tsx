import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { ReviewConversationContext } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import type { LlmConfig } from "@/stores/wiki-store"
import { generateReviewQuestions, reviewChoiceMessage, type ReviewQuestion } from "@/lib/review-conversation-choices"

/** 按需展示适合用户选择的争议；没有可选问题时保留正常会话入口。 */
export function ReviewConversationStarters({ review, config, disabled, onSelect }: {
  review: ReviewConversationContext
  config: LlmConfig
  disabled: boolean
  onSelect: (message: string) => void
}) {
  const { t, i18n } = useTranslation()
  const currentReview = useReviewStore((state) => state.items.find((item) => item.id === review.id)) ?? review
  // 只依赖核查材料，避免 resolved 等无关字段变化触发重新生成。
  const material = JSON.stringify({ id: currentReview.id, type: currentReview.type, title: currentReview.title,
    description: currentReview.description, affectedPages: currentReview.affectedPages, sourcePath: currentReview.sourcePath })
  const language = i18n.resolvedLanguage ?? i18n.language
  const [result, setResult] = useState<{ material: string; questions: ReviewQuestion[] } | null>(null)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const questions = result?.material === material ? result.questions : []
  const loading = !error && result?.material !== material

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setResult(null)
    setAnswers({})
    setError(false)
    const timeout = setTimeout(() => controller.abort(), 60_000)
    void generateReviewQuestions(JSON.parse(material), config, language, controller.signal)
      .then((generated) => { if (!cancelled) setResult({ material, questions: generated }) })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => clearTimeout(timeout))
    return () => { cancelled = true; clearTimeout(timeout); controller.abort() }
  }, [material, config, language, attempt])

  return (
    <div className="space-y-3 py-4" aria-busy={loading}>
      {questions.length > 0 && <p className="text-sm font-medium">{t("review.starters.title")}</p>}
      {error ? (
        <div role="alert" className="space-y-2 text-xs text-muted-foreground">
          <p>{t("review.starters.failed")}</p>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => setAttempt((value) => value + 1)}>{t("common.retry")}</Button>
        </div>
      ) : loading ? (
        <p role="status" className="text-xs text-muted-foreground">{t("review.starters.loading")}</p>
      ) : questions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("review.conversationEmpty")}</p>
      ) : (
        <>
          {questions.map((question, index) => (
            <fieldset key={question.question} disabled={disabled} className="space-y-2">
              <legend className="mb-2 text-sm">{index + 1}. {question.question}</legend>
              {[...question.options, t("review.starters.uncertain")].map((option, optionIndex) => (
                <label key={optionIndex} className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                  <input type="radio" name={`review-choice-${review.id}-${index}`} checked={answers[index] === option}
                    onChange={() => setAnswers((current) => ({ ...current, [index]: option }))} className="mt-0.5 shrink-0" />
                  <span>{option}</span>
                </label>
              ))}
            </fieldset>
          ))}
          <Button size="sm" disabled={disabled || questions.some((_, index) => !answers[index])}
            onClick={() => onSelect(reviewChoiceMessage(questions, answers, t("review.starters.message")))}>
            {t("review.starters.submit")}
          </Button>
        </>
      )}
      {(loading || error || questions.length > 0) && <p className="text-xs text-muted-foreground">{t("review.starters.hint")}</p>}
    </div>
  )
}
