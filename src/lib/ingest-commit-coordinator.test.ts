import { describe, expect, it } from "vitest"
import { IngestCommitCoordinator } from "@/lib/ingest-commit-coordinator"

describe("IngestCommitCoordinator", () => {
  it("commits in reservation order even when preparation finishes out of order", async () => {
    const coordinator = new IngestCommitCoordinator()
    const first = coordinator.reserve()
    const second = coordinator.reserve()
    const events: string[] = []
    let finishFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve
    })

    const secondCommit = second.runCommit(async () => {
      events.push("second")
    })
    const firstCommit = first.runCommit(async () => {
      events.push("first:start")
      await firstGate
      events.push("first:end")
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    finishFirst()
    await firstCommit
    first.release()
    await secondCommit
    second.release()
    expect(events).toEqual(["first:start", "first:end", "second"])
  })

  it("allows later commits to proceed when an earlier task fails before commit", async () => {
    const coordinator = new IngestCommitCoordinator()
    const failedPreparation = coordinator.reserve()
    const next = coordinator.reserve()
    const events: string[] = []

    failedPreparation.release()
    await next.runCommit(async () => {
      events.push("next")
    })

    expect(events).toEqual(["next"])
  })

  it("任务在提交失败后释放预约，后继仍可继续", async () => {
    const coordinator = new IngestCommitCoordinator()
    const first = coordinator.reserve()
    const second = coordinator.reserve()

    await expect(first.runCommit(async () => {
      throw new Error("write failed")
    })).rejects.toThrow("write failed")
    first.release()
    await expect(second.runCommit(async () => "ok")).resolves.toBe("ok")
  })
  it("同一任务多次提交或重新规划时保持预约，任务完成后才让后继提交", async () => {
    const coordinator = new IngestCommitCoordinator()
    const first = coordinator.reserve()
    const second = coordinator.reserve()
    const events: string[] = []
    await first.runCommit(async () => { events.push("first:check") })
    const next = second.runCommit(async () => { events.push("second") })
    await Promise.resolve()
    await first.runCommit(async () => { events.push("first:write") })
    expect(events).toEqual(["first:check", "first:write"])
    first.release()
    await next
    second.release()
    expect(events).toEqual(["first:check", "first:write", "second"])
  })

})
