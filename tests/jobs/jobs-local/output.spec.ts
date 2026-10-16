import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { JobOutputBuffer } from '../../../src/library/execution/jobs/jobs-local/output.ts'

describe('bounded UTF-8 job output', () => {
  it.each([4,5,7,16,4096,4099])('preserves scalar boundaries at capacity %d', capacity => {
    const ring = new JobOutputBuffer(capacity)
    const text = 'A🪐你好z'.repeat(600)
    for (const c of text) ring.append(c)
    const got = ring.read(0)
    expect(got.text).not.toContain('\ufffd')
    expect(text.endsWith(got.text)).toBe(true)
    expect(Buffer.byteLength(got.text)).toBeLessThanOrEqual(capacity)
    expect(got.total).toBe(Buffer.byteLength(text))
    expect(got.lossy).toBe(true)
  })
  it('slices within a chunk rather than repeating its prefix', () => {
    const ring = new JobOutputBuffer(40); ring.append('abcdef')
    expect(ring.read(2,4)).toMatchObject({ text:'cdef', from:2, next:6, lossy:false })
    expect(ring.read(0,4).text).toBe('abcd')
    expect(ring.read(4,4).text).toBe('ef')
  })
  it('reports alignment loss for a cursor inside a Unicode scalar', () => {
    const ring = new JobOutputBuffer(20); ring.append('🪐hello')
    expect(ring.read(1)).toMatchObject({ text:'hello', from:4, lossy:true, next:9 })
  })
  it('does not turn a byte-window split into invalid text', () => {
    const ring = new JobOutputBuffer(20); ring.append('a🪐b')
    expect(ring.read(0,4)).toMatchObject({ text:'a', next:1 })
    expect(ring.read(1,4)).toMatchObject({ text:'🪐', next:5 })
  })
  it('bounds metadata for tiny writes and keeps absolute offsets after eviction', () => {
    const ring = new JobOutputBuffer(8192)
    for (let i=0;i<100000;i++) ring.append('x')
    const state=ring as unknown as { segments:unknown[] }
    expect(state.segments.length).toBeLessThan(40)
    expect(ring.read(0)).toMatchObject({ total:100000, earliest:91808, next:100000, lossy:true })
  })
  it('contains a lone surrogate rather than passing invalid strings to journals', () => {
    const ring = new JobOutputBuffer(8); ring.append('\ud800')
    expect(ring.read(0)).toMatchObject({ text:'\ufffd', total:3 })
  })
  it('returned strings remain stable after slabs are reused', () => {
    const ring=new JobOutputBuffer(8); ring.append('abc'); const result=ring.read(0)
    ring.append('defghijkl'); expect(result.text).toBe('abc')
  })
  it('rejects nonsensical cursors and budgets', () => {
    const ring=new JobOutputBuffer(8)
    for (const v of [-1,1.2,NaN,Infinity,1]) expect(()=>ring.read(v)).toThrow()
    for (const v of [0,1,3,NaN,Infinity]) expect(()=>ring.read(0,v)).toThrow()
  })
  it('matches the retained UTF-8 suffix under varied chunks', () => {
    fc.assert(fc.property(fc.array(fc.string({minLength:0,maxLength:60}), {maxLength:40}), fc.integer({min:4,max:80}), (chunks,cap)=>{
      const ring=new JobOutputBuffer(cap); let all=''
      for (const chunk of chunks) { ring.append(chunk); all+=chunk.toWellFormed() }
      const read=ring.read(0)
      expect(all.endsWith(read.text)).toBe(true)
      expect(read.total).toBe(Buffer.byteLength(all))
      expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(cap)
      expect(read.next).toBe(read.total)
    }), { numRuns:200 })
  })
})
