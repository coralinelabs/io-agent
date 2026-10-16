import { composeFixture } from '../../support/compose-fixture.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "../../../src/library/model/llm/index.ts"
import SessionStore, { SessionId } from "../../../src/library/session/journal/index.ts"
import AgentLoop from "../../../src/plugins/runtime.ts"
import { mountAgentLoopTestDependencies } from "../../support/test-support/agent-loop-testkit/src/index.ts"
import { defineContentToolFixture } from "../../../src/library/tools/index.ts"
import SessionProjectionRegistry from "../../../src/library/session/projection/index.ts"
import TokenMeter from "../../../src/library/model/token-meter/index.ts"
import BasicCompactionEngine from "../../../src/library/context/compaction/basic/index.ts"
import ToolResultPruner from "../../../src/library/context/compaction/tool-result-pruner/index.ts"

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-token-meter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
    ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['test-agent-dependencies', { apply: mountAgentLoopTestDependencies }],
  ])
  await composeFixture(context, configPath, async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
      })
  return context
}

describe('direct plugin composition', () => {
  it('finishes ordinary tool work with one failed identical summary and allows later manual compaction', async () => {
    const loaded = await loadYaml([
      "- name: 'test-agent-dependencies'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
      '  config:',
      '    agents: []',
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-basic'",
      '  config:',
      '    thresholdRatio: 0.5',
      '    retainTokens: 1500',
      '    compactionRetries: 0',
    ])
    const requests: GenerateOptions[] = []
    let mainRequests = 0
    let summary = 'oversized checkpoint '.repeat(100)
    loaded.llm.registerAdapter(['test'], new class extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 6_000 } })
      }

      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        if (options.purpose === 'compaction') {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        mainRequests += 1
        if (mainRequests <= 4) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield {
            type: 'block-end', index: 0,
            block: { type: 'tool-call', id: ToolCallId(`work-${mainRequests}`), name: 'work', arguments: '{}' },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'work completed' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    let toolCalls = 0
    loaded.tools.register(defineContentToolFixture({
      name: 'work', description: 'read or process task records', parameters: {},
      async execute() {
        toolCalls += 1
        return [{ type: 'text', text: toolCalls === 1 ? 'protected records '.repeat(1_200) : 'done' }]
      },
    }))
    const agent = await loaded.agentLoop.create(SessionId('loader-no-progress'), { provider: 'test', model: 'test' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'preserve selected task evidence '.repeat(20) }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(mainRequests).toBe(5)
    expect(toolCalls).toBe(4)
    expect(requests.filter(request => request.purpose === 'compaction')).toHaveLength(1)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })
    expect(agent.session.surface.replaceGeneration).toBe(0)
    expect(requests.filter(request => request.purpose !== 'compaction').at(-1)?.messages)
      .toEqual(agent.session.deriveMessages().slice(0, -1))

    summary = 'manual checkpoint preserves completed work'
    await expect(loaded.compaction.compactNow(agent, new AbortController().signal)).resolves.not.toBeNull()
    expect(requests.filter(request => request.purpose === 'compaction')).toHaveLength(2)
    expect(agent.session.surface.replaceGeneration).toBe(1)
  })

  it('loads the shipped token-meter, pruning, and compaction-basic YAML order', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      '  config:',
      '    thresholdChars: 100',
      '    headChars: 20',
      '    tailChars: 10',
      "- name: '@deepseek-ai/dsh-compaction-basic'",
      '  config:',
      '    thresholdRatio: 0.5',
      '    retainRatio: 0.125',
      '    auto: false',
    ])
    // Module activation is awaited by composeFixture; inspect actual services below.

    expect(loaded.get('toolResultPruner')).toBeInstanceOf(ToolResultPruner)
    expect(loaded.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    expect((loaded.compaction as unknown as BasicCompactionEngine).config).toMatchObject({
      thresholdRatio: 0.5,
      retainRatio: 0.125,
      auto: false,
    })
  })

  it('rejects stale token-meter config after Schemastery normalization', async () => {
    context = new Context()
    await context.plugin(SessionProjectionRegistry)
    await expect(context.plugin(TokenMeter, {
      contextWindow: 4096,
    } as never)).rejects.toThrow(/TokenMeterConfig: unknown key "contextWindow"/)
  })

  it('rejects stale compaction-basic config after Schemastery normalization', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      models: { legacy: { thresholdRatio: 0.5 } },
    } as never)).rejects.toThrow(/BasicCompactionConfig: unknown key "models"/)
  })

  it('rejects a capacity-independent merged ratio conflict during plugin load', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      retainRatio: 0.2,
      modelPolicies: [{
        provider: 'test-provider',
        model: 'test-model',
        thresholdRatio: 0.1,
      }],
    })).rejects.toThrow(/modelPolicies\[0\]: retainRatio \(0.2\).*thresholdRatio \(0.1\)/)
  })

  it('rejects an incomplete model-policy summarization pair during plugin load', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      summarizationProvider: 'default-provider',
      summarizationModel: 'default-model',
      modelPolicies: [{
        provider: 'test-provider',
        model: 'test-model',
        summarizationModel: '',
      }],
    })).rejects.toThrow(/modelPolicies\[0\].*must be set together/)
  })
})
