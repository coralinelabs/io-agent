/** Detached command supervisor. It is the sole writer of each output file, including rotation. */
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readSync, renameSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'

const [directory, limitText, ...argv] = process.argv.slice(2)
if (directory === undefined || argv.length === 0) throw new Error('durable capture requires directory, limit and argv')
const limit = Number(limitText)
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid durable output limit')

function capture(name: string): (bytes: Buffer) => void {
  const path = join(directory!, name)
  let size = 0
  let dropped = 0
  return bytes => {
    // Pipe chunks are bounded by Node. Split further for unusually small configured disk caps.
    for (let at = 0; at < bytes.length;) {
      if (size === limit) {
        const keep = Math.min(1024 * 1024, Math.floor(limit / 2))
        const tail = Buffer.alloc(keep)
        const fd = openSync(path, 'r')
        try { readSync(fd, tail, 0, keep, size - keep) } finally { closeSync(fd) }
        // Readers retry a snapshot that overlaps this mutation. No command owns an append fd:
        // all writes and rotations are serialized here, even while the harness is absent.
        const next = { dropped: dropped + size, prev: [dropped + size - keep, dropped + size] }
        writeFileSync(`${path}.rotating.tmp`, JSON.stringify(next), { mode: 0o600 })
        renameSync(`${path}.rotating.tmp`, `${path}.rotating`)
        writeFileSync(`${path}.prev.tmp`, tail, { mode: 0o600 })
        renameSync(`${path}.prev.tmp`, `${path}.prev`)
        const prev = [dropped + size - keep, dropped + size]
        dropped += size
        truncateSync(path, 0)
        writeFileSync(`${path}.state.tmp`, JSON.stringify({ dropped, prev }), { mode: 0o600 })
        renameSync(`${path}.state.tmp`, `${path}.state`)
        unlinkSync(`${path}.rotating`)
        size = 0
      }
      const part = bytes.subarray(at, at + Math.min(bytes.length - at, limit - size))
      appendFileSync(path, part)
      size += part.length
      at += part.length
    }
  }
}

// Keep the supervisor long enough to collect the command's final bytes after a group TERM.
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
process.on('SIGHUP', () => {})
const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', capture('stdout'))
child.stderr.on('data', capture('stderr'))
child.on('error', error => { appendFileSync(join(directory, 'stderr'), String(error)); finish(127) })
child.on('exit', (code, signal) => { finish(code ?? (signal === null ? 1 : 128 + constants.signals[signal])) })
function finish(code: number): void {
  writeFileSync(join(directory!, 'exit.tmp'), `${code}\n`, { mode: 0o600 })
  renameSync(join(directory!, 'exit.tmp'), join(directory!, 'exit'))
}
