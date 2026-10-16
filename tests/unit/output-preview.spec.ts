import { describe, expect, it } from 'vitest'
import { unavailableOutputPreview } from '../../src/library/output/preview.ts'
describe('execution outcome is separate from output-storage failure', () => {
  it('bounds Unicode output and gives no fabricated artifact locator', () => {
    const text = 'START-' + '🙂'.repeat(30000) + '-END'
    const rendered = unavailableOutputPreview(text, 4096)!
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(4096)
    expect(rendered).toContain('START-'); expect(rendered).toContain('-END')
    expect(rendered).not.toContain('�'); expect(rendered).toContain('could not be retained')
    expect(rendered).not.toMatch(/artifact_id|spill:\/\//)
  })
  it('retains small output and refuses an impossibly small truthful budget', () => {
    expect(unavailableOutputPreview('okay', 100)).toBe('okay')
    expect(unavailableOutputPreview('long'.repeat(100), 1)).toBeUndefined()
    expect(() => unavailableOutputPreview('x', -1)).toThrow()
  })
})
