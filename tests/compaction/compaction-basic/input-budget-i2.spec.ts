/** Pressure is about the next request, not the summary cap or cumulative usage. */
import { describe, expect, it } from 'vitest'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../../../src/library/context/compaction/basic/config.ts'

const target = { provider: 'router', model: 'served-alias' }
const policy = (config: Parameters<typeof resolveConfig>[0] = {}) => resolveTargetPolicy(resolveConfig(config), target)

describe('request-aware compaction budgets', () => {
  it('reserves actual generation space before the nominal pressure ratio', () => {
    expect(resolveCompactSpec(policy(), 10000, 4000)).toMatchObject({
      thresholdTokens: 6000, retainTokens: 960, reservedOutputTokens: 4000,
    })
  })
  it('keeps the ratio threshold when it is already stricter', () => {
    expect(resolveCompactSpec(policy(), 10000, 1000)).toMatchObject({ thresholdTokens: 8000, retainTokens: 1440 })
  })
  it('does not reserve the auxiliary summary cap on an uncapped main route', () => {
    expect(resolveCompactSpec(policy({ maxTokens: 9000 }), 10000)).toMatchObject({ thresholdTokens: 8000, retainTokens: 1600 })
  })
  it('reserves explicit headroom and allows exact-route overrides', () => {
    const configured = resolveConfig({ headroomTokens: 200, modelPolicies: [{ ...target, headroomTokens: 500 }] })
    expect(resolveCompactSpec(resolveTargetPolicy(configured, target), 10000, 4000).thresholdTokens).toBe(5500)
    expect(resolveCompactSpec(resolveTargetPolicy(configured, { ...target, model: 'other' }), 10000, 4000).thresholdTokens).toBe(5800)
  })
  it('keeps explicit tail budgets and rejects a tail larger than available input', () => {
    expect(resolveCompactSpec(policy({ retainTokens: 50 }), 10000, 4000).retainTokens).toBe(50)
    expect(() => resolveCompactSpec(policy({ retainTokens: 7000 }), 10000, 4000)).toThrow(/retainTokens/)
  })
  it.each([-1, NaN, Infinity, 1.5, 10000, 12000])('rejects invalid generation reservation %s', reserved => {
    expect(() => resolveCompactSpec(policy(), 10000, reserved)).toThrow(/reservedOutputTokens/)
  })
  it.each([-1, NaN, Infinity, 1.5])('rejects invalid headroom %s', headroomTokens => {
    expect(() => policy({ headroomTokens })).toThrow(/headroomTokens/)
  })
  it('rejects an explicit headroom that leaves no input capacity', () => {
    expect(() => resolveCompactSpec(policy({ headroomTokens: 6000 }), 10000, 4000)).toThrow(/headroomTokens/)
  })
})
