// Versioned original editorial summaries. Add a revision; never rewrite the
// words or dates of one used by a saved evidence pack. No provider requests,
// wallet reads, accounting adjustments or implied current trading prices.
//
// A review does NOT expire on a clock. It stays current until a later revision
// supersedes it or until an explicit lapse is declared, matching
// _shared/intel/rwa-issuer-evidence.ts.
const REVIEWED_AT = '2026-09-12T05:02:37.000Z'
/** Set only when a reviewer decides this summary can no longer be relied on,
 * with the instant it stopped being current. Null means it is still current and
 * will stay so until someone says otherwise. */
const LAPSED_AT: string | null = null
const SOURCE = 'https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/smart-contract/contract-address.md'
const CONTRACTS = [
  ['eip155:137:0xa7e22972a19dd924afeedf3db28033b146801081', 'Polygon'],
  ['eip155:177:0x2577217c86ae2e8a5f70abb663b9231e5d47d15a', 'HashKey Chain'],
  ['tron:TDfX64Ariz5usffBJjtDbiMuCXVpKiDCEb', 'Tron'],
] as const

function exactKey(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const evm = /^eip155:([1-9]\d*):(?:erc20:)?(0x[0-9a-f]{40})$/i.exec(input)
    || /^eip155:([1-9]\d*)\/erc20:(0x[0-9a-f]{40})$/i.exec(input)
  if (evm) return `eip155:${evm[1]}:${evm[2].toLowerCase()}`
  return /^tron:[1-9A-HJ-NP-Za-km-z]{34}$/.test(input) ? input : null
}

/** Null means no applicable retained editorial review, never "supported" or
 * "safe". Date-only issuer notices are not invented midnight chart events. */
export function representationReview(input: unknown, asOf = Date.now()) {
  const key = exactKey(input), match = CONTRACTS.find(([contract]) => contract === key)
  if (!match || !Number.isFinite(asOf) || asOf < Date.parse(REVIEWED_AT)) return null
  return {
    status: LAPSED_AT && asOf >= Date.parse(LAPSED_AT) ? 'review_expired' : 'reviewed',
    canonicalAssetKey: match[0], network: match[1], issuer: 'Matrixdock',
    sourceRef: `issuer-network-review-1:${match[0]}`, reviewVersion: 'issuer-network-review-1',
    sourceUrl: SOURCE, reviewedAt: REVIEWED_AT, reviewLapsedAt: LAPSED_AT,
    effectiveDate: '2026-08-07', effectiveTime: null,
    summary: 'Matrixdock lists this exact deployment as retired and does not recognize its balances as valid XAUm. The notice does not determine a market price or erase your recorded holdings and transactions.',
    timeMeaning: 'The issuer gives a date without a time or timezone. The review time records our source check, not the retirement event or a transaction.',
    aiAllowed: false, exportAllowed: true,
  }
}

/** Source-specific AI permission is not relaxed by an original UI summary.
 * Models may know that human-only evidence exists and cite its reference;
 * they do not receive its content or infer a conclusion from its absence. */
export function representationPromptState(review: ReturnType<typeof representationReview>) {
  return review ? {
    status: 'restricted', sourceRef: review.sourceRef, reviewedAt: review.reviewedAt,
    reason: 'A linked editorial source review is available for human inspection; its content is not permitted in this AI context.',
  } : null
}
