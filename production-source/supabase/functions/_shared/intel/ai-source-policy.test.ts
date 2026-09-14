import assert from 'node:assert/strict'
import { containsCmcOrigin, prepareAiContext, prepareClientAiContext, loadCmcAiAllowed } from './ai-source-policy.ts'
import { hasVerifiedCexIdentity, marketIdentityChoices } from './market-read-quality.ts'
Deno.test('AI use requires the explicit shared product policy and stops at its review deadline',async()=>{
 const db=(config:unknown)=>{const q:any={};for(const k of ['select','eq'])q[k]=()=>q;q.maybeSingle=async()=>({data:{config}});return {from:()=>q}}
 assert.equal(await loadCmcAiAllowed(db({CMC_ALLOW_HISTORICAL_RETENTION:'true'})),false)
 assert.equal(await loadCmcAiAllowed(db({CMC_ALLOW_AI_PROCESSING:'true',CMC_SOURCE_POLICY_EXPIRES_AT:new Date(Date.now()+60000).toISOString()})),true)
 assert.equal(await loadCmcAiAllowed(db({CMC_ALLOW_AI_PROCESSING:'true',CMC_SOURCE_POLICY_EXPIRES_AT:new Date(Date.now()-1).toISOString()})),false)
})

Deno.test('display permission cannot silently become AI processing permission', () => {
  const evidence = { note: 'My own words', rows: [{ source_provider: 'coinmarketcap', price: 12 }, { provider: 'coingecko', price: 13 }] }
  assert.deepEqual(prepareAiContext(evidence, false), { note: 'My own words', rows: [{ provider: 'coingecko', price: 13 }] })
  assert.deepEqual(prepareAiContext(evidence, true), evidence)
  assert.equal(containsCmcOrigin({ market_cap_source: 'coinmarketcap' }), true)
  assert.deepEqual(prepareAiContext({ asset_evidence_pack: { derived: 99, facts: [{ source_url: 'https://coinmarketcap.com/currencies/bitcoin' }] }, note: 'Retain' }, false), { note: 'Retain' })
})
Deno.test('client market claims must be rebuilt from server evidence even with forged source tags', () => {
  assert.deepEqual(prepareClientAiContext({ question: 'My research question', token_profile: { provider: 'coingecko', price: 999 }, asset_evidence_pack: { note: 'forged' } }), { question: 'My research question' })
  assert.equal(prepareClientAiContext([]), null)
})
Deno.test('exchange joins require a provider ID, exact contract, or registered native identity', () => {
  const imposter = { source_provider: 'coinmarketcap', provider_id: '777', normalized_symbol: 'BTC' }
  assert.equal(hasVerifiedCexIdentity(imposter, { source: 'curated', normalized_symbol: 'BTC', canonical_asset_id: 'bitcoin' }), false)
  assert.equal(hasVerifiedCexIdentity(imposter, { canonical_asset_id: 'coinmarketcap:777' }), true)
  assert.equal(hasVerifiedCexIdentity({ source_provider:'coinmarketcap', provider_id:'1', normalized_symbol:'BTC' }, null), true)
  const sol = { source_provider: 'coinmarketcap', provider_id: '888', platforms: { solana: 'AbcMint' } }
  assert.equal(hasVerifiedCexIdentity(sol, { chain:'solana', contract_address:'abcmint' }), false)
  assert.equal(hasVerifiedCexIdentity(sol, { chain:'solana', contract_address:'AbcMint' }), true)
})
Deno.test('Ethereum network choices preserve separate native ledgers without symbol aggregation', () => {
  const keys = marketIdentityChoices({ source_provider:'coinmarketcap',provider_id:'1027' }).map(row => row.canonicalAssetKey)
  assert.ok(keys.includes('eip155:1:native'))
  assert.ok(keys.includes('eip155:42161:native'))
  assert.ok(keys.includes('eip155:8453:native'))
  assert.deepEqual(marketIdentityChoices({ normalized_symbol: 'ETH' }), [])
})
