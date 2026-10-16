/** The API names before io-agent stay usable for one release; each old entry point says once that it is deprecated. */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../../src/index.ts'
import { createHost, type HostOptions, type LegacyHostOptions } from '../../../src/library/host/index.ts'

afterEach(() => { vi.restoreAllMocks() })

// Rejected while the options are read, before anything is created on disk.
const invalid = { workspace: tmpdir(), stateDirectory: join(tmpdir(), 'io-agent-legacy-unused'), recall: 'yes' } as unknown as api.IoAgentOptions
const rejection = 'TypeError: invalid recall options'
const deprecations = (warn: { mock: { calls: unknown[][] } }, name: string) => warn.mock.calls.filter(([message]) => String(message).includes(name))

describe('Pluto-era API names', () => {
  it('are the io-agent ones under their old names', () => {
    expect(api.Pluto).toBe(api.IoAgent)
    expect(api.PlutoSession).toBe(api.IoAgentSession)
  })
  it('createPluto delegates to createIoAgent and warns once, by name', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    expect(await api.createIoAgent(invalid).then(() => 'resolved', (error: unknown) => String(error))).toBe(rejection)
    await expect(api.createPluto(invalid)).rejects.toSatisfy(error => String(error) === rejection)
    await expect(api.createPluto(invalid)).rejects.toBeDefined()
    expect(deprecations(warn, 'createPluto')).toEqual([['createPluto is deprecated; use createIoAgent', { type: 'DeprecationWarning', code: 'IO_AGENT_LEGACY_API' }]])
  })
})

describe('HostOptions.pluto, the engine options before ioAgent', () => {
  it('is read in the absence of ioAgent, with one DeprecationWarning', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const legacy: LegacyHostOptions = { pluto: invalid }
    await expect(createHost(legacy)).rejects.toSatisfy(error => String(error) === rejection)
    await expect(createHost(legacy)).rejects.toBeDefined()
    expect(deprecations(warn, 'HostOptions.pluto')).toEqual([['HostOptions.pluto is deprecated; use HostOptions.ioAgent', { type: 'DeprecationWarning', code: 'IO_AGENT_LEGACY_API' }]])
  })
  it('loses to ioAgent whenever ioAgent is present, without a warning', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const both: LegacyHostOptions = { ioAgent: invalid, pluto: { ...invalid, workspace: join(tmpdir(), 'io-agent-no-such-workspace') } }
    // The pluto workspace does not exist, so reading it would fail on realpath, not on the recall option.
    await expect(createHost(both)).rejects.toSatisfy(error => String(error) === rejection)
    const canonical: HostOptions = { ioAgent: invalid }
    await expect(createHost(canonical)).rejects.toSatisfy(error => String(error) === rejection)
    expect(deprecations(warn, 'HostOptions.pluto')).toEqual([])
  })
  it('without either, createHost names ioAgent', async () => {
    await expect(createHost({} as HostOptions)).rejects.toThrow('createHost needs the engine options as ioAgent')
  })
})
