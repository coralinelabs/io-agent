/**
 * Build the per-architecture release artifact: `io-agent-<version>-<platform>-<arch>[-musl].tar.gz`
 * holding the built package (dist, with the flock addon and sandbox launcher prebuilds) and its
 * production node_modules (node-pty, sharp, ripgrep and the rest for this platform), plus a
 * `.sha256` file beside it. Run `pnpm build` first, on the platform the artifact is for.
 *
 *   node scripts/release.mjs [output directory, default release/]
 *
 * The staged tree is proven loadable before it is packed: the native dependencies load and the
 * `.` and `./host` exports import from inside it. Publishing the files is the caller's step.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pnpmVersion = pkg.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)(?:\+.+)?$/)?.[1]
assert(pnpmVersion, 'packageManager must pin an exact pnpm version')
function pnpm(args, cwd) {
  assert.equal(execFileSync('pnpm', ['--version'], { cwd, encoding: 'utf8' }).trim(), pnpmVersion,
    `release requires ${pkg.packageManager}`)
  execFileSync('pnpm', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
}
const out = resolve(root, process.argv[2] ?? 'release')
const libc = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : ''
const name = `${pkg.name.replace(/^@[^/]+\//, '')}-${pkg.version}-${process.platform}-${process.arch}${libc}`
// Staged outside the repository, so nothing resolves from the checkout's own node_modules.
const staging = mkdtempSync(join(tmpdir(), 'io-agent-release-'))
const stage = join(staging, name)
const native = join(root, 'dist/library/execution/native/prebuilds', `${process.platform}-${process.arch}`)
assert(existsSync(join(root, 'dist/index.js')) && existsSync(join(root, 'dist/library/host/index.js')), 'run pnpm build first')
if (process.platform === 'linux' || process.platform === 'darwin') assert(existsSync(native), `missing native prebuilds for ${process.platform}-${process.arch}`)

mkdirSync(out, { recursive: true })
// The packed package (exactly what `files` ships) plus a frozen production install from the
// repository's lockfile and patches; the install inputs are removed again before packing.
pnpm(['pack', '--pack-destination', staging], root)
const packed = join(staging, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`)
execFileSync('tar', ['-xzf', packed, '-C', staging])
execFileSync('mv', [join(staging, 'package'), stage])
// pnpm pack omits packageManager. Restore the repository pin before a Corepack
// shim runs outside the checkout, where otherwise it may select/download latest.
const stagedManifest = join(stage, 'package.json')
const stagedPackage = JSON.parse(readFileSync(stagedManifest, 'utf8'))
stagedPackage.packageManager = pkg.packageManager
writeFileSync(stagedManifest, JSON.stringify(stagedPackage, null, 2) + '\n')
const installInputs = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches']
for (const input of installInputs) cpSync(join(root, input), join(stage, input), { recursive: true })
pnpm(['install', '--prod', '--frozen-lockfile'], stage)
for (const input of installInputs) rmSync(join(stage, input), { recursive: true, force: true })
rmSync(packed)
for (const dependency of ['node-pty', 'sharp', '@vscode/ripgrep']) assert(existsSync(join(stage, 'node_modules', dependency)), `install lacks ${dependency}`)
const probe = `
  const { rgPath } = await import('@vscode/ripgrep')
  const { statSync } = await import('node:fs')
  if (!statSync(rgPath).isFile()) throw new Error('ripgrep binary missing')
  await import('sharp'); await import('node-pty')
  const host = await import('${pkg.name}/host'); const main = await import('${pkg.name}')
  if (typeof host.createHost !== 'function' || typeof main.createIoAgent !== 'function') throw new Error('exports missing')
  console.log('loadable')`
assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'loadable')

const artifact = join(out, `${name}.tar.gz`)
rmSync(artifact, { force: true })
execFileSync('tar', ['-czf', artifact, '-C', staging, name], { stdio: 'inherit' })
const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex')
writeFileSync(`${artifact}.sha256`, `${sha256}  ${name}.tar.gz\n`)
rmSync(staging, { recursive: true, force: true })
console.log(JSON.stringify({ artifact, sha256, bytes: statSync(artifact).size }))
