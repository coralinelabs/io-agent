import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inlineModelLanguage, unusedAssets } from './audit.mjs'
test('new inline prompts fail ownership regardless of upstream provenance', () => {
  assert.equal(inlineModelLanguage('const x = { text: "A new instruction" }').length, 1)
  assert.equal(inlineModelLanguage('const NEW_PROMPT = "A new instruction"').length, 1)
  assert.equal(inlineModelLanguage('z.string().describe("Workspace-relative path")').length, 1)
})
test('short error framing is model language too', () => {
  assert.equal(inlineModelLanguage('const x = { text: `Error: ${reason}` }').length, 1)
  assert.equal(inlineModelLanguage('const x = { description: "Path" }').length, 1)
})
test('lookup and dynamic content do not become inline model language', () => {
  assert.deepEqual(inlineModelLanguage('const x = { text: modelText("memory/guidance"), description: dynamicDescription }'), [])
  assert.deepEqual(inlineModelLanguage('const x: { text: "Typed literal" } = input'), [])
})
test('concatenated instructions cannot bypass the static-sink check', () => {
  assert.equal(inlineModelLanguage('const x = { text: "Do not " + "repeat work" }').length, 1)
})
test('an asset no source names is reported; a template id head covers its family', () => {
  const ids = ['system/kept', 'compaction/anchor-files', 'compaction/anchor-urls', 'runtime/gone']
  const source = 'modelText("system/kept"); modelText(`compaction/anchor-${kind}`); const x = "runtime/gone-not"'
  assert.deepEqual(unusedAssets(ids, [source]), ['runtime/gone'])
})
