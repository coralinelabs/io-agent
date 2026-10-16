/** The default runtime's read-only `recall` tool recovers history that compaction removed from context. */
import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIoAgent } from "../../../src/index.ts"
import type { IoAgentSession } from "../../../src/index.ts"
import { toolOutputBudget } from "../../../src/library/output/policy/budget.ts"
import { hasSpillNotice } from "../../../src/library/output/policy/notice.ts"
import { fixture, onFixtureCleanup, routerFixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'

const EVIDENCE = 'RECALL_EVIDENCE_8472'
const FILLER = Array.from({ length: 300 }, (_, i) => `FILLER_${String(i).padStart(4, '0')} ${'lorem ipsum dolor sit amet '.repeat(2)}`)

/** Text of every tool-role message in one request, in order. */
function toolMessages(request: Request): string[] {
  return request.messages.filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
}

describe('recall on the default runtime', () => {
  it('advertises recall and reads a compacted tool result back by search, by seq and by page', async () => {
    const calls: Request[] = []
    let recalledSeq = -1
    const { app, workspace, requests } = await fixture((request, response) => {
      if (JSON.stringify(request.messages.at(-1)?.content).includes('compaction engine')) {
        return stream(response, [{ content: '## Current Work\nThe notes file was read; the user may ask about it later.' }])
      }
      const i = calls.push(request) - 1
      // An explicit limit reads past io-agent's 16 KB default window, up to the 50 KB cap.
      if (i === 0) return tool(response, 'read', { file_path: 'notes.txt', limit: 2000 }, 'read-notes')
      if (i === 1) return stream(response, [{ content: 'I read the notes file.' }])
      if (i === 2) return stream(response, [{ content: 'Noted. ' + 'context '.repeat(3000) }])
      if (i === 3) return tool(response, 'recall', { query: EVIDENCE }, 'recall-search')
      if (i === 4) {
        const listing = toolMessages(request).at(-1) ?? ''
        recalledSeq = Number(/#(\d+) tool\/result read\b/.exec(listing)?.[1] ?? -1)
        return tool(response, 'recall', { seq: recalledSeq }, 'recall-seq')
      }
      if (i === 5) {
        // A long event is paged; the continuation line names the exact next call.
        const page = /continue with recall seq=(\d+) offset=(\d+)/.exec(toolMessages(request).at(-1) ?? '')
        return tool(response, 'recall', { seq: Number(page?.[1]), offset: Number(page?.[2]) }, 'recall-page')
      }
      if (i === 6) return tool(response, 'recall', { seq: 999999 }, 'recall-missing')
      return stream(response, [{ content: `The code was ${EVIDENCE}.` }])
    })
    await writeFile(join(workspace, 'notes.txt'), [EVIDENCE, ...FILLER].join('\n') + '\n')
    const session = await app.createSession()
    await session.run('Read notes.txt.')
    await session.run('Summarise your plan in one long paragraph.')
    expect(await session.compact()).not.toBeNull()
    const result = await session.run('What was the evidence code at the top of notes.txt?')

    expect(requests[0]!.tools!.map(t => t.function.name)).toContain('recall')
    // Every request carries the same tool list: recall's presence never depends on history state.
    expect(new Set(calls.map(c => JSON.stringify(c.tools))).size).toBe(1)
    // Compaction removed the original read result from the model's context.
    expect(JSON.stringify(calls[3]!.messages)).not.toContain(EVIDENCE)

    const search = toolMessages(calls[4]!).at(-1)!
    expect(search).toContain(EVIDENCE)
    expect(search).toContain('[removed from context]')
    expect(recalledSeq).toBeGreaterThan(0)
    expect(search).toContain(`#${recalledSeq} tool/result read`)

    const first = toolMessages(calls[5]!).at(-1)!
    expect(first).toContain(`#${recalledSeq} tool/result read [removed from context]`)
    expect(first).toContain(EVIDENCE)
    expect(first).toContain('FILLER_0000')
    expect(first).toContain(`continue with recall seq=${recalledSeq} offset=16000`)
    const second = toolMessages(calls[6]!).at(-1)!
    expect(second).toContain('characters 16000 to ')
    expect(second).toContain('FILLER_0299')
    expect(second).not.toContain('continue with recall')

    const results = result.events.filter(e => e.type === 'tool/result')
    const byCall = new Map(results.map(e => [e.data.message.toolCallId as string, e.data.message]))
    expect(byCall.get('recall-search')?.isError).not.toBe(true)
    expect(byCall.get('recall-seq')?.isError).not.toBe(true)
    expect(byCall.get('recall-page')?.isError).not.toBe(true)
    const missing = byCall.get('recall-missing')!
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('This session has no event #999999')
    expect(result.text).toContain(EVIDENCE)
  }, 30000)

  it('recovers a result the default pruner shortened, and points from the copy to the original', async () => {
    // About 24 KB: over the 8192-character pruning threshold, with the evidence in the pruned middle.
    const BIG = Array.from({ length: 300 }, (_, i) => i === 150 ? `MIDDLE ${EVIDENCE}` : `LINE_${String(i).padStart(4, '0')} ${'alpha beta gamma delta '.repeat(3)}`)
    const seqs = { original: -1, copy: -1 }
    const { app, workspace, requests } = await fixture((_request, response, i) => {
      if (i === 0) return tool(response, 'read', { file_path: 'big.txt', limit: 2000 }, 'read-big')
      // Five newer tool groups put the big read outside keepRecentToolGroups; the last reply's usage
      // crosses the pressure threshold (0.8 x 32768), and pruning alone brings it back under.
      if (i <= 5) return tool(response, 'read', { file_path: `small-${i}.txt` }, `read-small-${i}`, i === 5 ? 26500 : 100)
      if (i === 6) return stream(response, [{ content: 'Read them all.' }])
      if (i === 7) return tool(response, 'recall', { seq: seqs.original }, 'recall-original')
      if (i === 8) return tool(response, 'recall', { seq: seqs.copy }, 'recall-copy')
      return stream(response, [{ content: `The middle line was ${EVIDENCE}.` }])
    })
    await writeFile(join(workspace, 'big.txt'), BIG.join('\n') + '\n')
    for (let i = 1; i <= 5; i++) await writeFile(join(workspace, `small-${i}.txt`), `small file ${i}\n`)
    const session = await app.createSession()
    await session.run('Read big.txt, then small-1.txt through small-5.txt.')

    // The real ToolResultPruner shortened the big read before the next request.
    const copy = (await session.events()).find(e => e.type === 'tool/result' && e.surfaceOp !== undefined && e.surfaceOp !== 'append')
    expect(copy?.sourceEventSeqs).toHaveLength(1)
    seqs.original = copy!.sourceEventSeqs![0]!
    seqs.copy = copy!.seq
    expect(JSON.stringify(requests[5]!.messages)).toContain(EVIDENCE)
    expect(JSON.stringify(requests[6]!.messages)).not.toContain(EVIDENCE)

    const result = await session.run('What was the middle line of big.txt?')
    const original = toolMessages(requests[8]!).at(-1)!
    expect(original).toContain(`#${seqs.original} tool/result read [removed from context]`)
    expect(original).toContain(EVIDENCE)
    const shortened = toolMessages(requests[9]!).at(-1)!
    expect(shortened).toContain(`#${seqs.copy} tool/result read`)
    expect(shortened).toContain(`shortened copy of #${seqs.original}; recall seq=${seqs.original} has the full text`)
    expect(shortened).not.toContain(EVIDENCE)
    expect(result.text).toContain(EVIDENCE)
  }, 30000)

  it('answers query searches from the SQLite full-text index when recall.fullText is set', async () => {
    const { app, workspace, requests } = await fixture((_request, response, i) => {
      if (i === 0) return tool(response, 'read', { file_path: 'notes.txt' }, 'read-notes')
      if (i === 1) return tool(response, 'recall', { query: 'zebra crossing' }, 'recall-hit')
      if (i === 2) return tool(response, 'recall', { query: 'nonexistentterm' }, 'recall-miss')
      return stream(response, [{ content: 'Found it.' }])
    }, { recall: { fullText: true } })
    await writeFile(join(workspace, 'notes.txt'), `The zebra crossing code is ${EVIDENCE}.\nUnrelated line.\n`)
    await (await app.createSession()).run('Read notes.txt, then find the zebra crossing code.')

    const hit = toolMessages(requests[2]!).at(-1)!
    expect(hit).toMatch(/^\d+ best matches:/)
    expect(hit).toMatch(/#\d+ tool\/result read \[in context\]/)
    expect(hit).toContain(EVIDENCE)
    expect(toolMessages(requests[3]!).at(-1)).toBe('No earlier event matches "nonexistentterm".')
  }, 30000)

  it.each([
    // 7,000 CJK characters (21,000 bytes) against the 32K window's 19,660-byte threshold.
    { label: '3-byte CJK in a 32K window', contextWindow: 32_768, line: '汉字'.repeat(35), lines: 100 },
    // 12,500 emoji (50,000 bytes), past the 50,000-byte cap every window of 128K or more shares.
    { label: '4-byte emoji in a 131K window', contextWindow: 131_072, line: '😀'.repeat(100), lines: 125 },
  ])('pages multi-byte history within the per-result spill threshold ($label)', async ({ contextWindow, line, lines }) => {
    const budget = toolOutputBudget(contextWindow).maxInlineBytes
    let session!: IoAgentSession
    const router = await routerFixture(async (request, response, i) => {
      // An explicit limit reads past io-agent's 16 KB default window, up to the 50 KB cap.
      if (i === 0) return tool(response, 'read', { file_path: 'wide.txt', limit: 2000 }, 'read-wide')
      if (i === 1) {
        const read = (await session.events()).find(e => e.type === 'tool/result' && e.data.message.source.callId === 'read-wide')!
        return tool(response, 'recall', { seq: read.seq }, 'recall-1')
      }
      const next = /continue with recall seq=(\d+) offset=(\d+)\]$/.exec(toolMessages(request).at(-1) ?? '')
      if (next !== null) return tool(response, 'recall', { seq: Number(next[1]), offset: Number(next[2]) }, `recall-${i}`)
      return stream(response, [{ content: 'Done.' }])
    })
    const app = await createIoAgent({ workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access',
      approval: 'never', model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow, maxTokens: 4096 } })
    onFixtureCleanup(() => app.close())
    await writeFile(join(router.workspace, 'wide.txt'), `${line}\n`.repeat(lines))
    session = await app.createSession()
    await session.run('Read wide.txt, then recall it.')

    const read = toolMessages(router.requests[1]!)[0]!
    // `read` is exempt from spilling; recalling it must not be spilled either.
    expect(Buffer.byteLength(read)).toBeGreaterThan(budget)
    const pages = router.requests.slice(2).map(request => toolMessages(request).at(-1)!)
    // Unbounded, the first page was over the threshold and came back as a spill preview.
    expect(hasSpillNotice(pages[0]!)).toBe(false)
    expect(pages).toHaveLength(2)
    for (const page of pages) {
      expect(hasSpillNotice(page)).toBe(false)
      expect(Buffer.byteLength(page)).toBeLessThanOrEqual(budget)
    }
    expect(pages[0]).toMatch(/\ncharacters 0 to \d+ of \d+\n/)
    const body = (page: string): string => page.slice(page.indexOf('\n\n') + 2).replace(/\n\[\d+ more characters; continue with recall seq=\d+ offset=\d+\]$/, '')
    expect(pages.map(body).join('')).toBe(read)
  }, 30000)

  it('removes the tool entirely when recall is false', async () => {
    const { app, requests } = await fixture((_request, response) => stream(response, [{ content: 'Done.' }]), { recall: false })
    await (await app.createSession()).run('Say done.')
    expect(requests[0]!.tools!.map(t => t.function.name)).not.toContain('recall')
  }, 30000)
})
