import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve, relative, join } from 'node:path'
import assert from 'node:assert/strict'
export async function checkArchitecture(root = resolve(import.meta.dirname, '..')) {
  assert.deepEqual((await readdir(join(root, 'src'))).sort(), ['index.ts', 'library', 'loop.ts', 'plugins', 'prompts'])
  for (const removed of ['apps', 'packages', 'website', 'node_modules']) {
    if (removed === 'node_modules') continue // Installed dependencies aren't product source.
    assert(!(await readdir(root)).includes(removed), `obsolete product root: ${removed}`)
  }
  const walk = async dir => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async e => e.isDirectory() ? walk(join(dir,e.name)) : [join(dir,e.name)]))).flat()
  const sources = (await walk(join(root,'src'))).filter(f => /\.[cm]?tsx?$/.test(f))
  for (const path of sources) {
    const text = await readFile(path,'utf8')
    assert(!/(?:from\s*|import\s*\()['"]@deepseek-ai\//.test(text), `hidden old workspace import: ${relative(root,path)}`)
    assert(!/(?:from\s*|import\s*\()['"](?:electron|react|react-dom|@tauri-apps)\b/.test(text), `presentation import: ${relative(root,path)}`)
  }
  const loop = await readFile(join(root, 'src/loop.ts'), 'utf8')
  for (const operation of ['executeToolCalls', 'ResponseReceiver', 'RequestBuilder']) assert(loop.includes(operation), `missing real orchestration: ${operation}`)
  assert(!loop.includes('AgentStepExecutor'), 'hidden second step implementation')
  const plugin = await readFile(join(root,'src/plugins/runtime.ts'),'utf8')
  assert(plugin.includes('loop.ts'), 'default runtime must bind the actual io-agent loop')
  const unreachable = await unreachableModules(root, sources)
  assert.deepEqual(unreachable, [], `source modules the package entries never reach (delete them, or move test-only code to tests/support):\n${unreachable.join('\n')}`)
  return { sourceModules: sources.length, entry: 'src/loop.ts', presentationProducts: 0, unreachable: unreachable.length }
}

// Reached only by the specs that check the live modules (invariants, codec fixtures), or the readable source of
// the workflow guest bundle (guest-source.ts); anything else in src/ must be reachable from an export.
const TEST_SUPPORT_IN_SRC = [/[/-]invariant\.ts$/, /\/invariants\/index\.ts$/, /\/testing\//, /^src\/library\/model\/retry\/history\.ts$/,
  /^src\/library\/runtime\/scope\/scoped-events\.generated\.ts$/, /^src\/library\/workflow\/workflow-ptc\/guest\.ts$/]

/** Modules no import chain from the package exports reaches, counting `new URL('./x.js', import.meta.url)` child entries. */
export async function unreachableModules(root, sources) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const entries = Object.values(pkg.exports).flatMap(target => typeof target === 'object' && target.import ? [target.import] : [])
    .map(path => join(root, path.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts')))
  const known = new Set(sources)
  const specifier = /(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]|new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g
  const seen = new Set(), pending = [...entries]
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file) || !known.has(file)) continue
    seen.add(file)
    for (const match of (await readFile(file, 'utf8')).matchAll(specifier)) {
      const target = resolve(dirname(file), match[1] ?? match[2])
      for (const candidate of [target, target.replace(/\.js$/, '.ts'), join(target, 'index.ts')]) {
        if (known.has(candidate)) { pending.push(candidate); break }
      }
    }
  }
  return sources.filter(file => !seen.has(file) && !file.endsWith('.d.ts')).map(file => relative(root, file))
    .filter(path => !TEST_SUPPORT_IN_SRC.some(pattern => pattern.test(path))).sort()
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) console.log(JSON.stringify(await checkArchitecture()))
