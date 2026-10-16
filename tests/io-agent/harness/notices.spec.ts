import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { checkNotices, licenseOf, productionClosure, renderNotices } from '../../../scripts/third-party-notices.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))

describe('third-party notices', () => {
  it('match the production closure, the installed licenses and the vendored sources', async () => {
    const { current, expected, actual } = await checkNotices(root)
    if (!current) expect(actual).toBe(expected)
    expect(current).toBe(true)
  })

  it('follow optional dependencies through peer-suffixed snapshots and leave development packages out', () => {
    const lock = {
      importers: { '.': { dependencies: { app: { version: '1.0.0(peer@2.0.0)' } }, devDependencies: { tool: { version: '3.0.0' } } } },
      packages: { 'app@1.0.0': {}, 'native-x64@1.0.0': { os: ['linux'], cpu: ['x64'] }, 'peer@2.0.0': {}, 'tool@3.0.0': {} },
      snapshots: { 'app@1.0.0(peer@2.0.0)': { dependencies: { peer: '2.0.0' }, optionalDependencies: { 'native-x64': '1.0.0' } },
        'native-x64@1.0.0': { optional: true }, 'peer@2.0.0': {}, 'tool@3.0.0': {} },
    }
    expect(productionClosure(lock)).toEqual([
      { name: 'app', version: '1.0.0', direct: true, platform: false },
      { name: 'native-x64', version: '1.0.0', direct: false, platform: true },
      { name: 'peer', version: '2.0.0', direct: false, platform: false },
    ])
  })

  it('resolves aliased optional platform packages by their actual snapshot identity', () => {
    const lock = {
      importers: { '.': { optionalDependencies: { facade: { version: '@vendor/product@1.0.0' } } } },
      packages: { '@vendor/product@1.0.0': {}, '@vendor/product@1.0.0-linux-x64': { os: ['linux'] } },
      snapshots: { '@vendor/product@1.0.0': { optionalDependencies: { 'product-linux': '@vendor/product@1.0.0-linux-x64' } },
        '@vendor/product@1.0.0-linux-x64': {} },
    }
    expect(productionClosure(lock)).toEqual([
      { name: '@vendor/product', version: '1.0.0', direct: true, platform: false },
      { name: '@vendor/product', version: '1.0.0-linux-x64', direct: false, platform: true },
    ])
    expect(() => productionClosure({ ...lock, snapshots: {} })).toThrow('no lockfile snapshot')
  })

  it('read a license from every package.json shape and say when there is none', () => {
    expect(licenseOf({ license: 'MIT' })).toBe('MIT')
    expect(licenseOf({ license: { type: 'BSD-2-Clause' } })).toBe('BSD-2-Clause')
    expect(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT OR Apache-2.0)')
    expect(licenseOf({})).toBe('UNKNOWN')
  })

  it('escape a license that contains a table separator', () => {
    const text = renderNotices({ packages: [{ name: 'odd', version: '1.0.0', direct: true, platform: false }],
      licenses: new Map([['odd@1.0.0', 'MIT|Apache']]), vendored: [], patches: {} })
    expect(text).toContain('| `odd` | 1.0.0 | MIT\\|Apache | direct |')
  })
})
