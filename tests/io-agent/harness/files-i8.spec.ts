/** File tools on the default plugin composition over local HTTP/SSE. */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fixture, stream, tool, type Request } from './fixture.ts'

const text = (request: Request): string => JSON.stringify(request.messages)
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

describe('files: nested instructions from shell and search tools', () => {
  it('injects the workspace root instructions first and discloses nested ones that bash, grep and glob reach', async () => {
    const steps: [string, object][] = [
      ['bash', { command: 'cd sub && ls', description: 'List sub' }],
      ['grep', { pattern: 'needle', path: 'pkg' }],
      ['glob', { pattern: 'lib/**/*.txt' }],
      ['bash', { command: 'cat deep/a/b/c.txt node_modules/dep/i.js ../outside/x.txt', description: 'Show files' }],
      ['write', { file_path: 'sub/new.txt', content: 'created' }],
      ['bash', { command: 'cd sub && ls', description: 'List sub again' }],
    ]
    const f = await fixture((_request, response, index) => {
      const step = steps[index]
      if (step === undefined) stream(response, [{ content: 'Done.' }])
      else tool(response, step[0], step[1], `touch-${String(index)}`)
    })
    await mkdir(join(f.workspace, '.git'))
    await put(f.workspace, 'CLAUDE.md', 'ROOT_I8: root rule.\n')
    await put(f.workspace, 'sub/AGENTS.md', 'SUB_I8: rule for sub.\n')
    await put(f.workspace, 'sub/a.txt', 'a\n')
    await put(f.workspace, 'pkg/AGENTS.md', 'PKG_I8: rule for pkg.\n')
    await put(f.workspace, 'pkg/src/m.ts', 'needle\n')
    await put(f.workspace, 'lib/AGENTS.md', 'LIB_I8: rule for lib.\n')
    await put(f.workspace, 'lib/x/y.txt', 'y\n')
    await put(f.workspace, 'deep/a/AGENTS.md', 'DEEP_I8: rule for deep/a.\n')
    await put(f.workspace, 'deep/a/b/c.txt', 'c\n')
    await put(f.workspace, 'node_modules/dep/AGENTS.md', 'DEPENDENCY_I8: must not be disclosed.\n')
    await put(f.workspace, 'node_modules/dep/i.js', 'i\n')
    await put(f.workspace, '../outside/AGENTS.md', 'OUTSIDE_I8: must not be disclosed.\n')
    await put(f.workspace, '../outside/x.txt', 'x\n')

    const run = await (await f.app.createSession()).run('Explore the workspace.')
    expect(run.stopReason?.kind).toBe('completed')
    expect(f.requests).toHaveLength(steps.length + 1)
    // Every tool call succeeded, including the write on its first attempt: `cd sub`
    // had already disclosed sub/AGENTS.md, so the write guard had nothing new to show.
    const results = run.events.filter(e => e.type === 'tool/result')
    expect(results.map(e => e.data.message.isError)).toEqual(steps.map(() => false))

    const requests = f.requests.map(text)
    expect(requests[0]).toContain('ROOT_I8')
    const firstSeen = (marker: string): number => requests.findIndex(request => request.includes(marker))
    expect(firstSeen('SUB_I8')).toBe(1)
    expect(firstSeen('PKG_I8')).toBe(2)
    expect(firstSeen('LIB_I8')).toBe(3)
    expect(firstSeen('DEEP_I8')).toBe(4)
    for (const request of requests) {
      expect(request).not.toContain('DEPENDENCY_I8')
      expect(request).not.toContain('OUTSIDE_I8')
    }
    const last = requests.at(-1)!
    expect(occurrences(last, 'SUB_I8')).toBe(1)
    expect(occurrences(last, 'ROOT_I8')).toBe(1)
  }, 30000)

  it('probes only real directories for a bash command full of slash-bearing blobs', async () => {
    // Before the bounds, the blob became ~250 directories probed for instructions
    // (seconds before the next request) and the `ab/ab/…` word took minutes.
    const blob = Array.from({ length: 270 }, (_, index) => createHash('sha256').update(String(index)).digest('base64').slice(0, 40)).join('/')
    const repeated = Array.from({ length: 1500 }, () => 'ab').join('/')
    const short = Array.from({ length: 100 }, () => 'x').join('/')
    const command = `cat sub/deep/a.txt && echo ${short} ${repeated} > /dev/null && echo '${blob}' > /dev/null`
    // All of it lies inside the scanned prefix.
    expect(command.length).toBeLessThan(16 * 1024)
    const probes: string[] = []
    let beforeTool = 0, beforeNext = 0
    const f = await fixture((_request, response, index) => {
      if (index === 0) { beforeTool = probes.length; tool(response, 'bash', { command, description: 'Blobs' }, 'blob') }
      else { if (index === 1) beforeNext = probes.length; stream(response, [{ content: 'Done.' }]) }
    }, {
      configure: (context) => {
        const fs = context.fs
        const resolve = fs.resolve.bind(fs)
        fs.resolve = (path, options) => { probes.push(path); return resolve(path, options) }
      },
    })
    await mkdir(join(f.workspace, '.git'))
    await put(f.workspace, 'sub/deep/AGENTS.md', 'SUBDEEP_I8: rule for sub/deep.\n')
    await put(f.workspace, 'sub/deep/a.txt', 'a\n')

    const run = await (await f.app.createSession()).run('Run the command.')
    expect(run.stopReason?.kind).toBe('completed')
    expect(run.events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError)).toEqual([false])
    expect(f.requests).toHaveLength(2)
    // The real path in the same command is still disclosed.
    expect(text(f.requests[1]!)).toContain('SUBDEEP_I8')
    const inside = probes.slice(beforeTool, beforeNext).map(path => relative(f.workspace, path)).filter(path => !path.startsWith('..'))
    const instructionDirectories = new Set(inside.filter(path => /(?:AGENTS|CLAUDE)(?:\.local)?\.md$/.test(path)).map(dirname))
    expect(instructionDirectories).toEqual(new Set(['.', 'sub', join('sub', 'deep')]))
    // Only the capped `x/x/x/x/x` guess and its first level were probed as directories; nothing from the blobs.
    expect(inside.filter(path => path.startsWith('x'))).toEqual([['x', 'x', 'x', 'x', 'x'].join(sep), 'x'])
    expect(inside.some(path => path.startsWith('ab') || blob.startsWith(path.split(sep)[0]!))).toBe(false)
  }, 30000)
})

const lastToolText = (request: Request): string => JSON.stringify(request.messages.filter(m => m.role === 'tool').at(-1)?.content)
const body = (tag: string): string => Array.from({ length: 40 }, (_, index) =>
  `${tag}_LINE_${String(index + 1).padStart(2, '0')}: stable content for the unchanged-read check`).join('\n') + '\n'

describe('files: short reply for an unchanged re-read', () => {
  it('answers a visible identical re-read briefly, but re-sends after a change, a revert or compaction', async () => {
    const v1 = body('ALPHA'), v2 = body('ALPHA').replace('ALPHA_LINE_20', 'BRAVO_LINE_20')
    const read = ['read', { file_path: 'a.txt' }] as const
    const script: (readonly [string, object] | 'summary' | 'done')[] = [
      read, read, ['write', { file_path: 'a.txt', content: v2 }], read,
      ['write', { file_path: 'a.txt', content: v1 }], read, read, 'done',
      'summary',
      read, 'done',
    ]
    const f = await fixture((_request, response, index) => {
      const step = script[index]
      if (step === 'summary') stream(response, [{ content: '## Current Work\nInspecting a.txt.' }])
      else if (step === undefined || step === 'done') stream(response, [{ content: 'Done.' }])
      else tool(response, step[0], step[1], `call-${String(index)}`)
    })
    await writeFile(join(f.workspace, 'a.txt'), v1)
    const session = await f.app.createSession()
    const first = await session.run('Inspect a.txt.')
    expect(first.stopReason?.kind).toBe('completed')
    expect(first.events.filter(e => e.type === 'tool/result').every(e => !e.data.message.isError)).toBe(true)
    const r = f.requests
    const notice = 'Unchanged: '
    // 1: first read, full.
    expect(lastToolText(r[1]!)).toContain('ALPHA_LINE_07')
    // 2: identical visible re-read: the notice, and the body is in the request once.
    expect(lastToolText(r[2]!)).toContain(notice)
    expect(lastToolText(r[2]!)).toContain('lines 1-40 of 40')
    expect(lastToolText(r[2]!)).not.toContain('ALPHA_LINE_07')
    expect(occurrences(text(r[2]!), 'ALPHA_LINE_07')).toBe(1)
    // 4: after a change, the new content in full.
    expect(lastToolText(r[4]!)).toContain('BRAVO_LINE_20')
    // 6: reverted to v1, which an older result shows, but the newest read showed v2: full.
    expect(lastToolText(r[6]!)).toContain('ALPHA_LINE_20')
    expect(lastToolText(r[6]!)).not.toContain(notice)
    // 7: identical again: the notice.
    expect(lastToolText(r[7]!)).toContain(notice)
    // Tool bytes are unchanged: the read description is the same in every request.
    expect(new Set(r.slice(0, 8).map(q => JSON.stringify(q.tools))).size).toBe(1)

    expect(await session.compact()).not.toBeNull()
    expect(text(r[8]!)).toContain('compaction engine')
    const second = await session.run('Look at a.txt again.')
    expect(second.stopReason?.kind).toBe('completed')
    expect(r).toHaveLength(script.length)
    // 10: the earlier reads were summarized away, so the re-read is full again.
    expect(lastToolText(r[10]!)).toContain('ALPHA_LINE_07')
    expect(lastToolText(r[10]!)).not.toContain(notice)
  }, 30000)

  it('always gives nested reads full content, such as the read inside skill_read', async () => {
    const resource = body('RESOURCE')
    const f = await fixture((_request, response, index) => {
      if (index === 0) tool(response, 'skill', { name: 'files-i8' }, 'load')
      else if (index === 1) tool(response, 'read', { file_path: '.agents/skills/files-i8/ref.txt' }, 'direct')
      else if (index === 2) tool(response, 'skill_read', { name: 'files-i8', path: 'ref.txt' }, 'nested')
      else stream(response, [{ content: 'Done.' }])
    }, { skills: { watch: false } })
    await put(f.workspace, '.agents/skills/files-i8/SKILL.md', '---\nname: files-i8\ndescription: files-i8 test skill\n---\nRead ref.txt.\n')
    await put(f.workspace, '.agents/skills/files-i8/ref.txt', resource)
    const run = await (await f.app.createSession()).run('Use the files-i8 skill.')
    expect(run.stopReason?.kind).toBe('completed')
    expect(f.requests).toHaveLength(4)
    expect(lastToolText(f.requests[2]!)).toContain('RESOURCE_LINE_07')
    const nested = lastToolText(f.requests[3]!)
    expect(nested).toContain('RESOURCE_LINE_07')
    expect(nested).not.toContain('Unchanged: ')
  }, 30000)
})
