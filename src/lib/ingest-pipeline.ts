/** 入库与审阅共享的应用级串行入口；租约只由持有者传给流水线内部调用。 */
let tail: Promise<void> = Promise.resolve()
let active: symbol | undefined
let pauseGate: Promise<void> | undefined
let resume: (() => void) | undefined

/** 暂停阻止所有入口认领下一个执行单元，恢复沿用原有串行顺序。 */
export function setIngestPipelinePaused(paused: boolean): void {
  if (paused && !pauseGate) pauseGate = new Promise<void>((resolve) => { resume = resolve })
  if (!paused) { resume?.(); resume = undefined; pauseGate = undefined }
}

export async function withIngestPipeline<T>(operation: (lease: symbol) => Promise<T>, signal?: AbortSignal, lease?: symbol): Promise<T> {
  signal?.throwIfAborted()
  if (lease && lease === active) return operation(lease)
  const previous = tail
  let release!: () => void
  tail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    while (pauseGate) await pauseGate
    signal?.throwIfAborted()
    active = Symbol("ingest-pipeline")
    return await operation(active)
  } finally {
    active = undefined
    release()
  }
}
