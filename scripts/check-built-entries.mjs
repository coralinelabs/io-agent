/** Every JavaScript sibling a built module launches or loads by `new URL('./x.js', import.meta.url)` exists in dist/.
 * `.ts` targets are the source-checkout branch and are not part of a build. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function missingBuiltEntries(dist) {
  const walk = dir => readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [])
  const missing = []
  for (const file of walk(dist)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/new URL\(\s*(['"])(\.{1,2}\/[^'"]+\.[cm]?js)\1\s*,\s*import\.meta\.url\s*\)/g)) {
      if (!existsSync(fileURLToPath(new URL(m[2], `file://${file}`)))) missing.push(`${file.slice(dist.length + 1)} -> ${m[2]}`)
    }
  }
  return missing
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = fileURLToPath(new URL('../dist', import.meta.url))
  assert(existsSync(join(dist, 'index.js')), 'run pnpm build first')
  const missing = missingBuiltEntries(dist)
  assert.deepEqual(missing, [], `built modules reference siblings that are not emitted:\n${missing.join('\n')}`)
  console.log(JSON.stringify({ passed: true, check: 'built sibling entries exist' }))
}
