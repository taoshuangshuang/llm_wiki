import type { IngestCommitRunner } from "@/lib/ingest"

interface CommitReservation {
  runCommit: IngestCommitRunner
  release: () => void
}

/**
 * Reserves commit turns in task-start order while allowing preparation to run
 * concurrently. A failed or cancelled task must release its unused turn.
 * 每个预约只约束首次短提交；后续提交由项目互斥锁串行，模型等待不占预约。
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
        try {
          return await operation()
        } finally {
          release()
        }
      },
      release,
    }
  }
}
