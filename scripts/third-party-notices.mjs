/**
 * Write or check THIRD_PARTY_NOTICES.md from what io-agent actually ships:
 *
 * - the production npm closure in pnpm-lock.yaml (every platform's optional packages included,
 *   since each release tarball carries its own platform's subset of them);
 * - the vendored Cordis sources under src/library/runtime/vendor, with their LICENSE files;
 * - the dependency patches in pnpm-workspace.yaml.
 *
 * A package's license comes from its installed package.json. A package this machine did not
 * install (another platform's binary) keeps the license already recorded in the file; writing a
 * new one of those looks it up in the npm registry, so only `node scripts/third-party-notices.mjs`
 * (write) may use the network. `--check` never does: it fails when the closure, an installed
 * license, the vendored list or the patch list differs from the committed file.
 *
 *   node scripts/third-party-notices.mjs [--check]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const FILE = 'THIRD_PARTY_NOTICES.md'
const VENDOR = 'src/library/runtime/vendor'
const ROW = /^\| `([^`]+)` \| ([^ |]+) \| ([^|]+?) \|/

/** name@version for a lockfile snapshot key or version, without the peer suffix. */
const bare = key => key.replace(/\(.*$/, '')
const nameOf = key => key.slice(0, key.lastIndexOf('@'))

/** The production closure: snapshot keys reachable from the root's dependencies, optional ones included. */
export function productionClosure(lock) {
  const root = lock.importers?.['.'] ?? {}
  // pnpm stores aliased packages by their actual target, not by the installed alias.
  const keyOf = (name, version) => {
    const key = `${name}@${version}`
    const target = version.replace(/^npm:/, '')
    return lock.snapshots?.[key] !== undefined ? key : lock.snapshots?.[target] !== undefined ? target : key
  }
  const pending = Object.entries({ ...root.dependencies, ...root.optionalDependencies }).map(([name, spec]) => keyOf(name, spec.version))
  const direct = new Set(pending.map(bare))
  const seen = new Set()
  while (pending.length > 0) {
    const key = pending.pop()
    if (seen.has(key)) continue
    seen.add(key)
    const snapshot = lock.snapshots?.[key]
    if (snapshot === undefined) throw new Error(`notices: ${key} has no lockfile snapshot`)
    for (const deps of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [name, version] of Object.entries(deps ?? {})) pending.push(keyOf(name, version))
    }
  }
  const packages = new Map()
  for (const key of seen) {
    const id = bare(key)
    const meta = lock.packages?.[id] ?? {}
    packages.set(id, { name: nameOf(id), version: id.slice(nameOf(id).length + 1), direct: direct.has(id),
      platform: meta.os !== undefined || meta.cpu !== undefined })
  }
  return [...packages.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1)
}

/** SPDX-ish license text from a package.json: `license`, a legacy `{ type }`, or a `licenses` list. */
export function licenseOf(manifest) {
  const one = value => typeof value === 'string' ? value : typeof value?.type === 'string' ? value.type : undefined
  const license = one(manifest.license)
  if (license !== undefined) return license.trim()
  const list = Array.isArray(manifest.licenses) ? manifest.licenses.map(one).filter(Boolean) : []
  return list.length > 0 ? list.length === 1 ? list[0] : `(${list.join(' OR ')})` : 'UNKNOWN'
}

/** Licenses of every installed package in pnpm's virtual store, keyed name@version. */
export function installedLicenses(root) {
  const store = join(root, 'node_modules/.pnpm')
  const found = new Map()
  if (!existsSync(store)) return found
  for (const entry of readdirSync(store)) {
    const modules = join(store, entry, 'node_modules')
    if (!existsSync(modules)) continue
    for (const name of readdirSync(modules)) {
      const dirs = name.startsWith('@') ? readdirSync(join(modules, name)).map(child => join(name, child)) : [name]
      for (const dir of dirs) {
        const path = join(modules, dir, 'package.json')
        if (!existsSync(path)) continue
        const manifest = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
          found.set(`${manifest.name}@${manifest.version}`, licenseOf(manifest))
        }
      }
    }
  }
  return found
}

/** Licenses already recorded in a notices file, keyed name@version. */
export function recordedLicenses(text) {
  const recorded = new Map()
  for (const line of text.split('\n')) {
    const row = ROW.exec(line)
    if (row) recorded.set(`${row[1]}@${row[2]}`, row[3].replaceAll('\\|', '|'))
  }
  return recorded
}

/** The vendored source directories, each with the copyright line of its LICENSE. */
export function vendoredSources(root) {
  return readdirSync(join(root, VENDOR), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().map(name => {
    const license = readFileSync(join(root, VENDOR, name, 'LICENSE'), 'utf8')
    return { name, kind: license.split('\n', 1)[0].replace(/ License$/, '').trim(),
      copyright: license.split('\n').find(line => line.startsWith('Copyright'))?.trim() ?? '' }
  })
}

/** Render the notices file. Every row is a pure function of the inputs, so the check is a byte compare. */
export function renderNotices({ packages, licenses, vendored, patches }) {
  const cell = value => value.replaceAll('|', '\\|')
  const counts = new Map()
  for (const pkg of packages) counts.set(licenses.get(`${pkg.name}@${pkg.version}`), (counts.get(licenses.get(`${pkg.name}@${pkg.version}`)) ?? 0) + 1)
  const lines = [
    '# Third-Party Notices',
    '',
    '## Vendored source',
    '',
    '| Directory | License | Copyright |',
    '| --- | --- | --- |',
    ...vendored.map(v => `| [\`${v.name}\`](${VENDOR}/${v.name}/LICENSE) | ${v.kind} | ${cell(v.copyright)} |`),
    '',
    '## Patched dependencies',
    '',
    '| Package | Patch |',
    '| --- | --- |',
    ...Object.entries(patches).sort(([a], [b]) => a < b ? -1 : 1).map(([pkg, patch]) => `| \`${pkg}\` | [\`${patch}\`](${patch}) |`),
    '',
    '## Production npm packages',
    '',
    '| Package | Version | License | Kind |',
    '| --- | --- | --- | --- |',
    ...packages.map(p => `| \`${p.name}\` | ${p.version} | ${cell(licenses.get(`${p.name}@${p.version}`))} | ${p.direct ? 'direct' : p.platform ? 'platform' : 'transitive'} |`),
    '',
    '## Licenses',
    '',
    '| License | Packages |',
    '| --- | --- |',
    ...[...counts.entries()].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([license, n]) => `| ${cell(license)} | ${n} |`),
    '',
    ...(counts.has('UNKNOWN') ? ['License metadata marked `UNKNOWN` was not available for that exact platform package. It is not a permission grant. Before redistributing that platform, install its dependencies and regenerate these notices from their manifests.', ''] : []),
  ]
  return lines.join('\n')
}

async function registryLicense(pkg) {
  const response = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2F')}/${pkg.version}`)
  if (!response.ok) throw new Error(`notices: registry lookup for ${pkg.name}@${pkg.version} failed (${response.status})`)
  return licenseOf(await response.json())
}

/** Build the notices text; `lookup` resolves a license neither installed nor recorded (null: refuse). */
export async function buildNotices(root, lookup = null) {
  const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  const packages = productionClosure(lock)
  const installed = installedLicenses(root)
  const recorded = existsSync(join(root, FILE)) ? recordedLicenses(readFileSync(join(root, FILE), 'utf8')) : new Map()
  const licenses = new Map()
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`
    const license = installed.get(key) ?? recorded.get(key) ?? (lookup === null ? undefined : await lookup(pkg))
    if (license === undefined) throw new Error(`notices: ${key} is neither installed nor recorded; run node scripts/third-party-notices.mjs`)
    licenses.set(key, license)
  }
  return renderNotices({ packages, licenses, vendored: vendoredSources(root), patches: workspace.patchedDependencies ?? {} })
}

/** The committed notices, compared with a rebuild that uses no network. */
export async function checkNotices(root) {
  const expected = await buildNotices(root)
  const actual = readFileSync(join(root, FILE), 'utf8')
  return { current: actual === expected, expected, actual }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  if (process.argv.includes('--check')) {
    const { current } = await checkNotices(root)
    if (!current) throw new Error(`${FILE} is stale; run pnpm notices`)
    console.log(`${FILE}: checked`)
  } else {
    writeFileSync(join(root, FILE), await buildNotices(root, registryLicense))
    console.log(`${FILE}: written`)
  }
}
