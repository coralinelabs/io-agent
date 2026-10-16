import { describe, expect, it } from 'vitest'
import { contentHasFile, contentHasImage, mapContent, projectFilesToText, projectImagesForTextModel,
  projectOffloadedImages, requiredImageOffload, walkContent } from '../../../src/library/model/llm/content.ts'
import { estimateContent, estimateMessage } from '../../../src/library/model/token-meter/estimate.ts'
import { ToolCallId, type ContentBlock, type Message, createToolResultMessage } from '../../../src/library/model/llm/index.ts'
import type { FileAttachmentRef, ImageAttachmentRef } from '../../../src/library/context/attachments/attachment/index.ts'

const file = (name: string): ContentBlock => ({ type: 'file', attachment: {
  attachmentId: 'sha256:' + 'a'.repeat(64), name, bytes: 7,
} as FileAttachmentRef })
const image: ContentBlock = { type: 'image', attachment: {
  attachmentId: 'sha256:' + 'b'.repeat(64), name: 'plot.png', bytes: 30, width: 8, height: 9, mediaType: 'image/png',
} as ImageAttachmentRef }
const text: ContentBlock = { type: 'text', text: 'evidence' }
const message = (content: ContentBlock[]): Message => ({ role: 'user', content, source: { kind: 'user' } })
const tool = (content: ContentBlock[]) => createToolResultMessage({ callId: ToolCallId('call'), content, isError: true })

describe('shared native request-content projection', () => {
  it('shares unchanged requests instead of copying or rewriting them', () => {
    const blocks = [text, text], messages = [message(blocks), tool(blocks)]
    expect(mapContent(blocks, block => block)).toBe(blocks)
    expect(projectFilesToText(messages, () => undefined)).toBe(messages)
    expect(projectImagesForTextModel(messages)).toBe(messages)
    expect(projectOffloadedImages(messages, () => 'omitted')).toBe(messages)
  })
  it('preserves message-level tool identity, siblings, roles and failure evidence', () => {
    const child = tool([file('a'), text])
    const sibling = message([text]), source = [child, sibling]
    const output = projectFilesToText(source, () => '/workspace/a')
    expect(output[1]).toBe(sibling)
    expect(output[0]).toMatchObject({ id: child.id, role: 'tool', toolCallId: 'call', isError: true, source: child.source })
    expect(output[0]!.content[1]).toBe(child.content[1])
    expect(child.content[0]!.type).toBe('file')
    expect(output[0]!.content[0]!.type).toBe('text')
  })
  it('resolves duplicate occurrences exactly once, in wire order', () => {
    const repeated = file('same'), seen: string[] = []
    projectFilesToText([message([file('a'), repeated]), tool([file('b'), repeated])], ref => {
      seen.push(ref.name); return '/files/' + ref.name
    })
    expect(seen).toEqual(['a', 'same', 'b', 'same'])
  })
  it('does not cache capability checks across edits to borrowed content', () => {
    const blocks: ContentBlock[] = [text]
    expect(contentHasImage(blocks)).toBe(false); expect(contentHasFile(blocks)).toBe(false)
    blocks.push(file('new'), image)
    expect(contentHasImage(blocks)).toBe(true); expect(contentHasFile(blocks)).toBe(true)
  })
  it('scans, maps and prices large native results without nested wrapper traversal', () => {
    const blocks: ContentBlock[] = [...Array.from({ length: 15000 }, () => text), image, file('large')]
    expect(contentHasImage(blocks)).toBe(true); expect(contentHasFile(blocks)).toBe(true)
    expect([...walkContent(blocks)]).toHaveLength(15002)
    const output = projectFilesToText([tool(blocks)], () => '/workspace/large')
    expect(contentHasFile(output[0]!.content)).toBe(false)
    expect(contentHasImage(output[0]!.content)).toBe(true)
    expect(estimateContent(blocks)).toBe(15000 * estimateContent([text]) + estimateContent([image, file('large')]))
    expect(contentHasImage(projectImagesForTextModel(output)[0]!.content)).toBe(false)
    expect(output[0]!.role).toBe('tool')
  })
  it('counts repeated image occurrences but excludes already offloaded occurrences', () => {
    const calls: ContentBlock[] = []
    const count = requiredImageOffload([message([image]), tool([image, { ...image, offloaded: true } as ContentBlock])],
      { representation: 'base64', maxImages: 1 }, block => { calls.push(block); return 30 })
    expect(calls).toHaveLength(2); expect(count).toBe(1)
  })
  it('does not truncate subsequent content when a shared leaf is transformed', () => {
    const blocks = [text, text, image, text, text]
    const output = projectImagesForTextModel([tool(blocks)])[0]!.content
    expect([...walkContent(output)].filter(block => block.type === 'text')).toHaveLength(5)
    expect(estimateContent([{ type: 'tool-call', id: ToolCallId('x'), name: 'edit', arguments: '12345678' }])).toBe(7)
  })
})
