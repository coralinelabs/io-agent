/**
 * Model-facing read, read_image, write, and edit tools over `ctx.fs`. This package owns schemas, validation,
 * read windows, formatting, and observation events, never a concrete provider. An optional
 * event policy supplies mutation guards; without one the tools use unconditional provider calls.
 * @module io-agent/tool-fs
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import z from "../../runtime/vendor/schemastery/index.ts"
import type {} from "../../interaction/user-approval/index.ts"
import { applyReadTool, READ_LIMIT, STREAM_MIN_SIZE } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'
import { applyReadImageTool } from './read-image.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.ts'
import { FsSandboxController } from './sandbox.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /**
   * Bytes returned by a `read` without `limit` (default: `readMaxBytes`). Smaller, it is a
   * default window: the footer gives the total lines, the continuation offset and points at
   * grep, and an explicit `limit` still reads up to `readMaxBytes`.
   */
  readDefaultMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize?: number
  /**
   * Answer a repeated top-level `read` with a short "unchanged" notice while the
   * newest overlapping read of the same file is still visible with identical content.
   */
  readUnchangedNotice?: boolean
  /**
   * Register `read_image` while `attachments` is mounted (default true). A deployment whose
   * model takes no image input sets false, so the model is never offered a tool every call
   * of which the route check would refuse.
   */
  readImage?: boolean
  /**
   * Advertise the sandbox-escalation fields on `write` and `edit` under a confining backend
   * (default true). A deployment whose approval can never grant an escalation sets false; an
   * unadvertised escalation argument is then rejected before anything runs.
   */
  escalation?: boolean
}

export const Config: z<Config> = z.object({
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  // No schema default: an omitted window means readMaxBytes, whatever that is configured to.
  readDefaultMaxBytes: z.number(),
  readStreamMinSize: z.number().default(STREAM_MIN_SIZE),
  readUnchangedNotice: z.boolean().default(true),
  readImage: z.boolean().default(true),
  escalation: z.boolean().default(true),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'readDefaultMaxBytes'>> & Pick<Config, 'readDefaultMaxBytes'>

/** Every read cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(modelText('foundation/tool-fs-index/text-01', { value_1: String(name) }))
  }
}

/** Register the full `read`/`write`/`edit` filesystem tool suite, plus `read_image` while `attachments` is mounted. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  if (resolved.readDefaultMaxBytes !== undefined) assertPositiveInteger('readDefaultMaxBytes', resolved.readDefaultMaxBytes)
  applyReadTool(ctx, {
    limit: resolved.readLimit,
    maxLineLength: resolved.readMaxLineLength,
    maxBytes: resolved.readMaxBytes,
    ...resolved.readDefaultMaxBytes === undefined ? {} : { defaultMaxBytes: resolved.readDefaultMaxBytes },
    streamMinSize: resolved.readStreamMinSize,
    unchangedNotice: resolved.readUnchangedNotice,
  })
  // read_image is composition-conditional: without a mounted attachment store
  // the deployment cannot durably commit image bytes, and without image input
  // the model could never use it, so the tool never registers; the execute body
  // keeps a defensive re-check for direct callers.
  if (resolved.readImage) {
    ctx.inject(['attachments'], (imageCtx) => {
      applyReadImageTool(imageCtx)
    })
  }
  // One escalation API shared by both mutating tools: advertisement gating,
  // per-call policy resolution, and denial-marker mapping, all keyed off whether
  // the mounted ctx.fs confines (ctx.fs.sandboxMode) and the escalation config.
  const sandbox = new FsSandboxController(ctx, resolved.escalation)
  applyWriteTool(ctx, sandbox)
  applyEditTool(ctx, sandbox)
}
