import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { buildCandidateKeys, evaluateSuppression, dedupeCandidates } from './forge-suppression.ts'

const cand = (topic: string, angle = '', extra: Record<string, unknown> = {}) => ({
  kind: 'post_angle', label: topic, ...buildCandidateKeys(topic, angle), ...extra,
})

Deno.test('suppresses a candidate the org already posted about (token overlap)', () => {
  const c = cand('Bitcoin ETF approval drives institutional inflows', 'why the spot ETF approval matters for BTC demand')
  const recent = [{ platform: 'X', text: 'Huge: the Bitcoin spot ETF approval is driving major institutional inflows today', postedAt: new Date().toISOString(), externalId: 'p1' }]
  const v = evaluateSuppression(c, recent)
  assert(v.suppressed)
  assert(['recent_org_post_match', 'duplicate_angle'].includes(v.reason!))
  assertEquals(v.matchedPostId, 'p1')
})

Deno.test('does NOT suppress an unrelated candidate', () => {
  const c = cand('Solana DeFi TVL hits new high', 'SOL ecosystem liquidity growth')
  const recent = [{ platform: 'X', text: 'Ethereum gas fees spike after a busy NFT mint weekend', externalId: 'p2' }]
  assert(!evaluateSuppression(c, recent).suppressed)
})

Deno.test('allowed exceptions are never suppressed', () => {
  const recent = [{ platform: 'X', text: 'Bitcoin ETF approval drives institutional inflows', externalId: 'p1' }]
  for (const flag of ['isBreaking', 'materiallyNew', 'isReply', 'isThreadContinuation']) {
    const c = cand('Bitcoin ETF approval drives institutional inflows', 'same angle', { [flag]: true })
    assert(!evaluateSuppression(c, recent).suppressed, `${flag} must bypass suppression`)
  }
})

Deno.test('same story cluster the org already posted → duplicate_story_cluster', () => {
  const c = { ...cand('whatever topic', 'whatever angle'), clusterId: 'cl-123' }
  const recent = [{ platform: 'X', text: 'totally different wording', clusterId: 'cl-123', externalId: 'p9' }]
  const v = evaluateSuppression(c, recent)
  assert(v.suppressed)
  assertEquals(v.reason, 'duplicate_story_cluster')
})

Deno.test('xOnly tightens thresholds (catches looser paraphrases)', () => {
  const c = cand('Fed signals possible rate cut later this year', 'macro liquidity implications for crypto')
  const recent = [{ platform: 'X', text: 'The Fed hinted at a rate cut — liquidity implications ahead', externalId: 'p3' }]
  const loose = evaluateSuppression(c, recent, { xOnly: false })
  const strict = evaluateSuppression(c, recent, { xOnly: true })
  // strict must be at least as aggressive as loose
  assert(strict.suppressed || !loose.suppressed)
})

Deno.test('empty recent posts → never suppress', () => {
  assert(!evaluateSuppression(cand('anything'), []).suppressed)
})

Deno.test('dedupeCandidates drops near-identical angles within a batch', () => {
  const a = cand('BTC breaks resistance', 'bitcoin breaks key resistance level today')
  const b = cand('BTC breaks resistance', 'bitcoin breaks key resistance level today')   // identical angle
  const cc = cand('Solana upgrade ships', 'solana network upgrade goes live')
  const { kept, dropped } = dedupeCandidates([a, b, cc])
  assertEquals(kept.length, 2)
  assertEquals(dropped.length, 1)
  assertEquals(dropped[0].reason, 'duplicate_recommendation')
})
