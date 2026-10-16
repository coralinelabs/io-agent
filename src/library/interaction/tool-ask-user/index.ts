/**
 * Model-facing Consumer of the `ctx.userQuestions` capability seam.
 * The tool pauses until a UI provider returns a human answer, then feeds that
 * answer back into the agent loop as an ordinary tool result.
 *
 * @module io-agent/tool-ask-user
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { defineTool } from "../../tools/index.ts"
import "../user-questions/index.ts"
import type {} from "../continued/index.ts"

export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']

const description = modelText('runtime/tool-ask-user-index/text-01')

export function questionTool(ctx: Context, blocking = true) {
  const continued = ctx.get('continuedQuestions')
  return defineTool({
    name: 'ask_user_question',
    description: continued === undefined ? description : modelText('questions/continued-description') + (blocking ? '\n' + modelText('questions/blocking-mode') : ''),
    parameters: {
      ...(continued === undefined ? {} : { mode: { type: 'string' as const, enum: blocking ? ['blocking', 'continue'] : ['continue'], description: modelText('questions/mode') } }),
      questions: {
        type: 'array',
        required: true,
        description: modelText('runtime/tool-ask-user-index/text-02'),
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: modelText('runtime/tool-ask-user-index/text-03') },
            question: { type: 'string', required: true, description: modelText('runtime/tool-ask-user-index/text-04') },
            header: {
              type: 'string',
              description: modelText('runtime/tool-ask-user-index/text-05'),
            },
            options: {
              type: 'array',
              description: modelText('runtime/tool-ask-user-index/text-06'),
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: modelText('runtime/tool-ask-user-index/text-07') },
                  description: { type: 'string', description: modelText('runtime/tool-ask-user-index/text-08') },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: modelText('runtime/tool-ask-user-index/text-09'),
            },
          },
        },
      },
    },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          request_id: { type: 'string', required: true }, pending: { type: 'boolean', const: true, required: true },
        } },
        {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      } ] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: args.questions[0]?.question ?? 'Question', kind: 'question' }),
    async execute(args, exec) {
      const questions = args.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header !== undefined ? { header: question.header } : {},
          ...question.options !== undefined ? { options: question.options } : {},
          ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
        }))
      if (continued !== undefined && (args.mode === 'continue' || (!blocking && args.mode === undefined))) {
        if (!exec.agent) throw new Error(modelText('questions/root-only'))
        const pending = continued.defer(exec.agent, questions, exec.signal)
        return { request_id: pending.id, pending: true }
      }
      const result = await ctx.userQuestions.ask({ questions,
        ...exec.agent !== undefined ? { agent: exec.agent } : {}, signal: exec.signal })
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
      }
    },
  })
}

export function apply(ctx: Context): void { ctx.tools.register(questionTool(ctx)) }
