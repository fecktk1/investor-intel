import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { comparisonPromptContext,comparisonEvidenceInput } from './comparison-prompt-context.ts'
Deno.test('all four assets retain exact values and source clocks before oversized optional evidence', () => {
  const input = { unrelated_news: 'noise'.repeat(10000), asset_evidence_packs: Array.from({ length: 4 }, (_, i) => ({ subject: { canonical_key: `market:coinmarketcap:${i+1}`, symbol: 'SAME' }, content_hash: `hash-${i}`, pack: { market_summary: { current_price: i, volume_24h: i * 1000, market_cap: 0, freshness: { as_of: '2026-09-11T13:11:00Z', recorded_at: '2026-09-11T13:12:00Z', source_ref: `exact:${i}` } }, liquidity_state: { description: 'detail'.repeat(10000), depth: i }, news_state: { items: Array.from({ length: 100 }, () => ({ title: 'Long story'.repeat(100) })) } } })) }
  const before = JSON.stringify(input), result = comparisonPromptContext(input), wire = JSON.stringify(result)
  assert(wire.length <= 8500); assertEquals(JSON.parse(wire).asset_evidence_packs.length, 4)
  result.asset_evidence_packs.forEach((p: any, i: number) => { assertEquals(p.pack.market_summary.current_price, i); assertEquals(p.pack.market_summary.market_cap, 0); assertEquals(p.pack.market_summary.freshness.source_ref, `exact:${i}`); assertEquals(p.pack.market_summary.freshness.recorded_at, '2026-09-11T13:12:00Z') })
  assertEquals(JSON.stringify(input), before); assert(!wire.includes('noise'))
})
Deno.test('missing evidence stays missing without discarding a basket member', () => {
  const result = comparisonPromptContext({asset_evidence_packs:[{subject:{canonical_key:'market:coinmarketcap:1'}},{subject:{canonical_key:'market:coinmarketcap:2'},pack:{market_summary:{current_price:4}}}]})
  assertEquals(result.asset_evidence_packs[0].pack.market_summary.current_price, null)
  assertEquals(result.asset_evidence_packs[1].pack.market_summary.current_price, 4)
})
Deno.test('comparison retains distinct field clocks and complete new source sections with their baselines',()=>{
 const price={value:0,unit:'USD',provider:'coinmarketcap',as_of:'2026-09-12T04:00:00Z',recorded_at:'2026-09-12T04:01:00Z',source_ref:'price-original'}
 const volume={...price,value:40,as_of:'2026-09-11T00:00:00Z',source_ref:'volume-original'}
 const benchmark={status:'available',comparisons:[{rows:[{asset:{value:1,sourceRef:'baseline-original'},benchmark:{value:2,sourceRef:'index-baseline-original'}}]}]}
 const input={asset_evidence_packs:[{content_hash:'same-version',subject:{canonical_key:'market:coinmarketcap:1'},pack:{market_summary:{current_price:0,volume_24h:40,field_evidence:{current_price:price,volume_24h:volume},freshness:{mixed_observation_times:true,as_of:null}},benchmark_state:benchmark,rwa_state:{status:'error',reason:'Source read failed'},security_state:{status:'available',versions:[{id:'original',document:{exists:false,level:0}}]}}}]}
 const pack=comparisonPromptContext(input).asset_evidence_packs[0].pack
 assertEquals(pack.market_summary.field_evidence,{current_price:price,volume_24h:volume});assertEquals(pack.market_summary.freshness.mixed_observation_times,true)
 assertEquals(pack.benchmark_state,benchmark);assertEquals(pack.rwa_state.status,'error');assertEquals(pack.security_state.versions[0].document.level,0)
})
Deno.test('oversized specialist evidence is omitted explicitly, never shortened to an uncited conclusion',()=>{
 const huge={status:'available',comparisons:[{conclusion:'Retain only with citations',sourceRef:'x'.repeat(15000)}]}
 const pack=comparisonPromptContext({asset_evidence_packs:[{subject:{canonical_key:'market:coinmarketcap:1'},pack:{benchmark_state:huge}}]}).asset_evidence_packs[0].pack
 assertEquals(pack.benchmark_state,undefined);assert(pack.prompt_omitted_sections.includes('benchmark_state'))
})
Deno.test('four-asset budget includes all omission labels and withholds only values whose whole source cannot fit',()=>{
 const names=['current_price','market_cap','fdv','volume_24h','change_24h_pct','change_7d_pct'],fields=Object.fromEntries(names.map(k=>[k,{value:0,source_ref:k+'x'.repeat(1000),as_of:'2026-09-12T00:00:00Z'}]))
 const base={market_summary:{...Object.fromEntries(names.map(k=>[k,0])),field_evidence:fields},benchmark_state:{rows:['x'.repeat(15000)]},rwa_state:{status:'error'},security_state:{status:'error'}}
 const result=comparisonPromptContext({asset_evidence_packs:Array.from({length:4},(_,i)=>({content_hash:`original-${i}`,subject:{canonical_key:`market:coinmarketcap:${i+1}`},pack:base}))})
 assert(JSON.stringify(result).length<=8500);assertEquals(result.asset_evidence_packs.length,4)
 for(const item of result.asset_evidence_packs)for(const key of names){
  if(item.pack.market_summary.field_evidence[key])assertEquals(item.pack.market_summary.field_evidence[key],fields[key])
  else{assertEquals(item.pack.market_summary[key],null);assert(item.pack.prompt_omitted_sections.includes(`market_summary.field_evidence.${key}`))}
 }
})
Deno.test('busy contract history survives the comparison pipeline as whole cited metrics, not falsely missing coverage',()=>{
 const subject='eip155:1:0x'+'a'.repeat(40),rows=Array.from({length:80},(_,i)=>({id:`original-${i}`,subject,metric:i===0?'price':i<30?'holder_count':'liquidity_event_usd',unit:i>0&&i<30?'accounts':'USD',value:i===1?0:i,provider:'coinmarketcap',observedAt:'2026-09-12T00:00:00Z',recordedAt:'2026-09-12T02:00:00Z',sourceRef:`cmc-source-${i}`,metadata:{details:'d'.repeat(300)}}))
 const full={contentHash:'fc45ea0',subject:{canonical_key:subject},pack:{market_summary:{current_price:1},cmc_contract_state:{status:'available',observations:rows,attention_comparison:{observations:rows}},private_notes:'Do not include private words',private_context:{wallet:'private'}}}
 const input=comparisonEvidenceInput(full)
 assertEquals(input.pack.cmc_contract_state.observations,rows);assert(!JSON.stringify(input).includes('Do not include private words'))
 const wire=comparisonPromptContext({asset_evidence_packs:[input,{content_hash:'second',subject:{canonical_key:'market:coinmarketcap:34212'},pack:{cmc_contract_state:{status:'missing',observations:[]}}}]})
 const selected=wire.asset_evidence_packs[0].pack.cmc_contract_state
 assertEquals(selected.status,'available');assert(selected.projection_omitted_observations>0);assertEquals(selected.attention_comparison.status,'prompt_omitted')
 assert(selected.observations.some((o:any)=>o.metric==='holder_count'&&o.value===0))
 for(const o of selected.observations)assertEquals(o,rows.find(r=>r.id===o.id))
 assert(JSON.stringify(wire).length<=8500);assertEquals(full.pack.cmc_contract_state.observations.length,80)
})
Deno.test('production-sized quote metadata cannot crowd every cited holder fact out of a two-asset comparison',()=>{
 const date='2026-09-12T00:00:00.000Z',subject='eip155:1:0x'+'a'.repeat(40)
 const fields=Object.fromEntries(['current_price','market_cap','fdv','volume_24h','change_24h_pct','change_7d_pct'].map(key=>[key,{value:0,unit:'USD',provider:'coinmarketcap',as_of:date,recorded_at:date,source_ref:'fixture:'+key+':'+ 'x'.repeat(138)}]))
 const holder={id:'fixture-holder',subject,metric:'holder_count',value:0,unit:'accounts',provider:'coinmarketcap',observedAt:date,recordedAt:date,sourceRef:'fixture-cmc-holder',metadata:{intervalStart:date,intervalEnd:date,provenance:'x'.repeat(640)}}
 const quote={...holder,id:'fixture-quote',metric:'price',unit:'USD',sourceRef:'fixture-cmc-price'}
 const contract={subject,status:'available',evaluated_at:date,reason:null,coverage:{scope:'x'.repeat(170)},observations:[quote,holder,...Array.from({length:78},(_,i)=>({...holder,id:`history-${i}`}))],sources:[{metric:'holder_count',status:'available'},{metric:'price',status:'available'}]}
 const pack={market_summary:{current_price:0,market_cap:0,fdv:0,volume_24h:0,change_24h_pct:0,change_7d_pct:0,field_evidence:fields,freshness:{source_ref:'x'.repeat(300)}},derivatives_state:{status:'missing',subject,reason:'No exact asset derivatives source',coverage:{detail:'x'.repeat(580)},observations:[]},cmc_contract_state:contract}
 const input={asset_evidence_packs:[{subject:{canonical_key:subject},pack},{subject:{canonical_key:'eip155:1:0x'+'b'.repeat(40)},pack:{...pack,cmc_contract_state:{...contract,status:'missing',observations:[],reason:'No retained contract observations'}}}]}
 const result=comparisonPromptContext(input),projected=result.asset_evidence_packs[0].pack.cmc_contract_state
 assert(projected?.observations.some((o:any)=>o.id===holder.id),'A complete holder fact must survive real-sized quote metadata')
 assertEquals(projected.observations.find((o:any)=>o.id===holder.id),holder)
 assertEquals(result.asset_evidence_packs[1].pack.cmc_contract_state.status,'missing')
 assert(JSON.stringify(result).length<=8500)
})
