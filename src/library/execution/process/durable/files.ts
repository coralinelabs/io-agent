/**
 * One output stream of a durable process, kept in a file the process appends
 * to. Reads are offset based and bounded to a tail, like the in-memory
 * collector's, so a reader never holds more than its cap. The file itself is
 * bounded too: past `maxFileBytes` its older bytes are dropped and a short
 * copy of the newest of them is kept beside it, so the tail stays readable.
 * Offsets are whole-stream coordinates that count dropped bytes, so a cursor
 * stays meaningful across a drop and across a process restart.
 * @module io-agent/durable-process/files
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import type { SubprocessOutputRead, SubprocessOutputReader } from '../subprocess/index.ts'

/** Most bytes kept beside the file when its older output is dropped. */
const KEEP_MAX_BYTES = 1024 * 1024

/** What was dropped from one output file, persisted next to it. */
interface DropState {
  /** Whole-stream bytes no longer in the file. */
  dropped: number
  /** Whole-stream range of the copy kept in `<file>.prev`, when one exists. */
  prev?: [number, number]
}

/**
 * A file-backed output stream with bounded reads and a bounded size on disk.
 */
export class DurableOutput implements SubprocessOutputReader {
  private state: DropState

  /**
   * @param path - the file the process appends to.
   * @param maxBytes - most bytes one read returns (the newest ones).
   * @param maxFileBytes - size past which the file's older bytes are dropped.
   * @param finished - whether the writer has exited, so a trailing partial character is final.
   */
  constructor(readonly path: string, private readonly maxBytes: number, private readonly maxFileBytes: number,
    private readonly finished: () => boolean, private readonly captured = false) {
    this.state = readState(`${path}.state`)
  }

  /** Whole-stream bytes dropped from the file so far. */
  get dropped(): number { return this.state.dropped }

  /**
   * Whole-stream size: every byte the process wrote, dropped ones included.
   * @returns the offset that follows the newest byte.
   */
  end(): number {
    for (;;) {
      this.refresh()
      const dropped = this.state.dropped
      const size = physicalSize(this.path)
      if (!this.captured) return dropped + size
      // No append can overlap a rotation owned by the capture process. Its atomic intent
      // names the exact end both before and after truncation, even if the writer is paused.
      try { return (JSON.parse(readFileSync(`${this.path}.rotating`, 'utf8')) as DropState).dropped } catch { /* no rotation */ }
      if (readState(`${this.path}.state`).dropped === dropped) return dropped + size
    }
  }

  private refresh(): void {
    if (!this.captured) return
    // A supervisor killed during rotation cannot append again. Finish its interrupted metadata
    // publication only if truncation happened; otherwise the original file still holds the bytes.
    if (this.finished() && existsSync(`${this.path}.rotating`)) {
      if (physicalSize(this.path) === 0) {
        writeFileSync(`${this.path}.state`, readFileSync(`${this.path}.rotating`), { mode: 0o600 })
      }
      unlinkSync(`${this.path}.rotating`)
    }
    this.state = readState(`${this.path}.state`)
  }

  /**
   * Read the stream from a whole-stream offset: at most `maxBytes`, the newest ones when more is
   * available. While the writer runs, a trailing partial UTF-8 character waits for the next read.
   * @param fromByte - offset to read from (a previous read's `nextOffset`, or 0).
   * @returns the text, the offset to continue from, whether bytes were skipped, and (when they were) the file, if it holds the whole stream.
   */
  readFrom(fromByte: number): SubprocessOutputRead {
    this.refresh()
    if (this.captured && existsSync(`${this.path}.rotating`)) return { text: '', nextOffset: fromByte, lossy: false }
    const size = physicalSize(this.path)
    const { dropped, prev } = this.state
    const end = dropped + size
    const from = Math.min(Math.max(0, fromByte), end)
    let start = Math.max(from, end - this.maxBytes)
    let lossy = start > from
    const parts: Buffer[] = []
    if (start < dropped) {
      // The window reaches back before the drop: take what the kept copy still has.
      if (prev !== undefined && prev[1] > start) {
        const head = Math.max(start, prev[0])
        if (head > start) lossy = true
        parts.push(readRange(`${this.path}.prev`, head - prev[0], prev[1] - head))
        if (prev[1] < dropped) lossy = true
      } else {
        lossy = true
      }
      start = dropped
    }
    parts.push(readRange(this.path, start - dropped, size - (start - dropped)))
    if (this.captured && (existsSync(`${this.path}.rotating`) || readState(`${this.path}.state`).dropped !== dropped)) {
      return { text: '', nextOffset: fromByte, lossy: false }
    }
    const bytes = Buffer.concat(parts)
    const { text, held } = decode(bytes, lossy, !this.finished())
    return { text, nextOffset: end - held, lossy, ...lossy && dropped === 0 ? { spillPath: this.path } : {} }
  }

  /**
   * Read the stream forward from a whole-stream offset, oldest bytes first: at most `maxBytes`, so
   * a scanner sees every byte still kept, in order, a chunk at a time. Bytes dropped before they
   * were read are skipped and reported.
   * @param fromByte - offset to read from (a previous read's `nextOffset`, or 0).
   * @param maxBytes - most bytes to return.
   * @returns the text, the offset to continue from, and whether bytes before it were skipped.
   */
  readForward(fromByte: number, maxBytes: number): { text: string; nextOffset: number; skipped: boolean } {
    this.refresh()
    if (this.captured && existsSync(`${this.path}.rotating`)) return { text: '', nextOffset: fromByte, skipped: false }
    const size = physicalSize(this.path)
    const { dropped, prev } = this.state
    const end = dropped + size
    let at = Math.min(Math.max(0, fromByte), end)
    let skipped = false
    let budget = Math.max(0, maxBytes)
    const parts: Buffer[] = []
    if (at < dropped) {
      if (prev !== undefined && prev[1] > at) {
        if (prev[0] > at) { at = prev[0]; skipped = true }
        const length = Math.min(prev[1] - at, budget)
        parts.push(readRange(`${this.path}.prev`, at - prev[0], length))
        at += length
        budget -= length
        // The bytes between the kept copy and the emptied file are gone.
        if (budget > 0 && at < dropped) { at = dropped; skipped = true }
      } else {
        at = dropped
        skipped = true
      }
    }
    if (budget > 0 && at >= dropped) {
      const length = Math.min(end - at, budget)
      parts.push(readRange(this.path, at - dropped, length))
      at += length
    }
    if (this.captured && (existsSync(`${this.path}.rotating`) || readState(`${this.path}.state`).dropped !== dropped)) {
      return { text: '', nextOffset: fromByte, skipped: false }
    }
    const { text, held } = decode(Buffer.concat(parts), skipped, at < end || !this.finished())
    return { text, nextOffset: at - held, skipped }
  }

  /**
   * Keep the file within `maxFileBytes`: when it is larger, copy its newest bytes beside it and
   * empty it. The writer appends, so its next write lands at the start of the emptied file. Bytes
   * written between the copy and the truncation are lost; a read across them reports `lossy`.
   * @returns whether anything was dropped.
   */
  enforceCap(): boolean {
    if (this.captured) return false
    const size = physicalSize(this.path)
    if (size <= this.maxFileBytes) return false
    const keep = Math.min(KEEP_MAX_BYTES, Math.floor(this.maxFileBytes / 2), size)
    const tail = readRange(this.path, size - keep, keep)
    writeFileSync(`${this.path}.prev.tmp`, tail, { mode: 0o600 })
    renameSync(`${this.path}.prev.tmp`, `${this.path}.prev`)
    const cut = Math.max(size, physicalSize(this.path))
    truncateSync(this.path, 0)
    const dropped = this.state.dropped
    this.state = { dropped: dropped + cut, prev: [dropped + size - keep, dropped + size] }
    writeFileSync(`${this.path}.state.tmp`, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(`${this.path}.state.tmp`, `${this.path}.state`)
    return true
  }
}

function physicalSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function readState(path: string): DropState {
  if (!existsSync(path)) return { dropped: 0 }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<DropState>
    const dropped = Number.isSafeInteger(value.dropped) && (value.dropped as number) >= 0 ? value.dropped as number : 0
    const prev = Array.isArray(value.prev) && value.prev.length === 2 && value.prev.every(n => Number.isSafeInteger(n))
      ? [value.prev[0], value.prev[1]] as [number, number] : undefined
    return { dropped, ...prev === undefined ? {} : { prev } }
  } catch {
    return { dropped: 0 }
  }
}

function readRange(path: string, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return Buffer.alloc(0)
  }
  try {
    const available = Math.max(0, Math.min(length, fstatSync(fd).size - position))
    const buffer = Buffer.alloc(available)
    let read = 0
    while (read < available) {
      const n = readSync(fd, buffer, read, available - read, position + read)
      if (n === 0) break
      read += n
    }
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * Decode UTF-8 for a reader: a window that starts mid-character skips the orphaned continuation
 * bytes, and a trailing partial character is held back while more may follow.
 * @param bytes - the bytes read.
 * @param cutStart - whether the window may start inside a character.
 * @param holdTrailing - whether to hold back a trailing partial character.
 * @returns the text and how many trailing bytes were held back.
 */
export function decode(bytes: Buffer, cutStart: boolean, holdTrailing: boolean): { text: string; held: number } {
  let begin = 0
  if (cutStart) while (begin < Math.min(3, bytes.length) && ((bytes[begin] as number) & 0xc0) === 0x80) begin += 1
  let held = 0
  if (holdTrailing) {
    for (let back = 1; back <= Math.min(4, bytes.length - begin); back += 1) {
      const byte = bytes[bytes.length - back] as number
      if ((byte & 0xc0) === 0x80) continue
      const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
      if (width > back) held = back
      break
    }
  }
  return { text: bytes.subarray(begin, bytes.length - held).toString('utf8'), held }
}
