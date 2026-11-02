/** 移动审批必须显示真实目标与原文，批准后转到新页，不能误展示为删除正文。 */
import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: { path?: string }) => key === "fileApproval.move" ? `移动至 ${options?.path}` : key }) }))
vi.mock("@/commands/file-approval", async (original) => ({
  ...await original<typeof import("@/commands/file-approval")>(), getFileApprovals: vi.fn(), reviewFileChange: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({ readFile: vi.fn() }))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn() }))
import { FileApprovalPanel } from "./file-approval-panel"
import { getFileApprovals, reviewFileChange, type FileChangeProposal } from "@/commands/file-approval"
import { readFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

let view: ReactTestRenderer | undefined
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.clearAllMocks(); vi.unstubAllGlobals()
})

describe("重要页面移动审批", () => {
  it("展示目标及完整原文，批准移动后打开新路径并刷新文件树", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const browser = Object.assign(new EventTarget(), { setInterval, clearInterval })
    vi.stubGlobal("window", browser)
    const proposal: FileChangeProposal = {
      id: "move", path: "wiki/old.md", source: "wiki.move_page:wiki/data/new.md", original: "应保留的业务事实", proposed: null,
      status: "pending", createdAt: 1, reviewedAt: null,
    }
    vi.mocked(getFileApprovals).mockResolvedValue({ importantPaths: ["wiki/old.md"], proposals: [proposal] })
    vi.mocked(reviewFileChange).mockResolvedValue(undefined)
    vi.mocked(readFile).mockResolvedValue("应保留的业务事实")
    useWikiStore.setState({ project: { id: "p", name: "项目", path: "/project" }, selectedFile: "/project/wiki/old.md" })
    await act(async () => { view = create(createElement(FileApprovalPanel)) })
    const card = view!.root.findAllByType("button").find((node) => node.children.some((part) => typeof part === "string" && part.includes("移动至")))!
    expect(card).toBeDefined()
    expect(JSON.stringify(view!.toJSON())).toContain("wiki/data/new.md")
    expect(JSON.stringify(view!.toJSON())).not.toContain("fileApproval.delete")
    await act(async () => card.props.onClick())
    expect(JSON.stringify(view!.toJSON())).toContain("应保留的业务事实")
    expect(JSON.stringify(view!.toJSON())).not.toContain("line-through")
    const approve = view!.root.findAllByType("button").find((node) => node.children.includes("fileApproval.approve"))!
    await act(async () => { await approve.props.onClick(); await Promise.resolve() })
    expect(reviewFileChange).toHaveBeenCalledWith("/project", "move", true)
    expect(readFile).toHaveBeenCalledWith("/project/wiki/data/new.md")
    expect(useWikiStore.getState().selectedFile).toBe("/project/wiki/data/new.md")
    expect(refreshProjectFileTree).toHaveBeenCalledWith("/project", { bumpDataVersion: true })
  })
})
