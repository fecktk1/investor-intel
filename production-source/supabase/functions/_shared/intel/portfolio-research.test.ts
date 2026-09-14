import assert from 'node:assert/strict'
import {portfolioResearchFacts,deterministicPortfolioResearch,portfolioResearchFingerprint,validatePortfolioNarrative,portfolioResearchHolding} from './portfolio-research.ts'
import {handlePortfolioResearch} from '../../intel-portfolio/index.ts'
import {createClient} from 'npm:@supabase/supabase-js@2'
const now=Date.parse('2026-09-11T02:00:00Z')
const holding=(extra={})=>({canonical_asset_key:'eip155:8453:native',asset_symbol:'ETH',chain:'base',asset_class:'native',quantity:1,current_value:2500,current_price:2500,price_source:'coinmarketcap',last_priced_at:new Date(now-10000).toISOString(),cost_basis_usd:2400,unrealized_pnl:100,realized_pnl:50,cost_basis_status:'known',market_context:{canonicalAssetKey:'eip155:8453:native',priceProvider:'coinmarketcap'},...extra})
const snapshot=(rows=[holding()],activity:any[]=[])=>({holdings:rows,activity,observedAt:new Date(now).toISOString()})
Deno.test('portfolio research retains closed gains while current allocation excludes closed positions',()=>{
 const input=portfolioResearchFacts(snapshot([holding(),holding({canonical_asset_key:'closed',is_closed:true,quantity:0,current_value:0,realized_pnl:275})]),now)
 assert.equal(input.facts.metrics.realizedPnl,325);assert.equal(input.facts.metrics.openPositions,1);assert.equal(input.facts.metrics.closedPositions,1)
 assert.equal(input.facts.holdings[0].allocationPct,100);assert.match(deterministicPortfolioResearch(input).summary,/325\.00/)
})
Deno.test('missing prices never turn an unpriced portfolio into a zero-valued portfolio',()=>{
 const input=portfolioResearchFacts(snapshot([holding({current_value:null,current_price:null,price_source:null})]),now)
 assert.equal(input.facts.metrics.totalValue,null);assert.equal(input.facts.metrics.pricedSubtotal,0)
 assert.match(deterministicPortfolioResearch(input).summary,/total value is unavailable/)
 const closed=portfolioResearchFacts(snapshot([holding({is_closed:true,quantity:0,current_value:0})]),now)
 assert.match(deterministicPortfolioResearch(closed).summary,/No open positions/)
})
Deno.test('ticker-joined contexts cannot price an unrelated canonical holding or carry its signals',()=>{
 const r=portfolioResearchHolding(holding({price_source:'exchange_profile',market_context:{canonicalAssetKey:'eip155:1:erc20:imposter',signalDirection:'bullish'}}),now)
 assert.equal(r.currentValue,null);assert.equal(r.currentPrice,null);assert.equal(r.unrealizedPnl,null)
 assert.equal((r.marketContext as any).signalDirection,undefined);assert.equal(r.realizedPnl,50)
})
Deno.test('quote expiry and old quotes become stale without modifying accounting facts',()=>{
 const r=portfolioResearchHolding(holding({market_context:{canonicalAssetKey:'eip155:8453:native',priceExpiresAt:new Date(now-1).toISOString()}}),now)
 assert.equal(r.priceStatus,'stale');assert.equal(r.currentValue,2500);assert.equal(r.realizedPnl,50)
 assert.equal(portfolioResearchHolding(holding({last_priced_at:null}),now).priceStatus,'stale')
})
Deno.test('prompt limits disclose omitted rows but totals and fingerprints retain the full book',async()=>{
 const rows=Array.from({length:26},(_,i)=>holding({canonical_asset_key:'key:'+i,current_value:i,realized_pnl:i}))
 const input=portfolioResearchFacts(snapshot(rows),now)
 assert.equal(input.facts.holdings.length,25);assert.equal(input.facts.coverage.holdingsOmitted,1);assert.equal(input.facts.metrics.pricedSubtotal,325)
 const scope={orgId:'org',userId:'user',portfolioId:'portfolio'}
 const first=await portfolioResearchFingerprint(scope,input,'model')
 assert.equal(first,await portfolioResearchFingerprint(scope,portfolioResearchFacts(snapshot([...rows].reverse()),now),'model'))
 rows[0].realized_pnl=99
 assert.notEqual(first,await portfolioResearchFingerprint(scope,portfolioResearchFacts(snapshot(rows),now),'model'))
 assert.notEqual(first,await portfolioResearchFingerprint({...scope,userId:'other'},input,'model'))
 assert.notEqual(first,await portfolioResearchFingerprint(scope,input,'restricted'))
 const fresh=portfolioResearchFacts(snapshot([holding()]),now)
 const refreshed=portfolioResearchFacts(snapshot([holding({last_priced_at:new Date(now-5000).toISOString()})]),now)
 assert.equal(await portfolioResearchFingerprint(scope,fresh,'model'),await portfolioResearchFingerprint(scope,refreshed,'model'))
 assert.throws(()=>portfolioResearchFacts({...snapshot(),holdingsTruncated:true}),/portfolio_analysis_limit/)
})
Deno.test('activity keeps exact manual clocks, private notes, paired directions and pending status',()=>{
 const activity=[{id:'a',kind:'manual_leg',timestamp:'2026-09-10T23:50:00Z',manual_group_id:'group',manual_pair_classification:'bridge',transaction_type:'transfer_out',direction:'out',quantity:.1,notes:'My original words',status:'recorded'},
 {id:'b',kind:'grouped',timestamp:null,type:'swap',status:'pending',notes:'Waiting'}]
 const input=portfolioResearchFacts(snapshot([holding()],activity),now)
 assert.equal(input.facts.activity[0].type,'bridge');assert.equal(input.facts.activity[0].direction,'out');assert.equal(input.facts.activity[0].notes,'My original words')
 assert.equal(input.facts.activity[0].timestamp,activity[0].timestamp);assert.equal(input.facts.activity[1].timestamp,null);assert.equal(input.facts.activity[1].status,'pending')
})
Deno.test('portfolio narrative rejects schema violations and generated financial numbers',()=>{
 const valid={summary:'Exposure is concentrated.',what_changed:'Recorded activity is available.',contributors:'Ether is the largest position.',signal_exposure:'Signal coverage is limited.',risks:'Pricing is stale.',news_that_matters:'No current news was supplied.',confidence:'low'}
 assert.equal(validatePortfolioNarrative(valid).ok,true)
 for(const summary of ['$99,000 gains','A 5% gain','Full-width ９９','€ ninety',[],null])assert.equal(validatePortfolioNarrative({...valid,summary}).ok,false)
 assert.equal(validatePortfolioNarrative({...valid,confidence:'certain'}).ok,false)
 assert.equal(validatePortfolioNarrative({...valid,summary:'a'.repeat(1801)}).ok,false)
})

const org='20000000-0000-4000-8000-000000000001',user='10000000-0000-4000-8000-000000000001',id='30000000-0000-4000-8000-000000000001'
function harness(opts:any={}) {
 const calls:any[]=[]
 const db={auth:{getUser:async()=>({data:{user:opts.noUser?null:{id:user}}})},
 from(table:string){const filters:any={};const q:any={select(){return q},eq(k:string,v:any){filters[k]=v;return q},upsert(){return q},insert(){return q},then(resolve:any){resolve({data:[]})},async single(){return {data:null}},async maybeSingle(){calls.push({table,filters});if(opts.readError)return {error:{message:'secret upstream detail'}};return {data:table==='org_members'?(opts.noMember?null:{org_id:org}):filters.org_id&&filters.org_id!==org?null:{id,org_id:org,user_id:user,name:'Private name'}}}};return q},
 async rpc(name:string,args:any){calls.push({name,args});if(name==='can_access_intel')return {data:opts.noAccess?false:true};if(name==='intel_portfolio_research_facts')return opts.factsError?{error:{message:'private SQL'}}:{data:snapshot(opts.empty?[]:opts.restrictedQuote?[holding({market_context:{canonicalAssetKey:'eip155:8453:native',priceProvider:'coinmarketcap',priceAiAllowed:false}})]:undefined)};if(name==='intel_claim_portfolio_research')return {data:{state:opts.fresh?'claimed':opts.busy?'busy':'hit',artifact:opts.artifact||{structured:{summary:'Cached privately'}}}};if(name==='intel_finish_portfolio_research'&&opts.changed)return {data:false};return {data:true}}}
 return {calls,factory:()=>db,req:(body:any={orgId:org,portfolioId:id})=>new Request('http://localhost',{method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify(body)})}
}
Deno.test('portfolio cleanup awaits real PostgREST thenables without masking conflict or failure responses',async()=>{
 for(const scenario of ['conflict','database-error','transport-error']){
  const h=harness({fresh:true,empty:true}),base=h.factory();let finishes=0
  const client=createClient('http://localhost:54321','fixture-not-a-credential',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async()=>{
   finishes++
   if(scenario==='transport-error')throw new TypeError('private transport detail')
   return new Response(JSON.stringify(scenario==='database-error'?{code:'23514',message:'private SQL text'}:false),{status:scenario==='database-error'?400:200,headers:{'content-type':'application/json'}})
  }}})
  const db={...base,rpc:(name:string,args:any)=>name==='intel_finish_portfolio_research'?client.rpc(name,args):base.rpc(name,args)}
  const response=await handlePortfolioResearch(h.req(),()=>db)
  assert.equal(response.status,scenario==='conflict'?409:503)
  assert.equal(response.headers.get('access-control-allow-origin'),'*')
  assert.equal(response.headers.get('cache-control'),'private, no-store')
  assert.equal(finishes,2,'failed owned claims are actually released through the thenable')
  assert.doesNotMatch(JSON.stringify(await response.json()),/private|23514|fixture/)
 }
})
Deno.test('portfolio research verifies owner, requested workspace, membership and product access before facts or cache',async()=>{
 for(const [opts,status] of [[{noUser:true},401],[{noMember:true},404],[{noAccess:true},403],[{readError:true},503]] as const){const h=harness(opts),r=await handlePortfolioResearch(h.req(),h.factory);assert.equal(r.status,status);assert.equal(h.calls.some(c=>c.name==='intel_portfolio_research_facts'),false);assert.equal(JSON.stringify(await r.json()).includes('secret'),false)}
 const h=harness();assert.equal((await handlePortfolioResearch(h.req({orgId:'20000000-0000-4000-8000-000000000099',portfolioId:id}),h.factory)).status,404)
 assert.equal(h.calls.some(c=>c.name==='intel_claim_portfolio_research'),false)
})
Deno.test('portfolio endpoint bounds request bodies, methods and failure responses',async()=>{
 const h=harness();assert.equal((await handlePortfolioResearch(new Request('http://localhost'),h.factory)).status,405)
 assert.equal((await handlePortfolioResearch(h.req({orgId:org,portfolioId:'bad'}),h.factory)).status,400)
 assert.equal((await handlePortfolioResearch(h.req({orgId:org,portfolioId:id,note:'x'.repeat(4096)}),h.factory)).status,413)
 const f=harness({factsError:true}),r=await handlePortfolioResearch(f.req(),f.factory);assert.equal(r.status,503);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(JSON.stringify(await r.json()).includes('private SQL'),false)
})
Deno.test('private cache hits and concurrent claims do not call a model or return another owner payload',async()=>{
 for(const busy of [false,true]){const h=harness({busy}),r=await handlePortfolioResearch(h.req(),h.factory),body=await r.json();assert.equal(r.status,busy?202:200);assert.equal(body.cache,busy?'busy':'hit');const claim=h.calls.find(c=>c.name==='intel_claim_portfolio_research');assert.equal(claim.args.p_org_id,org);assert.equal(claim.args.p_user_id,user);assert.equal(claim.args.p_portfolio_id,id);assert.equal(h.calls.some(c=>c.name==='intel_finish_portfolio_research'),false)}
})
Deno.test('fresh deterministic research works without source-processing permission and does not restore invalidated evidence',async()=>{
 const flag=Deno.env.get('CMC_ALLOW_AI_PROCESSING');Deno.env.set('CMC_ALLOW_AI_PROCESSING','false')
 try {
  const h=harness({fresh:true}),r=await handlePortfolioResearch(h.req(),h.factory),body=await r.json()
  assert.equal(r.status,200);assert.equal(body.cache,'fresh');assert.equal(body.artifact.model,'deterministic');assert.match(body.artifact.structured.what_changed,/AI processing is unavailable/)
  assert.equal(h.calls.filter(c=>c.name==='intel_finish_portfolio_research').length,1)
  const c=harness({fresh:true,changed:true}),changed=await handlePortfolioResearch(c.req(),c.factory)
  assert.equal(changed.status,409);assert.match((await changed.json()).error,/evidence changed/)
  assert.equal(c.calls.some(c=>c.table==='investor_portfolio_memory'),false)
 } finally {if(flag==null)Deno.env.delete('CMC_ALLOW_AI_PROCESSING');else Deno.env.set('CMC_ALLOW_AI_PROCESSING',flag)}
})

Deno.test('cached portfolio research returns the original evidence version and observation clock verbatim',async()=>{
 const original={structured:{summary:'Original words'},observedAt:'2026-09-09T12:00:00Z',evidence:{activity:[{notes:'Original note',quantity:0}],derivatives:{value:0,observedAt:'2026-09-09T11:00:00Z'}},model:'original-model'}
 const h=harness({artifact:original}),r=await handlePortfolioResearch(h.req(),h.factory),body=await r.json()
 assert.equal(r.status,200);assert.deepEqual(body.artifact,original)
})
Deno.test('an explicitly prepared empty portfolio reading is archived without invoking a model',async()=>{
 const h=harness({fresh:true,empty:true}),r=await handlePortfolioResearch(h.req(),h.factory),body=await r.json()
 assert.equal(r.status,200);assert.equal(body.empty,true);assert.equal(body.artifact.model,'deterministic')
 assert.equal(h.calls.filter(c=>c.name==='intel_finish_portfolio_research').length,1)
 assert.equal(h.calls.some(c=>c.table==='investor_portfolio_memory'),false)
})
Deno.test('performance reads verify the owner and access, remain private and cannot invoke research or AI',async()=>{
 const h=harness(),r=await handlePortfolioResearch(h.req({orgId:org,portfolioId:id,operation:'performance'}),h.factory)
 assert.equal(r.status,503);assert.equal((await r.json()).performance.status,'error');assert.equal(r.headers.get('cache-control'),'private, no-store')
 assert.equal(h.calls.some(c=>c.name==='intel_portfolio_performance_inputs'),true)
 assert.equal(h.calls.some(c=>['intel_portfolio_research_facts','intel_claim_portfolio_research'].includes(c.name)),false)
 for(const opts of [{noUser:true},{noMember:true},{noAccess:true}]){const denied=harness(opts);await handlePortfolioResearch(denied.req({orgId:org,portfolioId:id,operation:'performance'}),denied.factory);assert.equal(denied.calls.some(c=>c.name==='intel_portfolio_performance_inputs'),false)}
})

Deno.test('successful performance operation initializes the authorized shared-source client before checking CMC policy',async()=>{
 const h=harness(),base=h.factory(),reads:string[]=[],at=Date.now()-86400000
 const snap=(offset:number)=>({id:String(offset),as_of:new Date(at+offset).toISOString(),total_value_usd:1000,holdings_summary:[{canonicalAssetKey:'native:bitcoin',quantity:1,value:1000,priceStatus:'priced'}],risk_summary:{performance:{version:1,incompleteHistory:false}}})
 const db={...base,rpc:(name:string,args:any)=>name==='intel_portfolio_performance_inputs'?Promise.resolve({data:{snapshots:[snap(0),snap(3600000)],groups:[],manual:[]}}):base.rpc(name,args)}
 const service={from(table:string){reads.push(table);const q:any={};for(const k of ['select','eq','gte','lte','gt','order','limit'])q[k]=()=>q;q.maybeSingle=async()=>({data:{config:{CMC_ALLOW_HISTORICAL_RETENTION:'true',CMC_ALLOW_AI_PROCESSING:'true'}}});q.then=(resolve:any)=>resolve({data:[]});return q}}
 const flags=['CMC_ALLOW_HISTORICAL_RETENTION','CMC_ALLOW_AI_PROCESSING'],before=flags.map(k=>Deno.env.get(k));flags.forEach(k=>Deno.env.delete(k))
 try{const r=await handlePortfolioResearch(h.req({orgId:org,portfolioId:id,operation:'performance'}),(_url:any,_key:any,config:any)=>config?db:service),body=await r.json();assert.equal(r.status,200);assert.equal(body.performance.status,'estimate');assert.equal(body.performance.benchmarkComparisons[0].status,'incomplete');assert.equal(reads.filter(t=>t==='intel_market_observations').length,2);assert.equal(h.calls.some(c=>c.name==='intel_portfolio_research_facts'),false)}
 finally{flags.forEach((k,i)=>before[i]==null?Deno.env.delete(k):Deno.env.set(k,before[i]!))}
})

Deno.test('an individual quote AI restriction wins over an enabled account policy',async()=>{
 const fetchBefore=globalThis.fetch;const networkCalls:string[]=[];globalThis.fetch=async()=>{networkCalls.push(new Error('Unexpected provider call').stack||'fetch');throw Error('Unexpected provider call in restricted-source test')}
 const flag=Deno.env.get('CMC_ALLOW_AI_PROCESSING'),key=Deno.env.get('OPENAI_API_KEY');Deno.env.set('CMC_ALLOW_AI_PROCESSING','true');Deno.env.set('OPENAI_API_KEY','fixture-not-a-credential')
 try{
  const h=harness({fresh:true,restrictedQuote:true}),r=await handlePortfolioResearch(h.req(),h.factory),body=await r.json()
  assert.equal(r.status,200);assert.equal(body.artifact.model,'deterministic');assert.match(body.artifact.structured.what_changed,/AI processing is unavailable/)
  assert.equal(h.calls.filter(c=>c.name==='intel_finish_portfolio_research').length,1)
  assert.deepEqual(networkCalls,[])
 }finally{globalThis.fetch=fetchBefore;for(const [name,value]of [['CMC_ALLOW_AI_PROCESSING',flag],['OPENAI_API_KEY',key]]){if(value==null)Deno.env.delete(name!);else Deno.env.set(name!,value)}}
})
