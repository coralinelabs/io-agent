import { describe, expect, it } from 'vitest'
import { checkArchitecture } from '../../../scripts/check-architecture.mjs'
describe('actual standalone source architecture', () => {
  it('contains no old workspace/product imports and the default driver binds the actual loop', async () => {
    expect(await checkArchitecture()).toMatchObject({ presentationProducts: 0, entry: 'src/loop.ts' })
  })
})
