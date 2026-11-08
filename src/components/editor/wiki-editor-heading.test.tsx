/** 章节跳转的展示契约：消费跳转请求后高亮保留一段时间，随后清除。 */
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("./wiki-reader", () => ({ WikiReader: () => null }))
vi.mock("./frontmatter-panel", () => ({ FrontmatterPanel: () => null }))
vi.mock("./page-links-panel", () => ({ PageLinksPanel: () => null }))
vi.mock("@/components/review/file-approval-panel", () => ({ ImportantFileButton: () => null }))
import { WikiEditor } from "./wiki-editor"
import { useWikiStore } from "@/stores/wiki-store"
let view: ReactTestRenderer | undefined

afterEach(async () => {
  await act(async () => view?.unmount())
  view = undefined
  useWikiStore.setState({ pendingScrollHeading: null })
  vi.useRealTimers()
})

it("清空跳转请求后标题仍短暂高亮，并在1800毫秒后恢复", async () => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const classes = new Set<string>()
  const heading = { textContent: "目标章节", scrollIntoView: vi.fn(), classList: {
    add: (...values: string[]) => values.forEach((value) => classes.add(value)),
    remove: (...values: string[]) => values.forEach((value) => classes.delete(value)),
  } }
  useWikiStore.setState({ pendingScrollHeading: { path: "/project/wiki/a.md", heading: "目标章节" } })
  await act(async () => {
    view = create(<WikiEditor content={"# 目标章节\n正文"} filePath="/project/wiki/a.md" onSave={() => {}} />, {
      createNodeMock: () => ({ querySelectorAll: () => [heading] }),
    })
  })
  expect(useWikiStore.getState().pendingScrollHeading).toBeNull()
  expect(heading.scrollIntoView).toHaveBeenCalledTimes(1)
  expect(classes.has("ring-2")).toBe(true)
  await act(async () => { vi.advanceTimersByTime(1800) })
  expect(classes.size).toBe(0)

  // 再次跳到同一 DOM 标题也应重新高亮，卸载时立即恢复样式。
  await act(async () => useWikiStore.setState({ pendingScrollHeading: { path: "/project/wiki/a.md", heading: "目标章节" } }))
  expect(classes.has("ring-2")).toBe(true)
  await act(async () => view?.unmount())
  view = undefined
  expect(classes.size).toBe(0)
})
