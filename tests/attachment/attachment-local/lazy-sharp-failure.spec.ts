import { afterAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ failure: new Error('sharp native binding unavailable') }))

vi.mock("../../../src/library/context/attachments/attachment-local/sharp.ts", () => ({
  requireSharp: () => { throw state.failure },
}))

import { detectImage, probeImage } from "../../../src/library/context/attachments/attachment-local/image.ts"
import { normalizeImage } from "../../../src/library/context/attachments/attachment-local/normalization.ts"

afterAll(() => {
  vi.doUnmock("../../../src/library/context/attachments/attachment-local/sharp.ts")
})

describe('lazy Sharp load failure', () => {
  it.each([
    ['header probe', probeImage],
    ['full decode', detectImage],
  ] as const)('does not classify a %s as invalid image data', async (_name, operation) => {
    await expect(operation(Uint8Array.of(1, 2, 3))).rejects.toBe(state.failure)
  })

  it('does not classify normalization startup as an encoding failure', async () => {
    await expect(normalizeImage(Uint8Array.of(1, 2, 3), {
      mediaType: 'image/png',
      width: 3,
      height: 2,
      animated: false,
      carriesMetadata: false,
      depth: 'ushort',
      space: 'rgb16',
      hasAlpha: true,
    }, {
      maxPixels: 100,
      maxDimension: 10,
      maxBytes: 1_024,
    })).rejects.toBe(state.failure)
  })
})
