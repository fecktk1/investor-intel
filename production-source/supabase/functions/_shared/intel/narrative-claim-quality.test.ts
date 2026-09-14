import {assertEquals} from 'jsr:@std/assert'
import {narrativeClaimQuality} from './narrative-claim-quality.ts'
const pack={member_assets:[{subject:{canonical_key:'market:coinmarketcap:29835'},headlines:{holders:{records:[{subject:'solana:exact',top10Percent:59.11932280625124,sampledTop1Percent:38.4,sourceRef:'holders:original'}]}}}]}
Deno.test('the saved QA denominator error is rejected without rewriting original words',()=>{
 const report={risk_context:[{label:'Holder concentration',detail:'The supplied IO holder snapshot reports 59.11932280625124% concentration among the top 10%, but the provider notes that the data describes a reported population or sample rather than verified beneficial ownership.'}]},before=JSON.stringify(report)
 const quality=narrativeClaimQuality(report,pack)
 assertEquals(quality.status,'needs_review');assertEquals(quality.issues[0].code,'holder_count_as_percentile');assertEquals(quality.issues[0].path,'risk_context[0].detail');assertEquals(JSON.stringify(report),before)
})
Deno.test('spelled-out and hyphenated percentile claims are checked across report and delta prose',()=>{
 for(const statement of ['Top ten percent of holders control 59%.','The top-10% account population is concentrated.']){
  const quality=narrativeClaimQuality({summary:statement},pack);assertEquals(quality.status,'needs_review')
 }
})
Deno.test('valid counts, real zeros, sample caveats and explicit corrections remain usable',()=>{
 for(const statement of ['The ten largest accounts hold 59.12% of reported supply.','Top-10 account concentration is 0%. Sampled top-1 concentration is 0%.','This describes ten accounts, not the top 10% of accounts.','IO is in the top 10% of the performance ranking.'])assertEquals(narrativeClaimQuality({summary:statement},pack).status,'checked')
 assertEquals(narrativeClaimQuality({summary:'Top 10% of holders own 59%.'},{member_assets:[]}).status,'not_applicable')
})
