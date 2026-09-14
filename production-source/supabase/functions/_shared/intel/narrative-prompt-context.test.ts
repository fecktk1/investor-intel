import { assertEquals, assert } from 'jsr:@std/assert'
import { buildPrompt, buildDeltaPrompt } from '../intel-prompts.ts'
import { narrativePromptContext } from './narrative-prompt-context.ts'
import { NARRATIVE_METRIC_GUIDANCE } from './narrative-claim-quality.ts'
function fixture(){
 const members=Array.from({length:8},(_,i)=>({subject:{canonical_key:`market:coinmarketcap:${i+1}`,symbol:'SAME',source_provider:'coinmarketcap',provider_id:String(i+1)},content_hash:`member-${i}`,stale_after:'2026-09-12T08:00:00Z',headlines:{market:{current_price:i,field_evidence:{current_price:{value:i,status:'available',unit:'USD',source_ref:`cmc:quote:${i}`,observed_at:'2026-09-12T07:00:00Z',recorded_at:'2026-09-12T07:00:01Z'}}},holders:{status:'available',records:[{value:0,unit:'accounts',sourceRef:`holder-${i}`,observedAt:'2026-09-12T06:00:00Z'}]},news:{rows:[{title:'x'.repeat(20000)}]}},coverage:{material_gaps:['Missing derivative source'],unavailable_sources:['derivatives'],confidence_impact:'high',should_show_warning:true}}))
 return {unrelated_memory:'x'.repeat(20000),narrative_evidence_pack:{slug:'rwa',content_hash:'narrative-original',membership_evidence_version:1,taxonomy:{id:'n',slug:'rwa',name:'RWA'},state:{momentum_score:0,scored_at:'2026-09-12T07:00:00Z'},member_assets:members,source_states:{narrative_state:'available'},data_coverage:{material_gaps:['Missing member derivatives'],unavailable_sources:['derivatives'],confidence_impact:'high',should_show_warning:true},membership_context:{unresolved_count:0,has_more:false},narrative_signals:[{title:'Dated source',source_url:'https://example.com/primary',observed_at:'2026-09-12T06:00:00Z'}]}}
}
Deno.test('narrative prompts remain valid bounded JSON and give every exact member its complete quote citation',()=>{
 const context=fixture(),original=JSON.stringify(context)
 for(const type of ['narrative_report','narrative_brief'] as const){
  const result=buildPrompt(type,{context}),json=result.user.split('Context data: ')[1].split('\n\nTask:')[0]
  assert(json.length<=9000);const projected=JSON.parse(json)
  assertEquals(projected.narrative_evidence_pack.member_assets.length,8)
  for(let i=0;i<8;i++){const member=projected.narrative_evidence_pack.member_assets[i];assertEquals(member.subject,context.narrative_evidence_pack.member_assets[i].subject);assertEquals(member.headlines.market.field_evidence.current_price,context.narrative_evidence_pack.member_assets[i].headlines.market.field_evidence.current_price)}
  assertEquals(projected.narrative_evidence_pack.state.momentum_score,0)
  assert(projected.projection.omittedRecords>0);assertEquals(JSON.stringify(context),original)
 }
})
Deno.test('narrative delta context is bounded as whole records without partial JSON or erased member IDs',()=>{
 const result=buildDeltaPrompt({artifactType:'narrative_report',context:fixture(),drivers:[],priorSummary:'Original words',priorNetSignal:'neutral'})
 const text=result.user.split('New context data: ')[1].split('\n')[0],projected=JSON.parse(text)
 assert(text.length<=6000);assertEquals(projected.narrative_evidence_pack.member_assets.length,8);assert(result.user.includes('Original words'))
})

Deno.test('explicit network identity and holder metric definitions survive the narrative prompt boundary',()=>{
 const context=fixture(),member:any=context.narrative_evidence_pack.member_assets[0]
 member.subject.chain='solana';member.subject.token_address='verified-contract'
 member.headlines.holders.records=[{top10Percent:0,sampledTop1Percent:0,sourceRef:'original-holder-record',observedAt:'2026-09-12T06:00:00Z'}]
 const result=narrativePromptContext(context,9000)
 assertEquals(result.narrative_evidence_pack.member_assets[0].subject,member.subject)
 assertEquals(result.metric_guidance,NARRATIVE_METRIC_GUIDANCE)
 assert(JSON.stringify(result).length<=9000)
})

Deno.test('bounded projection preserves source availability and gives dated narrative sources space before optional asset detail',()=>{
 const context=fixture(),pack:any=context.narrative_evidence_pack
 pack.narrative_signals=Array.from({length:8},(_,i)=>({id:`signal-${i}`,title:`Narrative-specific observation ${i}`,snippet:'s'.repeat(400),source_url:`https://example.com/source/${i}`,observed_at:'2026-09-12T06:00:00Z'}))
 pack.category_rotation=[{provider:'coinmarketcap',category_id:'1',category_label:'Unrelated category',as_of:'2026-09-12T05:00:00Z',market_cap_change_24h_pct:0}]
 pack.macro_rotation=[{provider:'coinmarketcap',total_market_cap_usd:0,as_of:'2026-09-12T04:00:00Z'}]
 const result=narrativePromptContext(context,9000)
 assertEquals(result.narrative_evidence_pack.bounded_source_record_counts,{narrative_signals:8,category_rotation:1,macro_rotation:1})
 assert(result.narrative_evidence_pack.narrative_signals.length>=2)
 assertEquals(result.narrative_evidence_pack.narrative_signals[0],pack.narrative_signals[0])
 assertEquals(result.projection.included_source_records.narrative_signals,result.narrative_evidence_pack.narrative_signals.length)
 assert(JSON.stringify(result).length<=9000)
})

Deno.test('comparable member performance precedes verbose coverage and omitted fields cannot become missing sources',()=>{
 const context=fixture(),pack:any=context.narrative_evidence_pack
 pack.member_assets=pack.member_assets.slice(0,2)
 for(const member of pack.member_assets){
  const market=member.headlines.market
  for(const [key,value] of [['change_24h_pct',0],['volume_24h',150]]){
   market[key]=value;market.field_evidence[key]={...market.field_evidence.current_price,value,unit:key==='change_24h_pct'?'percent':'USD',source_ref:`${member.content_hash}:${key}`}
  }
  member.headlines.holders.records.push({sourceRef:'large-holder-detail',raw:'x'.repeat(1900)})
  member.coverage.optional_gaps=Array.from({length:10},(_,i)=>`Optional unavailable source ${i} `+'x'.repeat(140))
 }
 const result=narrativePromptContext(context,7000)
 for(let i=0;i<2;i++){
  const member=result.narrative_evidence_pack.member_assets[i]
  assertEquals(member.headlines.market.field_evidence.change_24h_pct,pack.member_assets[i].headlines.market.field_evidence.change_24h_pct)
  assertEquals(member.headlines.market.field_evidence.volume_24h,pack.member_assets[i].headlines.market.field_evidence.volume_24h)
  assertEquals(member.recorded_market_fields,['current_price','change_24h_pct','volume_24h'])
 }
 assert(result.projection.note.includes('Omitted fields are not missing source data'))
 assert(JSON.stringify(result).length<=7000)
})
