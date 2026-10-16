/**
 * Matching for output watchers, off the host's thread. A watcher's pattern is the model's and the lines it is
 * tested against are a job's output, so one backtracking pattern on one long line can take minutes or longer:
 * run on the event loop it would stop every session the host serves. Each output watcher matches in a worker
 * of its own, which its owner stops when the watcher settles (or when a check outlasts the watcher's deadline).
 * @module io-agent/background/matcher
 */

import { Worker } from 'node:worker_threads'

/** The worker: compiles the pattern once and answers each batch of lines with the index of the first match. */
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const pattern = new RegExp(workerData)
parentPort.on('message', (lines) => {
  let found = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) { found = index; break }
  }
  parentPort.postMessage(found)
})
`

/** A match {@link LineMatcher.stop} ended before it finished. */
export class MatchStopped extends Error {
  constructor() { super('the match was stopped before it finished') }
}

/** One pattern, matched in a worker that starts on first use and again after a stop. */
export class LineMatcher {
  private worker: Worker | undefined
  private pending: { resolve: (index: number) => void; reject: (error: Error) => void } | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly pattern: string) {}

  /**
   * Find the first line the pattern matches. Batches run one after another.
   * @param lines - the lines, without their newlines.
   * @returns the index of the first matching line, or -1.
   * @throws {MatchStopped} when {@link stop} ends the match first.
   */
  first(lines: readonly string[]): Promise<number> {
    if (lines.length === 0) return Promise.resolve(-1)
    const run = this.queue.then(() => new Promise<number>((resolve, reject) => {
      const worker = this.worker ?? this.start()
      this.pending = { resolve, reject }
      worker.postMessage(lines)
    }))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** End the running match, if any (it rejects with {@link MatchStopped}), and the worker with it. */
  stop(): void {
    const worker = this.worker
    this.worker = undefined
    this.settle(undefined, new MatchStopped())
    void worker?.terminate()
  }

  private start(): Worker {
    const worker = new Worker(SOURCE, { eval: true, workerData: this.pattern, execArgv: [] })
    // A worker never keeps the process alive: the watcher's own timers decide that.
    worker.unref()
    this.worker = worker
    worker.on('message', (index: number) => { if (this.worker === worker) this.settle(index) })
    worker.on('error', (error: Error) => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.settle(undefined, error)
    })
    worker.on('exit', () => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.settle(undefined, new MatchStopped())
    })
    return worker
  }

  private settle(index: number | undefined, error?: Error): void {
    const pending = this.pending
    this.pending = undefined
    if (pending === undefined) return
    if (error !== undefined) pending.reject(error)
    else pending.resolve(index ?? -1)
  }
}
