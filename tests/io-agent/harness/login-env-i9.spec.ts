/**
 * The login-shell environment on the DEFAULT runtime path: a real io-agent runtime (the default
 * sandbox-consuming bash executor, real subprocesses) behind the HTTP/SSE
 * provider fixture. Setup that exists only in the login profile reaches the
 * model's bash commands; credentials the profile exports stay scrubbed; the
 * profile's stdout never reaches a tool result.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'

function toolContents(request: Request | undefined): string[] {
  return (request?.messages ?? []).filter(message => message.role === 'tool').map(message =>
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
}

let home: string
let originalHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'io-agent-login-env-home-'))
  originalHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

describe('login-shell environment on the default runtime path', () => {
  it('a bash command sees login-profile setup, without its credentials or its chatter', async () => {
    writeFileSync(join(home, '.bash_profile'), [
      'echo "welcome banner from the login profile"',
      'export REPORTGEN_CONFIG=/etc/reportgen/broken.toml',
      'export REPORTGEN_API_TOKEN=must-not-leak',
    ].join('\n'))
    const command = 'printf "config=%s token=%s\\n" "${REPORTGEN_CONFIG-unset}" "${REPORTGEN_API_TOKEN-unset}"'
    const { app, requests } = await fixture((_request, response, index) => {
      if (index === 0) tool(response, 'bash', { command, description: 'Show the report config' })
      else stream(response, [{ content: 'Done.' }])
    })
    const result = await (await app.createSession()).run('Show the report config.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    const [output] = toolContents(requests[1])
    expect(output).toBeDefined()
    expect(output).toContain('config=/etc/reportgen/broken.toml token=unset')
    expect(output).not.toContain('welcome banner')
    expect(output).not.toContain('must-not-leak')
  }, 60000)

  it('a failing login profile leaves bash working with the scrubbed parent environment', async () => {
    writeFileSync(join(home, '.bash_profile'), 'export REPORTGEN_CONFIG=half-set\nexit 7\n')
    const { app, requests } = await fixture((_request, response, index) => {
      if (index === 0) tool(response, 'bash', { command: 'printf "config=%s\\n" "${REPORTGEN_CONFIG-unset}"', description: 'Show the report config' })
      else stream(response, [{ content: 'Done.' }])
    })
    const result = await (await app.createSession()).run('Show the report config.')
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(toolContents(requests[1])[0]).toContain('config=unset')
  }, 60000)
})
