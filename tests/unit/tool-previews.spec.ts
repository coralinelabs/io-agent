import { describe, expect, it } from 'vitest'
import { PREVIEW_INTERVAL_MS, ToolPreviews, partialJson } from '../../src/library/host/previews.ts'
import type { ToolCallId } from '../../src/library/model/llm/index.ts'

describe('reading tool arguments while they stream', () => {
  it('closes what is open and drops what has no value yet', () => {
    expect(partialJson('{"file_path": "notes.md", "new_string": "the pl')).toEqual({ file_path: 'notes.md', new_string: 'the pl' })
    expect(partialJson('{"file_path": "notes.md", "old_string": "teh", "new_string"')).toEqual({ file_path: 'notes.md', old_string: 'teh' })
    expect(partialJson('{"file_path": "notes.md", "replace_all": tr')).toEqual({ file_path: 'notes.md' })
    expect(partialJson('{"edits": [{"old_string": "a", "new_string": "b\\n')).toEqual({ edits: [{ old_string: 'a', new_string: 'b\n' }] })
    // an escape cut in half is left out rather than misread
    expect(partialJson('{"new_string": "line\\')).toEqual({ new_string: 'line' })
    expect(partialJson('{"new_string": "\\u00')).toEqual({ new_string: '' })
    expect(partialJson('{"fi')).toBeUndefined()
    expect(partialJson('')).toBeUndefined()
  })
  it('previews a call once it is named, then at most every interval of stream time, and only when it changed', () => {
    const previews = new ToolPreviews()
    const delta = (argumentsDelta: string, extra: object = {}) => ({ type: 'tool-call-delta' as const, index: 0, id: '' as ToolCallId, argumentsDelta, ...extra })
    expect(previews.push('a', delta('{"file_path": "n.md", "new_string": "x'), 0)).toBeUndefined()
    expect(previews.push('a', delta('y', { id: 'call-1' as ToolCallId, name: 'edit' }), 10)).toEqual({ id: 'call-1', name: 'edit', args: { file_path: 'n.md', new_string: 'xy' } })
    expect(previews.push('a', delta('z'), 10 + PREVIEW_INTERVAL_MS - 1)).toBeUndefined()
    expect(previews.push('a', delta(''), 10 + PREVIEW_INTERVAL_MS)?.args).toEqual({ file_path: 'n.md', new_string: 'xyz' })
    expect(previews.push('a', delta(''), 10 + 3 * PREVIEW_INTERVAL_MS)).toBeUndefined()
    previews.reset()
    expect(previews.push('a', delta('{"file_path": "n.md"', { id: 'call-1' as ToolCallId, name: 'edit' }), 20)?.args).toEqual({ file_path: 'n.md' })
  })
})
