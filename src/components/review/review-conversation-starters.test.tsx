import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { ReviewConversationStarters } from "./review-conversation-starters"

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => i18n.t(key, { lng: "zh" }), i18n }),
}))

// 服务端渲染不执行 effect；首次展示应等待动态生成，不能闪现旧的固定模板。
describe("审阅会话动态开场", () => {
  it("生成前显示等待状态，保留自由输入入口且不预选结论", () => {
    const onSelect = vi.fn()
    const html = renderToStaticMarkup(<ReviewConversationStarters
      review={{ id: "conflict", type: "contradiction", title: "字段类型冲突", description: "String / Date" }}
      config={useWikiStore.getState().llmConfig} disabled={false} onSelect={onSelect} />)
    expect(html).toContain("正在判断是否有适合选择的确认项")
    expect(html).toContain("其他结论、适用条件或证据")
    expect(html).not.toContain("梳理已有证据")
    expect(html).not.toContain("checked")
    expect(onSelect).not.toHaveBeenCalled()
  })
})
