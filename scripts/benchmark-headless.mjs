/** Reproducible headless-footprint probe. No model calls, credentials or external services.
 * Every sample is a new process (module-cache cold, NOT guaranteed OS-cache cold).
 * Temporary workspaces deliberately use danger-full-access; no tool is executed.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'

const execute = promisify(execFile)
const self = fileURLToPath(import.meta.url)
const defaultEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url))

/** Reject accidental unbounded or mistyped benchmark runs. */
export function sampleCount(value) {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error('--samples must be an integer from 1 to 50')
  return count
}

/** Distribution summary, retaining negative memory deltas rather than hiding them. */
export function distribution(values) {
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) throw new Error('distribution requires finite samples')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, max: sorted.at(-1) }
}

function memory() {
  globalThis.gc?.()
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage()
  return { rss, heapUsed, external, arrayBuffers }
}

/** One process owns one isolated import/create/session/close measurement. */
async function child(entry) {
  const root = await mkdtemp(join(tmpdir(), 'io-headless-benchmark-'))
  let app
  try {
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const before = memory()
    const importStart = performance.now()
    const { createIoAgent } = await import(pathToFileURL(entry).href)
    const importMs = performance.now() - importStart
    if (typeof createIoAgent !== 'function') throw new Error('entry does not export createIoAgent')
    const afterImport = memory()
    const createStart = performance.now()
    app = await createIoAgent({ workspace, stateDirectory: join(root, 'state'), sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: 'http://127.0.0.1:9/v1', model: 'benchmark-only', contextWindow: 32768, maxTokens: 4096 } })
    const createMs = performance.now() - createStart
    const afterCreate = memory()
    const sessionStart = performance.now()
    await app.createSession()
    const sessionMs = performance.now() - sessionStart
    const afterSession = memory()
    const closeStart = performance.now()
    await app.close()
    app = undefined
    const closeMs = performance.now() - closeStart
    const afterClose = memory()
    return { importMs, createMs, sessionMs, closeMs, before, afterImport, afterCreate, afterSession, afterClose,
      activeResourcesAfterClose: process.getActiveResourcesInfo().sort() }
  } finally {
    try { await app?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}

/** Sequential child samples avoid self-induced parallel contention; stderr is retained. */
async function benchmark(entry, count) {
  const samples = []
  for (let index = 0; index < count; index += 1) {
    const { stdout, stderr } = await execute(process.execPath, ['--expose-gc', self, '--child', entry], {
      timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    })
    const lines = stdout.trim().split('\n')
    samples.push({ ...JSON.parse(lines.at(-1)), stderr: stderr.trim() })
  }
  const summary = Object.fromEntries(['importMs', 'createMs', 'sessionMs', 'closeMs'].map(key => [key, distribution(samples.map(sample => sample[key]))]))
  for (const phase of ['afterImport', 'afterCreate', 'afterSession', 'afterClose']) {
    summary[`${phase}RssBytes`] = distribution(samples.map(sample => sample[phase].rss))
    summary[`${phase}HeapUsedBytes`] = distribution(samples.map(sample => sample[phase].heapUsed))
  }
  return { schemaVersion: 1, entry, entrySha256: createHash('sha256').update(await readFile(entry)).digest('hex'),
    node: process.version, platform: process.platform, arch: process.arch, samplesRequested: count,
    method: { newProcessPerSample: true, gcBeforeMemorySnapshots: true, osPageCacheControlled: false,
      createsSession: true, sendsModelRequests: false, executesTools: false, sandboxQualified: false }, summary, samples }
}

async function main(args) {
  if (args[0] === '--child') {
    if (args.length !== 2) throw new Error('internal child mode requires exactly one entry')
    console.log(JSON.stringify(await child(resolve(args[1]))))
    return
  }
  let entry = defaultEntry, count = 5, output
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!['--entry', '--samples', '--output'].includes(key) || value === undefined) {
      throw new Error('usage: node scripts/benchmark-headless.mjs [--entry path] [--samples 1..50] [--output path]')
    }
    if (key === '--entry') entry = resolve(value)
    if (key === '--samples') count = sampleCount(value)
    if (key === '--output') output = resolve(value)
  }
  const report = JSON.stringify(await benchmark(entry, count), null, 2) + '\n'
  if (output !== undefined) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, report) }
  process.stdout.write(report)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === self) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1 })
}
