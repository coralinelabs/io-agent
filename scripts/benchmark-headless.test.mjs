import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'
import { distribution, sampleCount } from './benchmark-headless.mjs'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./benchmark-headless.mjs', import.meta.url))

test('benchmark sample bounds reject invalid or accidentally unbounded inputs', () => {
  for (const value of ['0', '-1', '1.5', 'Infinity', 'NaN', '51', '']) assert.throws(() => sampleCount(value))
  assert.equal(sampleCount('1'), 1)
  assert.equal(sampleCount('50'), 50)
})

test('benchmark distributions are explicit medians and retain negative values', () => {
  assert.deepEqual(distribution([4, 1, 3]), { min: 1, median: 3, max: 4 })
  assert.deepEqual(distribution([-2, 8]), { min: -2, median: 3, max: 8 })
  assert.throws(() => distribution([]))
  assert.throws(() => distribution([NaN]))
})

test('benchmark runs isolated children, writes raw evidence, and makes no task calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'io-benchmark-test-'))
  try {
    const entry = join(directory, 'fixture.mjs'), output = join(directory, 'report.json')
    await writeFile(entry, `export async function createIoAgent() {
      return { createSession: async () => ({}), close: async () => {}, run: () => { throw new Error('no model calls permitted') } }
    }`)
    const { stdout } = await execute(process.execPath, [script, '--entry', entry, '--samples', '2', '--output', output])
    const report = JSON.parse(stdout)
    assert.equal(report.samples.length, 2)
    assert.equal(report.method.osPageCacheControlled, false)
    assert.equal(report.method.sendsModelRequests, false)
    assert.equal(report.method.executesTools, false)
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report)
    for (const sample of report.samples) assert.ok(sample.afterImport.rss > 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('benchmark refuses a broken consumer entry instead of reporting it as a fast startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'io-benchmark-error-'))
  try {
    const entry = join(directory, 'fixture.mjs')
    await writeFile(entry, 'export const notAnAgent = 1')
    await assert.rejects(execute(process.execPath, [script, '--entry', entry, '--samples', '1']), /createIoAgent/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
