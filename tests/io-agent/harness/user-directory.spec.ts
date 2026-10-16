/** The user directory the model is told about is the one tool shells can reach. */
import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIoAgent } from "../../../src/index.ts"
import { onFixtureCleanup, routerFixture, stream, tool } from './fixture.ts'

describe('user directory', () => {
  it('names user-global AGENTS.md by a variable tool shells resolve to the directory it was loaded from', async () => {
    const server = await routerFixture((_request, response, index) => index === 0
      ? tool(response, 'bash', { command: 'cat "$IO_AGENT_USER_DIR/AGENTS.md"; echo "state:${IO_AGENT_STATE_DIR:-unset} home:${DSH_HOME:-unset}"', description: 'Read the user instructions' })
      : stream(response, [{ content: 'Read.' }]))
    const userDirectory = join(server.stateDirectory, '..', 'user-directory')
    await mkdir(userDirectory, { recursive: true })
    await writeFile(join(userDirectory, 'AGENTS.md'), 'USER_GLOBAL_RULE: answer tersely.\n')
    const app = await createIoAgent({ ...server, userDirectory, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: server.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 } })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession()
    expect((await session.run('Read your user instructions.')).stopReason?.kind).toBe('completed')
    const first = JSON.stringify(server.requests[0]!.messages)
    expect(first).toContain('$IO_AGENT_USER_DIR/AGENTS.md')
    expect(first).toContain('USER_GLOBAL_RULE')
    expect(first).not.toContain('DSH_HOME')
    const output = JSON.stringify((await session.events()).filter(event => event.type === 'tool/result'))
    expect(output).toContain('USER_GLOBAL_RULE: answer tersely.')
    expect(output).toContain('state:unset home:unset')
  }, 30000)
})
