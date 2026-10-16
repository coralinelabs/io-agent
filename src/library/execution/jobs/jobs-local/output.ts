/** Bounded UTF-8 output with independent observer and model cursors. No producer ownership. */
export interface OutputSlice {
  text: string
  from: number
  next: number
  earliest: number
  total: number
  lossy: boolean
}

interface Segment { at: number; bytes: Buffer; used: number }
const SLAB = 4096

/** Absolute byte offsets survive eviction; small writes share slabs rather than allocating metadata per character. */
export class JobOutputBuffer {
  private segments: Segment[] = []
  private head = 0
  total = 0
  earliest = 0
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 4) throw new RangeError('output capacity must be an integer >= 4')
  }

  append(text: string): void {
    if (text.length === 0) return
    // Buffer encoding also makes lone surrogates explicit replacement characters; never emit invalid UTF-8.
    let bytes = Buffer.from(text, 'utf8')
    if (!Number.isSafeInteger(this.total + bytes.length)) throw new RangeError('job output byte offset overflow')
    let at = this.total
    this.total += bytes.length
    if (bytes.length >= this.capacity) {
      let start = bytes.length - this.capacity
      while (start < bytes.length && continuation(bytes[start]!)) start++
      at += start
      bytes = bytes.subarray(start)
      this.segments = []
      this.head = 0
    }
    while (bytes.length > 0) {
      let last = this.segments.at(-1)
      if (last === undefined || last.used === last.bytes.length) {
        last = { at, bytes: Buffer.allocUnsafe(Math.min(SLAB, this.capacity)), used: 0 }
        this.segments.push(last)
      }
      const n = Math.min(bytes.length, last.bytes.length - last.used)
      bytes.copy(last.bytes, last.used, 0, n)
      last.used += n
      at += n
      bytes = bytes.subarray(n)
    }
    const minimum = this.total - this.capacity
    while (this.head < this.segments.length) {
      const first = this.segments[this.head]!
      if (first.at + first.used > minimum) break
      this.head++
    }
    const first = this.segments[this.head]
    this.earliest = Math.max(first?.at ?? this.total, minimum)
    // A retention boundary is a byte boundary, but the exposed start must be a code-point boundary.
    while (this.earliest < this.total && continuation(this.byteAt(this.earliest))) this.earliest++
    if (this.head > 32 && this.head * 2 >= this.segments.length) {
      this.segments = this.segments.slice(this.head)
      this.head = 0
    }
  }

  read(offset: number, maxBytes = this.capacity): OutputSlice {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.total) throw new RangeError('invalid job output offset')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new RangeError('output read budget must be an integer >= 4')
    let from = Math.max(offset, this.earliest)
    while (from < this.total && continuation(this.byteAt(from))) from++
    let end = Math.min(this.total, from + maxBytes)
    while (end > from && end < this.total && continuation(this.byteAt(end))) end--
    const bytes = Buffer.allocUnsafe(end - from)
    let target = 0
    for (let i = this.head; i < this.segments.length; i++) {
      const segment = this.segments[i]!
      const start = Math.max(from, segment.at)
      const stop = Math.min(end, segment.at + segment.used)
      if (stop <= start) continue
      target += segment.bytes.copy(bytes, target, start - segment.at, stop - segment.at)
    }
    return { text: bytes.toString('utf8'), from, next: end, earliest: this.earliest, total: this.total, lossy: from !== offset }
  }

  private byteAt(offset: number): number {
    for (let i = this.head; i < this.segments.length; i++) {
      const segment = this.segments[i]!
      if (offset >= segment.at && offset < segment.at + segment.used) return segment.bytes[offset - segment.at]!
    }
    throw new RangeError('output offset is outside retained bytes')
  }
}
function continuation(byte: number): boolean { return (byte & 0xc0) === 0x80 }
