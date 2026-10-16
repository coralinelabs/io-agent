import { modelText } from "../../context/text/index.ts"
/**
 * Model-visible labeling shared by web tools.
 * @module io-agent/tool-web/trust
 */

/** Prefix that keeps provider-controlled text visibly outside agent instructions. */
export const EXTERNAL_WEB_CONTENT_NOTICE = modelText('runtime/tool-web-trust/text-01')
