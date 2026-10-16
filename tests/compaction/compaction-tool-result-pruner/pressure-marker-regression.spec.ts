/** Review regression for 8263069 (found by Codex): deeper pressure passes keep the canonical skill reload marker. */
import { expect, it } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { createMessage, createToolResultMessage, ToolCallId } from '../../../src/library/model/llm/index.ts'
import { Session, SessionId } from '../../../src/library/session/journal/index.ts'
import Projections from '../../../src/library/session/projection/index.ts'
import TokenMeter from '../../../src/library/model/token-meter/index.ts'
import Pruner, { renderSkillRemovedMarker } from '../../../src/library/context/compaction/tool-result-pruner/index.ts'
import { renderSkillContent } from '../../../src/library/skills/skill/index.ts'
import { recallLogPointer, toolResultPrunerConfig } from '../../../src/plugins/tool-results.ts'

function group(session: Session, name: string, args: Record<string, string>, text: string): string {
  const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
  const callId = ToolCallId(`call-${turn}`)
  const argumentsJson = JSON.stringify(args)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({
    role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: argumentsJson }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn, step: 1, callId, name, arguments: argumentsJson })
  session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
    callId, content: [{ type: 'text', text }], isError: false,
  }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return callId
}

function resultText(session: Session, callId: string): string {
  const results = session.deriveMessages().flatMap(message => message.role === 'tool' && message.toolCallId === callId
      ? [message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')] : [])
  expect(results).toHaveLength(1)
  return results[0]!
}

it('preserves the canonical removed-skill marker through every deeper pressure pass', () => {
  const ctx = new Context()
  new Projections(ctx)
  new TokenMeter(ctx)
  // Exact shipped defaults, including the 1024-character aggregate savings floor.
  const pruner = new Pruner(ctx, toolResultPrunerConfig(recallLogPointer))
  const session = Session.create(SessionId('pressure-skill-marker'))
  const name = 'review-large-multi-service-changes'
  const skillCall = group(session, 'skill', { name }, renderSkillContent({
    name, provider: 'filesystem', content: 'Follow the review procedure.\n'.repeat(200),
  }))
  // These old results are below the 512-character second-pass threshold, but
  // together produce enough savings for the final pass under real defaults.
  for (let i = 0; i < 35; i++) group(session, 'bash', { command: `inspect-${i}` }, 'result '.repeat(60))

  pruner.pruneSession(session)
  const marker = renderSkillRemovedMarker(name)
  expect(resultText(session, skillCall)).toBe(marker)
  pruner.pruneSession(session, { stubMinChars: 512, keepRecentSkillToolGroups: 5 })
  expect(resultText(session, skillCall)).toBe(marker)
  const finalPass = pruner.pruneSession(session, { stubMinChars: 0, keepRecentSkillToolGroups: 5 })
  expect(finalPass.charsRemoved).toBeGreaterThanOrEqual(1024)
  expect(resultText(session, skillCall), 'A generic stub loses the instruction to reload the missing skill body').toBe(marker)
})
