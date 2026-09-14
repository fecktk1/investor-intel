import { assert, assertEquals } from 'jsr:@std/assert'
import { multiModelAnalyze } from '../intel-models.ts'

Deno.test('all independent narrative reads and synthesis receive the same whole member evidence', async () => {
  const member_assets = Array.from({length:8}, (_, i) => ({
    subject:{canonical_key:`market:coinmarketcap:${i+1}`,symbol:'SAME',source_provider:'coinmarketcap',provider_id:String(i+1)},
    content_hash:`member-${i}`,headlines:{market:{current_price:i,field_evidence:{current_price:{
      value:i,status:'available',unit:'USD',source_ref:`cmc:quote:${i}`,observed_at:'2026-09-12T07:00:00Z',recorded_at:'2026-09-12T07:00:01Z',
    }}}},coverage:{material_gaps:[],unavailable_sources:[],confidence_impact:'none',should_show_warning:false},
  }))
  const evidence={unrelated_market_news:'x'.repeat(20000),narrative_evidence_pack:{
    slug:'rwa',content_hash:'original-version',taxonomy:{id:'n',slug:'rwa',name:'RWA'},member_assets,
    state:{momentum_score:0,scored_at:'2026-09-12T07:00:00Z'},source_states:{narrative_state:'available'},data_coverage:{},
  }}
  const original=JSON.stringify(evidence),messages:string[]=[]
  const priorFetch=globalThis.fetch
  globalThis.fetch=async (_input,init) => {
    const body=JSON.parse(String(init?.body))
    messages.push(body.messages?.find((m:any)=>m.role==='user')?.content ?? body.contents[0].parts[0].text)
    const content=JSON.stringify({summary:'Retained narrative',retail_friendly_summary:'Retained narrative',net_signal:'neutral',confidence:'low',key_evidence:[],data_coverage:{}})
    return new Response(JSON.stringify(body.contents?{candidates:[{content:{parts:[{text:content}]}}]}:{choices:[{message:{content}}]}),{status:200,headers:{'Content-Type':'application/json'}})
  }
  try {
    const result=await multiModelAnalyze({entity:null,evidence,task:'Narrative report',baseSystem:'Research only',keys:{openai:'test',xai:'test',gemini:'test'}})
    assert(result);assertEquals(messages.length,4)
    let first=''
    for(const message of messages){
      const json=message.split('Ranked evidence package + context:\n')[1].split('\n\nTask:')[0]
      assert(json.length<=9000);const projected=JSON.parse(json)
      if(first)assertEquals(json,first);else first=json
      assertEquals(projected.narrative_evidence_pack.member_assets.map((m:any)=>m.subject),member_assets.map(m=>m.subject))
      for(let i=0;i<8;i++)assertEquals(projected.narrative_evidence_pack.member_assets[i].headlines.market.field_evidence.current_price,member_assets[i].headlines.market.field_evidence.current_price)
      assertEquals(projected.narrative_evidence_pack.content_hash,'original-version')
      assertEquals(projected.narrative_evidence_pack.state.momentum_score,0)
      assert(!json.includes('unrelated_market_news'))
    }
    assertEquals(JSON.stringify(evidence),original)
  } finally { globalThis.fetch=priorFetch }
})
