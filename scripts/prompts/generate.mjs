/** Read editable model text and emit a deterministic, browser-safe runtime snapshot. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/
const PARAMETER = /^[a-z][a-z0-9_]*$/
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Read and validate a directory without executing its contents. */
export function readModelContext(directory) {
  const root = realpathSync(directory)
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error('model-context: expected schemaVersion 1 and a non-empty entries array')
  }
  const seenIds = new Set()
  const seenFiles = new Set()
  const entries = manifest.entries.map(entry => {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || !ID.test(entry.id)) {
      throw new Error('model-context: invalid asset id')
    }
    const { id, file, parameters } = entry
    if (seenIds.has(id)) throw new Error(`model-context: duplicate id ${id}`)
    seenIds.add(id)
    if (typeof file !== 'string' || !file.endsWith('.md') || !ID.test(file.slice(0, -3))) {
      throw new Error(`model-context: invalid asset path for ${id}`)
    }
    if (seenFiles.has(file)) throw new Error(`model-context: duplicate asset file ${file}`)
    seenFiles.add(file)
    const path = realpathSync(join(root, file))
    const within = relative(root, path)
    if (within === '..' || within.startsWith(`..${sep}`) || resolve(path) === root) {
      throw new Error(`model-context: asset escapes directory: ${file}`)
    }
    if (!Array.isArray(parameters) || parameters.some(p => typeof p !== 'string' || !PARAMETER.test(p))
      || new Set(parameters).size !== parameters.length) {
      throw new Error(`model-context: invalid parameters for ${id}`)
    }
    // One file-final LF is an editor terminator, not model text. Preserve every other byte,
    // except CRLF normalization so a Windows checkout has the same request surface.
    const decoded = utf8.decode(readFileSync(path)).replaceAll('\r\n', '\n')
    if (decoded.startsWith('\uFEFF')) throw new Error(`model-context: UTF-8 BOM is not allowed: ${file}`)
    if (!decoded.endsWith('\n')) throw new Error(`model-context: asset needs a final LF: ${file}`)
    const text = decoded.slice(0, -1)
    if (parameters.length > 0) {
      const names = new Set([...text.matchAll(PLACEHOLDER)].map(m => m[1]))
      if (names.size !== parameters.length || parameters.some(p => !names.has(p))) {
        throw new Error(`model-context: placeholder/parameter mismatch in ${id}`)
      }
      if (text.replace(PLACEHOLDER, '').includes('{{')) {
        throw new Error(`model-context: malformed placeholder in ${id}`)
      }
    }
    return { id, text, parameters }
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  function visit(directory, prefix = '') {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + file.name
      if (file.isDirectory()) visit(join(directory, file.name), path + '/')
      else if (file.name.endsWith('.md') && path !== 'README.md' && !seenFiles.has(path)) {
        throw new Error(`model-context: unlisted asset ${path}`)
      }
    }
  }
  visit(root)
  const definitions = Object.fromEntries(entries.map(({ id, text, parameters }) => [id, { text, parameters }]))
  const revision = createHash('sha256').update(JSON.stringify(definitions)).digest('hex')
  return { definitions, revision }
}

/** Compile a checked catalog into immutable-by-ownership module data. */
export function emitModelContext(directory) {
  const { definitions, revision } = readModelContext(directory)
  return '// Generated from src/prompts/. Edit the assets, then run pnpm run prompts:generate.\n'
    + '// Do not edit this runtime snapshot directly.\n\n'
    + `export const MODEL_CONTEXT_REVISION = ${JSON.stringify(revision)}\n\n`
    + `export const definitions = ${JSON.stringify(definitions, null, 2)} as const\n`
}

/** Write generated output or report drift without modifying it. */
export function generateModelContext(directory, output, check = false) {
  const generated = emitModelContext(directory)
  let existing
  try { existing = readFileSync(output, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing === generated) return false
  if (check) throw new Error('model-context: runtime snapshot is stale; run pnpm run prompts:generate')
  writeFileSync(output, generated)
  return true
}

const mainFile = process.argv[1] && resolve(process.argv[1])
if (mainFile === fileURLToPath(import.meta.url)) {
  const options = process.argv.slice(2)
  if (options.some(arg => arg !== '--check')) throw new Error('Usage: generate.mjs [--check]')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const changed = generateModelContext(join(root, 'src/prompts'),
    join(root, 'src/prompts/catalog.generated.ts'), options.includes('--check'))
  console.log(`model-context: ${options.includes('--check') ? 'checked' : changed ? 'generated' : 'unchanged'}`)
}
