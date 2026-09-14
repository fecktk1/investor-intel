import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { attachBriefPositionSnapshot } from './brief-position-snapshot.ts'
import type { BriefEvidencePack } from './brief-evidence-pack.ts'
Deno.test('server position snapshot replaces model-invented holdings and keeps unknown values unknown',()=>{
 const pack={assembled_at:'2026-09-10T22:00:00Z',portfolio_scope:{id:'owned',name:'QA'},portfolio_holdings:[{canonicalKey:'eip155:8453:0x123',chain:'base',symbol:'USDC',quantity:1000,value:null,priceStatus:'unpriced',costBasisStatus:'known'}],context_coverage:{holdings_truncated:false}} as unknown as BriefEvidencePack
 const result=attachBriefPositionSnapshot({summary:'Original synthesis',personal_context:{portfolio:{id:'foreign'},holdings:[{symbol:'BTC',value:1234}]}},pack)
 assertEquals(result.summary,'Original synthesis');assertEquals(result.personal_context.portfolio?.id,'owned')
 assertEquals(result.personal_context.holdings[0].quantity,1000);assertEquals(result.personal_context.holdings[0].value,null)
 assertEquals(result.personal_context.holdings[0].canonicalKey,'eip155:8453:0x123');assertEquals(result.personal_context.holdings[0].priceStatus,'unpriced')
})
