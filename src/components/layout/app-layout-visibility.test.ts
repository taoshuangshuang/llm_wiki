import { describe, expect, it } from "vitest"
import { getAppLayoutVisibility } from "./app-layout-visibility"

describe("getAppLayoutVisibility", () => {
  it("opens review conversations in the workspace right panel without requiring research", () => {
    expect(getAppLayoutVisibility("review", false, true)).toEqual({ showLeftPanel: true, hasRightPanel: true })
    expect(getAppLayoutVisibility("chat", false, true)).toEqual({ showLeftPanel: false, hasRightPanel: false })
  })
  it("keeps chat standalone without project side panels", () => {
    // Chat owns its conversation list and reference preview area. It must not
    // also inherit the project knowledge/file panel used by workspace views.
    expect(getAppLayoutVisibility("chat", true)).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })

  it("keeps settings as a standalone view even when research panel is open", () => {
    expect(getAppLayoutVisibility("settings", true)).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })

  it("keeps skills as a standalone management view", () => {
    expect(getAppLayoutVisibility("skills", true)).toEqual({
      showLeftPanel: false,
      hasRightPanel: false,
    })
  })

  it("shows the project side panel and optional research panel in workspace views", () => {
    expect(getAppLayoutVisibility("wiki", false)).toEqual({
      showLeftPanel: true,
      hasRightPanel: false,
    })
    expect(getAppLayoutVisibility("search", true)).toEqual({
      showLeftPanel: true,
      hasRightPanel: true,
    })
  })
})
