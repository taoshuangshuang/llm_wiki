import type { IngestCommitRunner } from "@/lib/ingest"

interface CommitReservation {
  runCommit: IngestCommitRunner
  release: () => void
}

/**
 * Reserves commit turns in task-start order while allowing preparation to run
 * concurrently. A failed or cancelled task must release its unused turn.
 */
export class IngestCommitCoordinator {
  private tail: Promise<void> = Promise.resolve()

  reserve(): CommitReservation {
    const predecessor = this.tail.catch(() => {})
    let releaseTurn!: () => void
    const turnComplete = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    this.tail = predecessor.then(() => turnComplete)
    let released = false

    const release = (): void => {
      if (released) return
      released = true
      releaseTurn()
    }

    return {
      runCommit: async (operation) => {
        await predecessor
        // 一个来源可能补读、重规划并多次进入提交区；任务 finally 统一释放预约。
        return operation()
      },
      release,
    }
  }
}
