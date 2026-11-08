import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, expect, it, vi } from "vitest"
import { FileFind } from "./file-find"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
let view: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => view?.unmount())
  view = undefined
  vi.unstubAllGlobals()
})

it("快捷键唤起、上下项循环跳转、无结果、关闭并重新唤起", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const listeners = new Set<(event: KeyboardEvent) => void>()
  vi.stubGlobal("window", {
    addEventListener: (_: string, listener: (event: KeyboardEvent) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: KeyboardEvent) => void) => listeners.delete(listener),
  })
  vi.stubGlobal("getComputedStyle", () => ({ lineHeight: "24px" }))
  const owner = { getClientRects: () => [{}], focus: vi.fn() }
  const textarea = { setSelectionRange: vi.fn(), clientHeight: 200, scrollTop: 0 }
  const input = { focus: vi.fn(), select: vi.fn() }
  await act(async () => {
    view = create(<FileFind ownerRef={{ current: owner as unknown as HTMLDivElement }} readerRef={{ current: null }} textareaRef={{ current: textarea as unknown as HTMLTextAreaElement }} content="Wiki 和 wiki" mode="edit" />, { createNodeMock: () => input })
  })
  const shortcut = async (metaKey: boolean) => {
    const event = { key: "f", metaKey, ctrlKey: !metaKey, preventDefault: vi.fn() }
    await act(async () => listeners.forEach((listener) => listener(event as unknown as KeyboardEvent)))
    expect(event.preventDefault).toHaveBeenCalledOnce()
  }
  await shortcut(true)
  expect(input.focus).toHaveBeenCalled()
  const change = async (value: string) => act(async () => view!.root.findByType("input").props.onChange({ target: { value } }))
  const status = () => view!.root.findByProps({ role: "status" }).children.join("")
  const enter = async (shiftKey = false) => act(async () => view!.root.findByType("input").props.onKeyDown({ key: "Enter", shiftKey, nativeEvent: {}, preventDefault: vi.fn() }))
  await change("wiki")
  expect(status()).toBe("1/2")
  expect(textarea.setSelectionRange).toHaveBeenLastCalledWith(0, 4)
  await enter()
  expect(status()).toBe("2/2")
  expect(textarea.setSelectionRange).toHaveBeenLastCalledWith(7, 11)
  await enter()
  expect(status()).toBe("1/2")
  await enter(true)
  expect(status()).toBe("2/2")
  await change("不存在")
  expect(status()).toBe("editor.find.noResults")
  expect(view!.root.findByProps({ "aria-label": "editor.find.next" }).props.disabled).toBe(true)
  await act(async () => view!.root.findByType("input").props.onKeyDown({ key: "Escape", nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn() }))
  expect(view!.root.findAllByType("input")).toHaveLength(0)
  expect(owner.focus).toHaveBeenCalled()
  await shortcut(false)
  expect(view!.root.findAllByType("input")).toHaveLength(1)
  await act(async () => view!.unmount())
  view = undefined
  expect(listeners.size).toBe(0)
})
