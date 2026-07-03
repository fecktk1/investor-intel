import {
  computeTokenRisk, computeConcentration, securityInputFromRaw, hasSecuritySignal, toPct, riskSummary, RISK_SCORE_VERSION,
} from './token-risk.ts'

function assert(c: unknown, m: string) { if (!c) throw new Error(m) }
function eq(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

Deno.test('unrated: empty provider response is NOT scored 100 (no false-safe)', () => {
  // Birdeye returned nothing (e.g. EVM token on the Solana-primary endpoint).
  eq(hasSecuritySignal(null), false, 'null raw → no signal')
  eq(hasSecuritySignal({}), false, 'empty raw → no signal')
  eq(hasSecuritySignal({ freezeAuthority: null, mutableMetadata: true }), true, 'a real key present → signal')
  const empty = computeTokenRisk(securityInputFromRaw({}))
  eq(empty.rated, false, 'empty security data → unrated')
  // Even though the raw math yields 100, the caller must skip it because rated=false.
  const withData = computeTokenRisk(securityInputFromRaw({ freezeAuthority: null, mutableMetadata: false, jupStrictList: true }))
  eq(withData.rated, true, 'real Birdeye data → rated')
  // CoinGecko GT cross-check alone (no Birdeye) is enough to rate an EVM token.
  const gtOnly = computeTokenRisk(securityInputFromRaw({}, { gtScore: 80, gtHoneypot: 'false' }))
  eq(gtOnly.rated, true, 'GT cross-check present → rated')
})

Deno.test('toPct: fraction → percent; already-pct passthrough', () => {
  eq(toPct(0.32), 32, 'fraction 0.32 → 32')
  eq(toPct(38), 38, 'already-pct 38 stays 38')
  eq(toPct(null), null, 'null → null')
})

Deno.test('hard-fail: nonTransferable / fakeToken / isTrueToken=false / GT honeypot cap the score', () => {
  const r = computeTokenRisk({ nonTransferable: true, top10HolderPercent: 0.1 })
  assert(r.hard_fail, 'hard fail set')
  assert(r.hard_fail_flags.includes('non_transferable'), 'flag recorded')
  assert(r.score <= 20, 'score capped at 20')
  assert(computeTokenRisk({ fakeToken: true }).hard_fail, 'fakeToken hard-fails')
  assert(computeTokenRisk({ isTrueToken: false }).hard_fail, 'not-true-token hard-fails')
  assert(computeTokenRisk({ gtHoneypot: 'true' }).hard_fail, 'GT honeypot hard-fails')
})

Deno.test('USDC-like (freeze auth, mutable, 32% top10) scores moderate, not hard-fail', () => {
  const r = computeTokenRisk({ freezeAuthority: 'someAuth', mutableMetadata: true, top10HolderPercent: 0.32, isTrueToken: true, nonTransferable: false })
  assert(!r.hard_fail, 'legit token not hard-failed')
  // 100 - freeze(15) - mutable(10) - concentration(16) = 59
  eq(r.penalties.freeze_authority, 15, 'freeze penalty')
  eq(r.penalties.mutable_metadata, 10, 'mutable penalty')
  eq(r.penalties.concentration, 16, '32% * 0.5 = 16')
  eq(r.score, 59, 'moderate score')
})

Deno.test('clean token (no authority, immutable, low concentration, jup-verified) scores high', () => {
  const r = computeTokenRisk({ freezeAuthority: null, mutableMetadata: false, top10HolderPercent: 0.1, jupStrictList: true, isTrueToken: true, nonTransferable: false })
  // 100 - concentration(5) = 95
  eq(r.score, 95, 'high score')
  assert(!r.hard_fail, 'not hard fail')
})

Deno.test('cross-provider confidence: GT present raises confidence; disagreement lowers it', () => {
  eq(computeTokenRisk({ top10HolderPercent: 0.2 }).confidence, 0.7, 'single-source 0.7')
  eq(computeTokenRisk({ top10HolderPercent: 0.2, gtScore: 80, gtHoneypot: 'false', nonTransferable: false }).confidence, 0.9, 'two agreeing sources 0.9')
  const dis = computeTokenRisk({ gtHoneypot: 'false', nonTransferable: true })
  assert(dis.disagreements.length > 0, 'disagreement recorded')
  eq(dis.confidence, 0.6, 'disagreement lowers confidence')
})

Deno.test('concentration score + gini from top-holder amounts', () => {
  const c = computeConcentration(0.38, [{ ui_amount: 100 }, { ui_amount: 50 }, { ui_amount: 10 }, { ui_amount: 5 }])
  eq(c.score, 38, 'score from top10 pct')
  eq(c.band, 'medium', '38% → medium band')
  assert(c.top1_pct != null && c.top1_pct > 50, 'top1 dominates')
  assert(c.gini != null && c.gini > 0, 'gini computed')
  eq(computeConcentration(0.8, null).band, 'extreme', '80% → extreme')
})

Deno.test('securityInputFromRaw maps the real Birdeye Solana field names', () => {
  const raw = { freezeAuthority: 'F1', mutableMetadata: true, nonTransferable: false, isTrueToken: true, fakeToken: false, transferFeeEnable: false, top10HolderPercent: 0.32, creatorPercentage: 0.05, jupStrictList: true }
  const s = securityInputFromRaw(raw, { gtScore: 70, gtHoneypot: 'false' })
  eq(s.freezeAuthority, 'F1', 'freeze mapped')
  eq(s.top10HolderPercent, 0.32, 'top10 mapped')
  eq(s.jupStrictList, true, 'jup mapped')
  eq(s.gtScore, 70, 'GT cross-check attached')
  const r = computeTokenRisk(s)
  assert(r.cross_provider, 'cross-provider set from GT')
})

Deno.test('riskSummary is a readable one-liner for RAG + tooltip', () => {
  const s = securityInputFromRaw({ freezeAuthority: 'F1', mutableMetadata: true, top10HolderPercent: 0.32, isTrueToken: true, nonTransferable: false })
  const risk = computeTokenRisk(s)
  const conc = computeConcentration(0.32)
  const sum = riskSummary('USDC', risk, conc)
  assert(sum.includes('USDC'), 'names the token')
  assert(sum.includes('top-10 hold 32%'), 'includes concentration')
  eq(RISK_SCORE_VERSION, 1, 'version pinned')
})
