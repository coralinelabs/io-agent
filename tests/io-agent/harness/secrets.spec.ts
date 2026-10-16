/** An embedder's secrets: every command gets them as variables, and no session ever holds the value. */
import { expect, it } from 'vitest'
import { redactJournal } from "../../../src/library/host/index.ts"
import { onFixtureCleanup, stream, tool } from './fixture.ts'
import { hostFixture, journal, run, turn } from './host-fixture.ts'

const VALUE = 'sk_live_51HxTESTvalue0123456789abcdef'

it('hands a command its secret by name and keeps the value out of the journal, the model and history', async () => {
  const f = await hostFixture((_request, response, index) => {
    if (index === 0) tool(response, 'bash', { command: 'printf "key=%s\\n" "$STRIPE_KEY"', description: 'Print the key' }, 'print-key')
    else stream(response, [{ content: 'Done.' }])
  }, {
    sandbox: 'danger-full-access', approval: 'never',
    configure: (context) => {
      context.shellEnv.provide({ name: 'test.secrets', resolve: () => ({ STRIPE_KEY: VALUE, PATH: '/nowhere', IO_AGENT_SHELL: '0' }) })
      onFixtureCleanup(redactJournal(text => text.replaceAll(VALUE, '[secret STRIPE_KEY]')))
    },
  })
  const id = await f.host.createSession('secrets-by-name')
  const { activity } = await run(f.host, turn(id, 'Print the key.'))
  expect(activity.end).toBe('done')
  // the command saw the value (and PATH was not taken over), and the model read only its reference
  const second = JSON.stringify(f.requests[1])
  expect(second).toContain('key=[secret STRIPE_KEY]')
  expect(second).not.toContain(VALUE)
  expect(JSON.stringify(await journal(f.context(), id))).not.toContain(VALUE)
  expect(JSON.stringify(f.host.readSession(id).events)).not.toContain(VALUE)
  expect(JSON.stringify(await f.host.history(id))).not.toContain(VALUE)
}, 30000)
