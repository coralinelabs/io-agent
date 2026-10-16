/** The portable checkpoint must retain both licenses and attribution, never build/private state. */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../..', import.meta.url))

it('source archives retain licensing and verified source bytes without dependencies or private artifacts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'io-source-archive-'))
  try {
    const tree = join(temp, 'fixture')
    for (const dir of ['scripts', 'src', 'src/node_modules', 'dist', '.git']) await mkdir(join(tree, dir), { recursive: true })
    await copyFile(join(root, 'scripts/source_zip.py'), join(tree, 'scripts/source_zip.py'))
    for (const file of ['LICENSE', 'LICENSE-DEEPSEEK', 'NOTICE']) await copyFile(join(root, file), join(tree, file))
    await writeFile(join(tree, 'package.json'), JSON.stringify({ name: '@test/source', version: '0.0.0' }))
    await writeFile(join(tree, 'src/index.ts'), 'export const source = true\n')
    for (const file of ['src/node_modules/dependency.js', 'src/leaked.node', 'src/.env.secret', 'dist/index.js', '.git/config']) {
      await writeFile(join(tree, file), 'must not ship')
    }
    const archive = join(temp, 'source.zip')
    await exec('python3', [join(tree, 'scripts/source_zip.py'), archive])
    const { stdout } = await exec('python3', ['-c', `
import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    descriptor=json.loads(z.read('SOURCE.json'))
    for entry in descriptor['files']:
        assert hashlib.sha256(z.read('io-agent/'+entry['path'])).hexdigest()==entry['sha256']
    print(json.dumps(sorted(z.namelist())))
`, archive])
    expect(JSON.parse(stdout)).toEqual([
      'SOURCE.json', 'io-agent/LICENSE', 'io-agent/LICENSE-DEEPSEEK', 'io-agent/NOTICE',
      'io-agent/package.json', 'io-agent/scripts/source_zip.py', 'io-agent/src/index.ts',
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
