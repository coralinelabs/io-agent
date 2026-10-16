/**
 * Window-scaled tool-output budgets for the spill policy.
 *
 * Pure arithmetic: the plugin layer passes the connection's context window
 * and receives the per-result spill threshold, the inline preview size and the
 * per-step aggregate budget, all in UTF-8 bytes. The fractions and floors
 * follow Hermes (`tools/budget_config.py`: 15% of the window per result, 30%
 * per turn, floors 8K/16K); the caps keep io-agent's large-window behaviour
 * (50,000 bytes per result) and bound one step to twice that.
 *
 * @module io-agent/spill-policy/budget
 */

/** Bytes per token used to turn a token window into a byte budget (the token meter's density). */
export const TOOL_OUTPUT_BYTES_PER_TOKEN = 4

/** Fraction of the window one tool result may occupy inline. */
const PER_RESULT_FRACTION = 0.15
/** Fraction of the window all results of one step may occupy inline. */
const PER_STEP_FRACTION = 0.30
/** Smallest per-result threshold, so a tiny window still gets a usable result. */
const MIN_RESULT_BYTES = 8_000
/** Smallest per-step budget. */
const MIN_STEP_BYTES = 16_000
/** Largest per-result threshold: the former fixed cap. */
const MAX_RESULT_BYTES = 50_000
/** Largest per-step budget. */
const MAX_STEP_BYTES = 100_000
/** Inline preview kept for a spilled result: head 2,000 + tail 2,000 bytes. */
export const DEFAULT_PREVIEW_BYTES = 4_000

/** The three spill-policy budgets derived from one context window. */
export interface ToolOutputBudget {
  /** Spill a plain-text result larger than this (and never emit a replacement larger than it). */
  readonly maxInlineBytes: number
  /** Head/tail preview budget kept inline for a spilled result. */
  readonly previewBytes: number
  /** Spill the largest results of one step until its text total is at most this. */
  readonly stepBudgetBytes: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Scale the spill budgets to a model's context window.
 * @param contextWindow - positive token capacity of the route.
 * @returns the per-result threshold, preview size and per-step budget in UTF-8 bytes.
 * @throws when the window is not a positive safe integer.
 */
export function toolOutputBudget(contextWindow: number): ToolOutputBudget {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new TypeError(`toolOutputBudget: contextWindow must be a positive safe integer (got ${contextWindow})`)
  }
  const windowBytes = contextWindow * TOOL_OUTPUT_BYTES_PER_TOKEN
  return Object.freeze({
    maxInlineBytes: clamp(Math.floor(windowBytes * PER_RESULT_FRACTION), MIN_RESULT_BYTES, MAX_RESULT_BYTES),
    previewBytes: DEFAULT_PREVIEW_BYTES,
    stepBudgetBytes: clamp(Math.floor(windowBytes * PER_STEP_FRACTION), MIN_STEP_BYTES, MAX_STEP_BYTES),
  })
}
