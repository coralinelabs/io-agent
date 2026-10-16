/** Release orchestration keeps the repository's exact pnpm pin after pack strips it. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./release.mjs', import.meta.url))
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'io-agent-release-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'source'), bin = join(directory, 'bin'), log = join(directory, 'calls.jsonl')
  for (const path of ['scripts', 'dist/library/host', `dist/library/execution/native/prebuilds/${process.platform}-${process.arch}`, 'patches']) mkdirSync(join(root, path), { recursive: true })
  mkdirSync(bin)
  cpSync(script, join(root, 'scripts/release.mjs'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@coralinelabs/io-agent', version: '0.1.0', type: 'module', packageManager: 'pnpm@11.7.0',
    exports: { '.': './dist/index.js', './host': './dist/library/host/index.js' } }))
  writeFileSync(join(root, 'dist/index.js'), 'export function createIoAgent() {}\n')
  writeFileSync(join(root, 'dist/library/host/index.js'), 'export function createHost() {}\n')
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) writeFileSync(join(root, path), '')
  writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}
const {readFileSync,writeFileSync,appendFileSync,mkdirSync,cpSync,rmSync} = require('node:fs');
const {join} = require('node:path'); const {execFileSync} = require('node:child_process');
const args=process.argv.slice(2), cwd=process.cwd(), pkg=JSON.parse(readFileSync('package.json','utf8'));
appendFileSync(process.env.RELEASE_TEST_LOG,JSON.stringify({args,root:cwd===process.env.RELEASE_TEST_ROOT,pin:pkg.packageManager??null})+'\\n');
if(args[0]==='--version') {
 console.log(cwd===process.env.RELEASE_TEST_ROOT ? (process.env.RELEASE_TEST_ROOT_VERSION??'11.7.0') : (process.env.RELEASE_TEST_STAGE_VERSION??'11.7.0'));
} else if(args[0]==='pack') {
 const destination=args[2], stage=join(destination,'package'); mkdirSync(stage);
 cpSync('dist',join(stage,'dist'),{recursive:true}); delete pkg.packageManager;
 writeFileSync(join(stage,'package.json'),JSON.stringify(pkg));
 appendFileSync(process.env.RELEASE_TEST_LOG,JSON.stringify({packedPin:pkg.packageManager??null})+'\\n');
 execFileSync('tar',['-czf',join(destination,'coralinelabs-io-agent-0.1.0.tgz'),'-C',destination,'package']); rmSync(stage,{recursive:true});
} else if(args[0]==='install') {
 if(pkg.packageManager!=='pnpm@11.7.0') throw Error('staged install lost its pin');
 for(const name of ['sharp','node-pty','@vscode/ripgrep']) {
  const target=join(cwd,'node_modules',name); mkdirSync(target,{recursive:true});
  writeFileSync(join(target,'package.json'),JSON.stringify({name,type:'module',exports:'./index.js'}));
  writeFileSync(join(target,'index.js'),name==='@vscode/ripgrep'?'export const rgPath='+JSON.stringify(join(target,'rg')):'export default {}');
  if(name==='@vscode/ripgrep') writeFileSync(join(target,'rg'),'fixture');
 }
} else throw Error('unexpected pnpm command');
`)
  // The release script targets Unix native archives and invokes tar/mv itself.
  chmodSync(join(bin, 'pnpm'), 0o755)
  return { root, directory, log, run(extra = {}) {
    return spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), join(directory, 'release')], { encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: directory, RELEASE_TEST_LOG: log, RELEASE_TEST_ROOT: root, ...extra } })
  }, calls() { return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) } }
}
test('restores the stripped pin before staged version selection and frozen install', (t) => {
  const f = fixture(t), result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.calls(), [
    { args: ['--version'], root: true, pin: 'pnpm@11.7.0' },
    { args: ['pack', '--pack-destination', f.calls()[1].args[2]], root: true, pin: 'pnpm@11.7.0' },
    { packedPin: null },
    { args: ['--version'], root: false, pin: 'pnpm@11.7.0' },
    { args: ['install', '--prod', '--frozen-lockfile'], root: false, pin: 'pnpm@11.7.0' },
  ])
  const artifact = JSON.parse(result.stdout).artifact
  assert(existsSync(artifact))
})

for (const position of ['ROOT', 'STAGE']) test(`refuses a mismatched ${position.toLowerCase()} pnpm before producing a release`, (t) => {
  const f = fixture(t), result = f.run({ [`RELEASE_TEST_${position}_VERSION`]: '12.6.0' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /release requires pnpm@11\.7\.0/)
  assert(!f.calls().some(call => call.args?.[0] === 'install'))
  assert(!existsSync(join(f.directory, 'release', `io-agent-0.1.0-${process.platform}-${process.arch}.tar.gz`)))
})
