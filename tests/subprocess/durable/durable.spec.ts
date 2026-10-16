/** Durable processes: outlive their spawner, are adopted from their directory, end once, and die whole. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { adoptDurable, readLaunchFacts, spawnDurable, terminateMarked, DurableProcess, DurableOutput, DURABLE_MARKER_ENV } from '../../../src/library/execution/process/durable/index.ts'
import type { DurableLaunchFacts } from '../../../src/library/execution/process/durable/index.ts'
import { decode } from '../../../src/library/execution/process/durable/files.ts'
import type { SubprocessSpawnSpec } from '../../../src/library/execution/process/subprocess/index.ts'

const root = mkdtempSync(join(tmpdir(), 'io-agent-durable-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
let counter = 0
const fresh = (): string => join(root, `job-${String(counter += 1)}`)

function spec(command: string, overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', command], cwd: root, graceMs: 200,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } }, stderr: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } } },
    ...overrides,
  }
}
const options = { maxBytes: { stdout: 64_000, stderr: 64_000 }, maxFileBytes: 64 * 1024 * 1024, pollMs: 50 }

/** Live pids whose environment carries the marker. */
function marked(marker: string): number[] {
  const found: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      if (/\) [ZX] /.test(stat)) continue
      if (readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`${DURABLE_MARKER_ENV}=${marker}`)) found.push(Number(entry))
    } catch { /* gone */ }
  }
  return found
}

describe.skipIf(process.platform !== 'linux')('durable processes', () => {
  it('runs a command with its output in files and its exit status recorded', async () => {
    const directory = fresh()
    const handle = spawnDurable(spec('echo out; echo err >&2; exit 7'), { directory, marker: 'm-basic' })
    expect(await handle.done).toEqual({ exitCode: 7, signal: null })
    expect(readFileSync(join(directory, 'stdout'), 'utf8')).toBe('out\n')
    expect(readFileSync(join(directory, 'stderr'), 'utf8')).toBe('err\n')
    expect(readFileSync(join(directory, 'exit'), 'utf8').trim()).toBe('7')
    expect(handle.collected.stdout?.readFrom(0)).toMatchObject({ text: 'out\n', lossy: false, nextOffset: 4 })
    // Reaped: the wrapper leaves no zombie behind.
    await expect.poll(() => existsSync(`/proc/${String(handle.durable.facts.pid)}`), { timeout: 5000 }).toBe(false)
  })

  it('keeps running when its spawner lets go, and a later adopter sees it finish while nobody watched', async () => {
    const directory = fresh()
    const gate = join(directory, '..', `${String(counter)}-gate`)
    const first = spawnDurable(spec(`while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.02; done; echo finished; exit 3`), { directory, marker: 'm-adopt' })
    // The spawner goes away (a crash or a restart): nothing kills the process.
    first.durable.release()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(first.durable.hasMembers()).toBe(true)
    const watching = adoptDurable(directory, options)!
    expect(watching.running).toBe(true)
    watching.release()
    // It finishes while no harness watches it.
    writeFileSync(gate, '')
    await expect.poll(() => existsSync(join(directory, 'exit')), { timeout: 5000 }).toBe(true)
    const later = adoptDurable(directory, options)!
    expect(await later.done).toEqual({ exitCode: 3, signal: null, lost: false })
    expect(later.stdout.readFrom(0).text).toBe('finished\n')
  })

  it('reports a process that vanished without a status as lost', async () => {
    const directory = fresh()
    const first = spawnDurable(spec('sleep 30'), { directory, marker: 'm-lost' })
    first.durable.release()
    // Gone with its whole group, the way a container stop takes it: no status was written.
    process.kill(-first.durable.facts.pid, 'SIGKILL')
    await expect.poll(() => first.durable.hasMembers(), { timeout: 5000 }).toBe(false)
    const adopted = adoptDurable(directory, options)!
    expect(await adopted.done).toEqual({ exitCode: null, signal: null, lost: true })
  })

  it('does not mistake another process that now holds the pid for the recorded one', async () => {
    const directory = fresh()
    const stranger = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    try {
      const facts: DurableLaunchFacts = { pid: stranger.pid!, started: '1', marker: 'm-stranger', startedAt: Date.now() }
      writeFileSync(join(root, 'stranger.json'), '')
      const process_ = new DurableProcess(directory, facts, options)
      expect(await process_.done).toEqual({ exitCode: null, signal: null, lost: true })
      await process_.terminate(50)
      expect(stranger.exitCode).toBeNull()
      expect(existsSync(`/proc/${String(stranger.pid)}`)).toBe(true)
    } finally {
      stranger.kill('SIGKILL')
    }
  })

  it('kills the whole group, a process that ignores SIGTERM and a descendant that left the group', async () => {
    const directory = fresh()
    const marker = 'm-stubborn'
    const handle = spawnDurable(spec(`trap '' TERM; setsid sleep 300 & sleep 300 & echo ready; wait`), { directory, marker })
    await expect.poll(() => readFileSync(join(directory, 'stdout'), 'utf8'), { timeout: 5000 }).toBe('ready\n')
    await expect.poll(() => marked(marker).length, { timeout: 5000 }).toBeGreaterThanOrEqual(4)
    const started = Date.now()
    await handle.durable.terminate(300)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(marked(marker)).toEqual([])
    expect((await handle.done).exitCode === null || (await handle.done).exitCode! > 128).toBe(true)
  })

  it('bounds a flood on disk and in every read, and keeps its newest output readable', async () => {
    const directory = fresh()
    const maxFileBytes = 1024 * 1024
    const handle = spawnDurable(spec('head -c 12000000 /dev/zero | tr "\\0" a; echo; echo tail-marker', {
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096, spill: { maxBytes: maxFileBytes } }, stderr: { maxBytes: 4096, spill: { maxBytes: maxFileBytes } } },
    }), { directory, marker: 'm-flood' }, { pollMs: 5 })
    let largest = 0
    const sampler = setInterval(() => { try { largest = Math.max(largest, statSync(join(directory, 'stdout')).size) } catch { /* not yet */ } }, 2)
    await handle.done
    clearInterval(sampler)
    expect(statSync(join(directory, 'stdout')).size).toBeLessThanOrEqual(maxFileBytes)
    // Bounded while it ran, not only at the end.
    expect(largest).toBeLessThan(12_000_000)
    const read = handle.collected.stdout!.readFrom(0)
    expect(read.lossy).toBe(true)
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(4096)
    expect(read.text.endsWith('tail-marker\n')).toBe(true)
    // The detached supervisor owns append and rotation: every byte is accounted for exactly.
    expect(read.nextOffset).toBe(12_000_000 + 1 + 'tail-marker\n'.length)
    expect(read.spillPath).toBeUndefined()
    // A cursor taken before the drop continues after it.
    expect(handle.collected.stdout!.readFrom(read.nextOffset)).toMatchObject({ text: '', lossy: false })
  }, 30000)

  it('accounts for concurrent floods exactly while the spawner is absent and readers adopt', async () => {
    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const directory = fresh()
      const maxFileBytes = 64 * 1024
      const handle = spawnDurable(spec('head -c 12000000 /dev/zero | tr "\\0" a; echo tail-marker', {
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096, spill: { maxBytes: maxFileBytes } }, stderr: { maxBytes: 4096, spill: { maxBytes: maxFileBytes } } },
      }), { directory, marker: `m-parallel-flood-${index}` }, { pollMs: 5 })
      handle.durable.release()
      const adopted = adoptDurable(directory, { maxBytes: { stdout: 4096, stderr: 4096 }, maxFileBytes, pollMs: 5 })!
      await adopted.done
      const read = adopted.stdout.readFrom(0)
      expect(read.nextOffset).toBe(12_000_000 + 'tail-marker\n'.length)
      expect(read.text.endsWith('tail-marker\n')).toBe(true)
      expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(4096)
      expect(statSync(join(directory, 'stdout')).size).toBeLessThanOrEqual(maxFileBytes)
    }))
  }, 30000)

  it('recovers output metadata if a killed capture stopped in the middle of rotation', () => {
    for (const truncated of [false, true]) {
      const directory = fresh()
      mkdirSync(directory, { recursive: true })
      const path = join(directory, 'stdout')
      writeFileSync(path, truncated ? '' : '0123456789')
      writeFileSync(`${path}.prev`, '6789')
      writeFileSync(`${path}.rotating`, JSON.stringify({ dropped: 10, prev: [6, 10] }))
      const live = new DurableOutput(path, 4, 10, () => false, true)
      expect(live.end()).toBe(10)
      expect(live.readFrom(3)).toMatchObject({ text: '', nextOffset: 3 })
      const output = new DurableOutput(path, 4, 10, () => true, true)
      expect(output.readFrom(0)).toMatchObject({ nextOffset: 10, text: '6789', lossy: true })
      expect(existsSync(`${path}.rotating`)).toBe(false)
    }
  })

  it('continues reads from a cursor and holds back a partial character while the writer runs', async () => {
    const directory = fresh()
    const gate = join(root, `${String(counter)}-utf8-gate`)
    const handle = spawnDurable(spec(`printf 'a\\xc3'; while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.02; done; printf '\\xa9b'`), { directory, marker: 'm-utf8' })
    await expect.poll(() => statSync(join(directory, 'stdout')).size, { timeout: 5000 }).toBe(2)
    const first = handle.collected.stdout!.readFrom(0)
    expect(first).toMatchObject({ text: 'a', nextOffset: 1 })
    writeFileSync(gate, '')
    await handle.done
    expect(handle.collected.stdout!.readFrom(first.nextOffset)).toMatchObject({ text: 'éb', nextOffset: 4, lossy: false })
  })

  it('records launch facts a later harness can adopt from', () => {
    const directory = fresh()
    const handle = spawnDurable(spec('true'), { directory, marker: 'm-facts' })
    expect(readLaunchFacts(directory)).toMatchObject({ pid: handle.durable.facts.pid, marker: 'm-facts', started: expect.any(String), bootId: expect.any(String) })
  })

  it('reads forward through every kept byte in order, a chunk at a time, and reports what a drop skipped', () => {
    const directory = fresh()
    const path = join(directory, 'stdout')
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, 'line-1\nline-2\nline-3\n')
    const output = new DurableOutput(path, 4, 1024, () => true)
    const chunks: string[] = []
    let at = 0
    for (;;) {
      const read = output.readForward(at, 5)
      if (read.nextOffset === at) break
      expect(read.skipped).toBe(false)
      chunks.push(read.text)
      at = read.nextOffset
    }
    // The newest-tail read sees 4 bytes; the forward read sees all 21, oldest first.
    expect(output.readFrom(0).text).toBe('e-3\n')
    expect(chunks.join('')).toBe('line-1\nline-2\nline-3\n')
    // Past the file's bound the older bytes go: a cursor from before them resumes at the kept copy and says so.
    const bounded = new DurableOutput(join(directory, 'bounded'), 4, 16, () => true)
    writeFileSync(join(directory, 'bounded'), 'a'.repeat(40))
    expect(bounded.enforceCap()).toBe(true)
    writeFileSync(join(directory, 'bounded'), 'tail\n', { flag: 'a' })
    const resumed = bounded.readForward(0, 1024)
    expect(resumed.skipped).toBe(true)
    expect(resumed.text).toBe(`${'a'.repeat(8)}tail\n`)
    expect(resumed.nextOffset).toBe(45)
  })

  it('stops a process known only by its marker, one that ignores SIGTERM included', async () => {
    const child = spawn('bash', ['-c', 'trap "" TERM; while :; do sleep 0.05; done'], { env: { ...process.env, [DURABLE_MARKER_ENV]: 'm-orphan' }, detached: true, stdio: 'ignore' })
    child.unref()
    await expect.poll(() => marked('m-orphan').length, { timeout: 5000 }).toBeGreaterThan(0)
    await terminateMarked('m-orphan', 200)
    expect(marked('m-orphan')).toEqual([])
  })

  it('decodes a window cut inside a character without a replacement character', () => {
    expect(decode(Buffer.from([0xa9, 0x62]), true, false)).toEqual({ text: 'b', held: 0 })
    expect(decode(Buffer.from([0x61, 0xe2, 0x82]), false, true)).toEqual({ text: 'a', held: 2 })
  })
})
