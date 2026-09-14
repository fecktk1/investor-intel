import type { BriefEvidencePack } from './brief-evidence-pack.ts'

// This context is written by the server after model synthesis. A model must not
// replace a position, infer a current quote from its cost, or invent ownership.
export function attachBriefPositionSnapshot<T extends Record<string,unknown>>(structured: T, pack: BriefEvidencePack) {
  return { ...structured, personal_context: {
    observed_at:pack.assembled_at,
    portfolio:pack.portfolio_scope,
    holdings:(pack.portfolio_holdings || []).map(h => ({
      canonicalKey:h.canonicalKey, chain:h.chain, symbol:h.symbol, quantity:h.quantity,
      value:h.value ?? null, priceStatus:h.priceStatus || 'unknown', costBasisStatus:h.costBasisStatus || 'unknown',
    })),
    coverage:pack.context_coverage,
  } }
}
