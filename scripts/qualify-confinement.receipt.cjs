/** The confinement qualification's receipt, from what scripts/qualify-confinement.sh left in its output directory. */
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const [out, image, specs] = process.argv.slice(2)
const read = name => readFileSync(join(out, name), 'utf8').trim()
const results = JSON.parse(read('results.json'))
const outcomes = {}
for (const file of results.testResults)
  for (const test of file.assertionResults)
    outcomes[`${file.name.replace(/^.*?\/io-agent\//, '')} > ${test.fullName}`] = test.status
const named = (...statuses) => Object.keys(outcomes).filter(name => statuses.includes(outcomes[name]))
const probed = Number(read('probe.status')) === 0
const receipt = {
  qualified: new Date().toISOString(),
  environment: {
    image,
    kernel: read('kernel.txt'),
    landlockAbi: Number(read('abi.txt')),
    executionUser: 'qualify (non-root)',
    umask: '022',
    container: 'rootless podman, default security options',
    toolchain: read('musl-gcc.txt'),
  },
  launcher: {
    built: true,
    sha256: read('launcher.sha256'),
    probe: !probed ? 'unusable' : /partially enforced/.test(read('probe.txt')) ? 'partial' : 'full',
  },
  specs: specs.split(/\s+/),
  totals: { passed: named('passed').length, failed: named('failed').length, skipped: named('skipped', 'pending', 'todo').length },
  failed: named('failed'),
  skipped: named('skipped', 'pending', 'todo'),
}
writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 1) + '\n')
