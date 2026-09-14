import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { compactBriefPromptContext } from './brief-prompt-context.ts'
import { buildPrompt } from '../intel-prompts.ts'
Deno.test('long news cannot evict portfolio identity from either brief prompt budget',()=>{
 const input={evidence_package:Array.from({length:30},()=>({title:'Headline',summary:'news '.repeat(3000)})),brief_evidence_pack:{portfolio_scope:{id:'qa-portfolio',name:'QA portfolio'},portfolio_holdings:[{canonicalKey:'eip155:8453:0x123',chain:'base',symbol:'USDC',quantity:1000,value:null,priceStatus:'unpriced',costBasisStatus:'known'}],market_regime:{regime:'risk_off'},data_coverage:{used_sources:['cached positions']}}}
 const result=compactBriefPromptContext(input),json=JSON.stringify(result)
 assert(json.length<=8500);assertEquals(JSON.stringify(JSON.parse(json.slice(0,9000))),json)
 assertEquals(result.brief_evidence_pack.portfolio_holdings[0].quantity,1000)
 const prompt=buildPrompt('daily_brief',{context:result})
 assert(prompt.user.includes('qa-portfolio'));assert(prompt.user.includes('"value":null'))
 assertEquals(input.brief_evidence_pack.portfolio_holdings.length,1)
})
Deno.test('large holdings samples disclose prompt truncation and retain canonical keys',()=>{
 const result=compactBriefPromptContext({brief_evidence_pack:{portfolio_scope:{id:'p'},portfolio_holdings:Array.from({length:200},(_,i)=>({canonicalKey:`solana:${'A'.repeat(40)}${i}`,symbol:'A'.repeat(200),quantity:1,chain:'solana'}))}})
 assert(JSON.stringify(result).length<=8500);assertEquals(result.brief_evidence_pack.portfolio_coverage.available_holdings,200)
 assertEquals(result.brief_evidence_pack.portfolio_coverage.prompt_holdings_truncated,true)
 assert(result.brief_evidence_pack.portfolio_holdings.length<=12)
})
Deno.test('oversized regime and coverage cannot break the private-context JSON budget',()=>{
 const huge=Object.fromEntries(Array.from({length:18},(_,i)=>[`field${i}`,Object.fromEntries(Array.from({length:18},(_,j)=>[`nested${j}`,'X'.repeat(2000)]))]))
 const result=compactBriefPromptContext({brief_evidence_pack:{portfolio_scope:{id:'p',name:'Portfolio'},portfolio_holdings:[{canonicalKey:'eip155:8453:native',quantity:2}],market_regime:huge,data_coverage:huge,context_coverage:huge,assembled_at:'x'.repeat(30000)}})
 assert(JSON.stringify(result).length<=8500);assertEquals(result.brief_evidence_pack.portfolio_holdings[0].quantity,2)
 assertEquals(result.brief_evidence_pack.market_regime.prompt_truncated,true)
})
