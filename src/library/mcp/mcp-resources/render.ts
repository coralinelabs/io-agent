/**
 * Resource-result projection keeps binary payloads out of model history.
 *
 * @module io-agent/mcp-resources
 */

import { modelText } from "../../context/text/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import type { JsonValue } from "../../util/values/index.ts"

/**
 * Render resource JSON while retaining raw binary data only for programmatic callers.
 * @param server - configured server attribution.
 * @param value - canonical resource result.
 * @returns attributed text with binary payload descriptions.
 */
export function renderResourceResult(server: string, value: JsonValue): ContentBlock[] {
  const rendered = JSON.stringify(value, (key, item: unknown) => {
    if (key === 'blob' && typeof item === 'string') {
      return modelText('foundation/mcp-resources-render/text-01', { value_1: String(item.length) })
    }
    return item
  })
  return [{ type: 'text', text: modelText('foundation/mcp-resources-render/text-02', { value_1: String(server), value_2: String(rendered) }) }]
}
