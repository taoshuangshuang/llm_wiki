/** 继承规则和跨仓范围隔离是后续源码核验的输入契约。 */
import { describe, expect, it } from "vitest"
import { codeLocation, readCodeSourcesConfig, resolveCodeBinding } from "./code-sources"

describe("模块源码绑定契约", () => {
  it("允许中间模块绑定，后代覆盖范围，换仓后采用新仓库范围", () => {
    const config = readCodeSourcesConfig(JSON.stringify({
      version: 1,
      moduleBindings: {
        api: { repository: "/repo/api", paths: ["sdk"] },
        property: { paths: ["sdk/src/main/java/org/model"], pathsRepository: "/repo/api" },
        converted: { repository: "/repo/imeta" },
      },
    }))
    expect(resolveCodeBinding(config, "child", ["platform", "api", "property"])).toMatchObject({
      repository: "/repo/api", repositorySource: "api", paths: ["sdk/src/main/java/org/model"], pathsSource: "property",
    })
    expect(resolveCodeBinding(config, "converted", ["api", "property"])).toMatchObject({
      repository: "/repo/imeta", paths: [],
    })
    config.moduleBindings.api.repository = "/repo/new-api"
    expect(resolveCodeBinding(config, "property", ["api"])).toMatchObject({ repository: "/repo/new-api", paths: ["sdk"] })
  })

  it("显式解除绑定停止继承，恢复后继续采用父模块仓库", () => {
    const config = readCodeSourcesConfig('{"version":1,"moduleBindings":{"api":{"repository":"/repo/api"},"child":{"repository":null}}}')
    expect(resolveCodeBinding(config, "leaf", ["api", "child"]).repository).toBeUndefined()
    delete config.moduleBindings.child
    expect(resolveCodeBinding(config, "leaf", ["api", "child"]).repository).toBe("/repo/api")
  })

  it("拒绝越界范围和损坏配置，阻止错误配置落盘", () => {
    for (const path of ["../outside", "/etc", "src/../outside", "src\\outside", "src//java"]) {
      expect(() => codeLocation("/repo", path)).toThrow()
      expect(() => readCodeSourcesConfig(JSON.stringify({ version: 1, moduleBindings: { api: { paths: [path] } } }))).toThrow()
    }
    expect(() => readCodeSourcesConfig('{"version":1,"moduleBindings":{"api":{"repository":"relative"}}}')).toThrow()
    expect(() => readCodeSourcesConfig("broken")).toThrow()
  })
})
