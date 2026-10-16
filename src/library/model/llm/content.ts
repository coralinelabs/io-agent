/** Content-block structure helpers. @module io-agent/llm/content */

import { modelText } from "../../context/text/index.ts"
import type { ContentBlock, ImageBlock, LlmImageRequestBudget } from './types.ts'
import type { Message } from './message.ts'
import type {
  AttachmentStore, FileAttachmentRef, ImageAttachmentRef, ImageMediaType, RequestImageAttachment,
} from "../../context/attachments/attachment/index.ts"
import { assertNever } from "../../util/values/index.ts"

/** Execution-world path that model tools can use to read one normalized attachment. */
export interface ImageAttachmentAccess {
  /** Absolute path to immutable normalized bytes; callers must treat it as read-only. */
  readonlyPath: string
}

/**
 * Resolve current execution-world access for one durable image reference.
 * @param ref - durable normalized attachment reference.
 * @returns a read-only execution-world path, or undefined when unavailable.
 */
export type ImageAttachmentAccessResolver = (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined

/**
 * Bridge one attachment provider's host object location into the mounted
 * tool execution world. The consumer supplies the current filesystem
 * provider's mapping without making attachment or LLM definitions depend on it.
 * @param attachments - provider that owns the normalized attachment object.
 * @param mapHostPath - map one absolute host path into the current tool execution world.
 * @param ref - durable normalized attachment reference.
 * @returns a read-only execution-world path, or undefined when either provider exposes no mapping.
 * @throws an attachment error when the durable reference is invalid.
 */
export function resolveImageAttachmentAccess(
  attachments: AttachmentStore,
  mapHostPath: (hostPath: string) => string | undefined,
  ref: ImageAttachmentRef,
): ImageAttachmentAccess | undefined {
  const hostPath = attachments.imageHostPath(ref)
  if (hostPath === undefined) return undefined
  const readonlyPath = mapHostPath(hostPath)
  return readonlyPath === undefined ? undefined : { readonlyPath }
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function imageIdentity(ref: ImageAttachmentRef): string {
  return ref.name === undefined
    ? String(ref.attachmentId)
    : `${quoted(ref.name)} (${ref.attachmentId})`
}

function extension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return assertNever(mediaType, 'image extension')
  }
}

function normalizedAccessText(ref: ImageAttachmentRef, access: ImageAttachmentAccess): string {
  return modelText('foundation/llm-content/text-01', { value_1: String(quoted(access.readonlyPath)), value_2: String(ref.width), value_3: String(ref.height), value_4: String(ref.mediaType), value_5: String(extension(ref.mediaType)) })
}

/**
 * Stable text shown to a model that cannot accept one durable image reference.
 * @param ref - durable normalized attachment omitted from the request.
 * @returns deterministic text-only placeholder.
 */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return modelText('foundation/llm-content/text-02', { value_1: String(digest) })
}

/**
 * Stable model-facing handle for one exact request image. Identity comes from
 * the occurrence's own durable reference: request versions are prepared per
 * attachment id, so one shared version may serve occurrences whose display
 * names differ.
 * @param ref - the occurrence's durable normalized attachment.
 * @param version - exact request-image dimensions shown beside the text.
 * @param access - optional path resolved for the current tool execution world.
 * @returns attachment handle and request-image dimensions.
 */
export function requestImageHandleText(
  ref: ImageAttachmentRef,
  version: Pick<RequestImageAttachment, 'width' | 'height'>,
  access?: ImageAttachmentAccess,
): string {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  return access === undefined
    ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
    : preview + normalizedAccessText(ref, access)
}

/**
 * Stable per-image placeholder for a request-limit omission.
 * @param ref - durable normalized attachment omitted from this request.
 * @param access - optional provider-resolved path for model tools.
 * @returns identity, normalized metadata, and the available recovery path.
 */
export function offloadedImageText(
  ref: ImageAttachmentRef,
  access?: ImageAttachmentAccess,
): string {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  if (access === undefined) {
    return modelText('foundation/llm-content/text-03', { value_1: String(identity) })
  }
  return `[${identity}${normalizedAccessText(ref, access)}]`
}

/** Message content is flat; results have their own role, identity, and outcome. */
export function* walkContent(content: readonly ContentBlock[]): Generator<ContentBlock> {
  yield* content
}

/** Map occurrences in wire order, retaining the original array when unchanged. */
export function mapContent(content: readonly ContentBlock[],
  replace: (block: ContentBlock) => ContentBlock): readonly ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of content.entries()) {
    const replacement = replace(block)
    if (replacement !== block) next ??= content.slice(0, index)
    next?.push(replacement)
  }
  return next ?? content
}

/** Apply a content projection once per message, retaining the request identity
 * when it changes nothing. Leaf resolvers run exactly once per occurrence.
 */
function projectContent(messages: readonly Message[],
  replace: (block: ContentBlock) => ContentBlock): readonly Message[] {
  let next: Message[] | undefined
  for (const [index, message] of messages.entries()) {
    const content = mapContent(message.content, replace)
    if (content !== message.content) {
      next ??= messages.slice(0, index)
      next.push({ ...message, content: content as ContentBlock[] })
    } else next?.push(message)
  }
  return next ?? messages
}

/** Whether the current content, has an image. */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  for (const block of walkContent(content)) if (block.type === 'image') return true
  return false
}

/** Whether the current content, has a file. */
export function contentHasFile(content: readonly ContentBlock[]): boolean {
  for (const block of walkContent(content)) if (block.type === 'file') return true
  return false
}

/**
 * Stable model-facing handle for one durable file reference: the address of
 * the verbatim stored copy and the instruction to read it on demand. This is
 * the only representation a provider ever receives for a file.
 * @param ref - durable verbatim file reference.
 * @param readonlyPath - execution-world path of the stored copy, when resolvable.
 * @returns deterministic handle text naming the file, its size, and its address.
 */
export function fileHandleText(ref: FileAttachmentRef, readonlyPath: string | undefined): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  if (readonlyPath === undefined) {
    return modelText('foundation/llm-content/text-04', { value_1: String(identity) })
  }
  return modelText('foundation/llm-content/text-05', { value_1: String(identity), value_2: String(quoted(readonlyPath)) })
}

/**
 * Project durable file history into deterministic handle text for every model
 * route. Unlike images, no provider receives file blocks natively, so this
 * projection is unconditional in request assembly.
 * @param messages - complete request history.
 * @param resolvePath - resolve one reference's current execution-world read path.
 * @returns the original list without files, otherwise shallow message copies with handle text.
 */
export function projectFilesToText(
  messages: readonly Message[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly Message[] {
  return projectContent(messages, block => block.type === 'file'
    ? { type: 'text', text: fileHandleText(block.attachment, resolvePath(block.attachment)) } : block)
}

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Project the surface's offloaded occurrences into deterministic text for one
 * request. The offloaded set is a durable surface fact, so every route sends
 * the same set; only the placeholder text is route-owned.
 * @param messages - derived request history.
 * @param placeholder - build the model-visible replacement for one offloaded attachment.
 * @returns the original list when nothing is offloaded, otherwise shallow message copies with placeholders.
 */
export function projectOffloadedImages(
  messages: readonly Message[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly Message[] {
  return projectContent(messages, block => block.type === 'image' && block.offloaded === true
    ? { type: 'text', text: placeholder(block.attachment) } : block)
}

/**
 * Number of oldest retained image occurrences one route budget removes, in
 * whole count and byte quanta, once the budget is exceeded. The result depends
 * only on the represented lengths, so every route names the count the same
 * way.
 * @param lengths - represented byte length of every retained occurrence, oldest first.
 * @param budget - count/byte budgets and removal quanta; unbounded when absent.
 * @returns how many leading occurrences to offload.
 */
function offloadedImagePrefixCount(
  lengths: readonly number[],
  budget: Pick<LlmImageRequestBudget, 'maxImages' | 'maxBytes' | 'countQuantum' | 'byteQuantum'>,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = budget.maxImages === undefined ? 0 : Math.max(0, lengths.length - budget.maxImages)
  const excessBytes = budget.maxBytes === undefined ? 0 : Math.max(0, total - budget.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const countQuantum = budget.countQuantum ?? 1
  const byteQuantum = budget.byteQuantum ?? 1
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += imageBytes
    count += 1
  }
  return count
}

/**
 * Number of oldest retained occurrences a route must still offload before a
 * derived request fits its budget at the exact byte length the route sends;
 * zero when the request fits. A route fails with `IMAGE_OFFLOAD_REQUIRED`
 * carrying this count instead of offloading on its own.
 * @param messages - derived request history carrying the surface's `offloaded` marks.
 * @param budget - route representation, budgets, and removal quanta.
 * @param versionBytes - exact request-version byte length of one retained occurrence.
 * @returns how many more leading retained occurrences to offload.
 */
export function requiredImageOffload(
  messages: readonly Message[],
  budget: Pick<LlmImageRequestBudget, 'representation' | 'maxBytes' | 'maxImages' | 'byteQuantum' | 'countQuantum'>,
  versionBytes: (block: ImageBlock) => number,
): number {
  const lengths: number[] = []
  for (const message of messages) {
    for (const block of walkContent(message.content)) {
      if (block.type !== 'image' || block.offloaded === true) continue
      const bytes = versionBytes(block)
      lengths.push(budget.representation === 'base64' ? base64Length(bytes) : bytes)
    }
  }
  return offloadedImagePrefixCount(lengths, budget)
}

/**
 * Project durable image history into deterministic text for an exact text-only model.
 * @param messages - complete request history.
 * @returns the original list without images, otherwise shallow message copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[] {
  return projectContent(messages, block => block.type === 'image'
    ? { type: 'text', text: textOnlyImageText(block.attachment) } : block)
}
