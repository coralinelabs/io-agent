import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readModelContext, emitModelContext, generateModelContext } from './generate.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(t, text = 'Hello {{name}}.\n', parameters = ['name']) {
  const root = mkdtempSync(join(tmpdir(), 'io-agent-context-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'model-context')
  mkdirSync(join(directory, 'system'), { recursive: true })
  const manifest = { schemaVersion: 1, entries: [{ id: 'system/main', file: 'system/main.md', parameters }] }
  const save = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  save()
  const asset = join(directory, 'system/main.md')
  writeFileSync(asset, text)
  return { root, directory, manifest, save, asset }
}

test('canonical assets retain their extracted baseline template hashes', () => {
  const directory = join(repo, 'src/prompts')
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  const { definitions } = readModelContext(directory)
  assert.equal(Object.keys(definitions).length, manifest.entries.length)
  for (const entry of manifest.entries) {
    // An intentional behavior change must carry a separate revision record and hash.
    const hash = createHash('sha256').update(definitions[entry.id].text).digest('hex')
    assert.equal(hash, entry.currentSha256 ?? entry.baselineSha256, entry.id)
    if (entry.currentSha256) assert.ok(entry.changes?.length, `${entry.id}: missing change provenance`)
  }
})
test('generated catalog is current', () => {
  assert.equal(generateModelContext(join(repo, 'src/prompts'),
    join(repo, 'src/prompts/catalog.generated.ts'), true), false)
})
test('preserves whitespace and Unicode; removes only one editor-final newline', t => {
  const f = fixture(t, '\n  λ 日本語 {{name}}  \n\n')
  assert.equal(readModelContext(f.directory).definitions['system/main'].text, '\n  λ 日本語 {{name}}  \n')
})
test('normalizes CRLF without trimming the model-facing text', t => {
  const f = fixture(t, 'a\r\n{{name}}\r\n\r\n')
  assert.equal(readModelContext(f.directory).definitions['system/main'].text, 'a\n{{name}}\n')
})
test('allows literal brace examples in assets without substitutions', t => {
  const f = fixture(t, 'literal {{example}} and {{not a variable}}\n', [])
  assert.equal(readModelContext(f.directory).definitions['system/main'].text, 'literal {{example}} and {{not a variable}}')
})
test('rejects missing and undeclared substitutions', t => {
  const f = fixture(t, '{{other}}\n')
  assert.throws(() => readModelContext(f.directory), /placeholder\/parameter mismatch/)
})
test('rejects malformed substituted placeholders', t => {
  const f = fixture(t, '{{name}} {{bad name}}\n')
  assert.throws(() => readModelContext(f.directory), /malformed placeholder/)
})
test('rejects duplicate parameter definitions', t => {
  const f = fixture(t, '{{name}}\n', ['name', 'name'])
  assert.throws(() => readModelContext(f.directory), /invalid parameters/)
})
test('rejects duplicate IDs', t => {
  const f = fixture(t)
  f.manifest.entries.push({ ...f.manifest.entries[0] }); f.save()
  assert.throws(() => readModelContext(f.directory), /duplicate id/)
})
test('rejects duplicate file ownership', t => {
  const f = fixture(t)
  f.manifest.entries.push({ ...f.manifest.entries[0], id: 'system/another' }); f.save()
  assert.throws(() => readModelContext(f.directory), /duplicate asset file/)
})
for (const file of ['../outside.md', '/tmp/outside.md', 'system\\outside.md']) {
  test(`rejects unsafe asset path ${file}`, t => {
    const f = fixture(t); f.manifest.entries[0].file = file; f.save()
    assert.throws(() => readModelContext(f.directory), /invalid asset path/)
  })
}
test('rejects symlink escapes', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'outside.md'), '{{name}}\n')
  rmSync(f.asset); symlinkSync(join(f.root, 'outside.md'), f.asset)
  assert.throws(() => readModelContext(f.directory), /escapes directory/)
})
test('rejects unlisted assets but permits directory documentation', t => {
  const f = fixture(t)
  writeFileSync(join(f.directory, 'README.md'), 'Documentation\n')
  assert.doesNotThrow(() => readModelContext(f.directory))
  writeFileSync(join(f.directory, 'extra.md'), 'Instruction\n')
  assert.throws(() => readModelContext(f.directory), /unlisted asset/)
})
test('rejects absent files, invalid UTF-8, BOM, and absent final LF', t => {
  const f = fixture(t)
  rmSync(f.asset); assert.throws(() => readModelContext(f.directory), /ENOENT/)
  writeFileSync(f.asset, Buffer.from([0xff, 0x0a])); assert.throws(() => readModelContext(f.directory), /encoded data/)
  writeFileSync(f.asset, '\uFEFF{{name}}\n'); assert.throws(() => readModelContext(f.directory), /BOM/)
  writeFileSync(f.asset, '{{name}}'); assert.throws(() => readModelContext(f.directory), /final LF/)
})
test('rejects malformed manifest structure', t => {
  const f = fixture(t)
  f.manifest.schemaVersion = 2; f.save()
  assert.throws(() => readModelContext(f.directory), /schemaVersion/)
})
test('catalog output is independent of manifest ordering', t => {
  const f = fixture(t)
  writeFileSync(join(f.directory, 'system/second.md'), 'Second\n')
  f.manifest.entries.push({ id: 'system/second', file: 'system/second.md', parameters: [] }); f.save()
  const original = emitModelContext(f.directory)
  f.manifest.entries.reverse(); f.save()
  assert.equal(emitModelContext(f.directory), original)
})
test('check mode detects drift without writing; generation is idempotent', t => {
  const f = fixture(t), output = join(f.root, 'generated.ts')
  assert.throws(() => generateModelContext(f.directory, output, true), /stale/)
  assert.equal(generateModelContext(f.directory, output), true)
  assert.equal(generateModelContext(f.directory, output), false)
  const before = readFileSync(output, 'utf8')
  writeFileSync(f.asset, 'Changed {{name}}\n')
  assert.throws(() => generateModelContext(f.directory, output, true), /stale/)
  assert.equal(readFileSync(output, 'utf8'), before)
  assert.equal(generateModelContext(f.directory, output), true)
})
test('revision changes when model text changes', t => {
  const f = fixture(t), revision = readModelContext(f.directory).revision
  writeFileSync(f.asset, 'Changed {{name}}\n')
  assert.notEqual(readModelContext(f.directory).revision, revision)
})
