import { gatherCandidates } from './alert-candidates.ts'
const now = Date.now(), iso = (ms:number) => new Date(ms).toISOString()
const rule = {org_id:'org',user_id:'owner',trigger_type:'unlock',config:{window_days:7},entity:{canonical_ref_key:'eip155:1:0x123',display_symbol:'DUP',contract_address:'0x123',chain_namespace:'eip155',chain_id:'1'}}
const fact = (patch:Record<string,unknown>={}) => ({id:'version',source_id:'event',source_kind:'unlock',asset_keys:['eip155:1:0x123'],title:'DUP unlock',scheduled_at:iso(now+86400000),event_date:null,time_precision:'instant',event_status:'scheduled',source:'provider',source_ref:'release-1',observed_at:iso(now-60000),recorded_at:iso(now-30000),expires_at:iso(now+3600000),detail:{amount:0,pct_supply:0},...patch})
function db(rows:unknown[], error:unknown=null) {
 const calls:any[]=[]; const q:any={then:(resolve:any)=>Promise.resolve({data:rows,error}).then(resolve)}
 for(const name of ['select','eq','gte','lte','order','limit','or','overlaps'])q[name]=(...args:unknown[])=>{calls.push([name,...args]);return q}
 return {calls,from:(name:string)=>{calls.push(['from',name]);return q},rpc:(name:string,args:any)=>{calls.push(['rpc',name,args]);return q}}
}
function eq(a:unknown,b:unknown){if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`)}
Deno.test('unlock alerts use a canonical calendar version and preserve zero with both clocks',async()=>{
 const store=db([fact()]);const rows=await gatherCandidates(store,rule,now)
 eq(rows.length,1);eq(rows[0].value,0);eq(rows[0].payload.amount,0)
 eq(rows[0].payload.calendar_version,'version');eq(rows[0].payload.source_observed_at,iso(now-60000));eq(rows[0].payload.known_at,iso(now-30000))
 eq(store.calls.some(c=>c[0]==='or'),false)
})
Deno.test('cancelled, future-known, expired and different-network unlocks never fire',async()=>{
 for(const patch of [{event_status:'cancelled'},{recorded_at:iso(now+1)},{expires_at:iso(now-1)},{asset_keys:['eip155:8453:0x123']}])eq(await gatherCandidates(db([fact(patch)]),rule,now),[])
})
Deno.test('failed source reads are errors, successful empty reads remain empty',async()=>{
 let rejected=false;try{await gatherCandidates(db([], {message:'source offline'}),rule,now)}catch{rejected=true};eq(rejected,true)
 eq(await gatherCandidates(db([]),rule,now),[])
})
Deno.test('date-only unlock retains date precision, with no invented midnight execution time',async()=>{
 const rows=await gatherCandidates(db([fact({scheduled_at:null,event_date:iso(now+86400000).slice(0,10),time_precision:'date'})]),rule,now)
 eq(rows.length,1);eq(rows[0].payload.scheduled_at,null);eq(rows[0].payload.time_precision,'date')
})
Deno.test('wallet reads require exact chain and private owner scope',async()=>{
 const store=db([]);await gatherCandidates(store,{...rule,trigger_type:'wallet_activity',entity:{wallet_address:'0x123',chain_namespace:'eip155',chain_id:'8453'}},now)
 for(const match of [['eq','org_id','org'],['eq','user_id','owner'],['eq','chain','base']])eq(store.calls.some(c=>JSON.stringify(c)===JSON.stringify(match)),true)
})
const rejects=async(fn:()=>Promise<unknown>,message:string)=>{try{await fn()}catch(e){if(String(e).includes(message))return;throw e}throw Error('Expected '+message)}
Deno.test('wallet zero remains zero and source range is bounded by the supplied evaluation clock',async()=>{
 const store=db([{id:'zero',usd_value:0,observed_at:iso(now-1),fetched_at:iso(now)}]);const rows=await gatherCandidates(store,{...rule,trigger_type:'wallet_activity',config:{min_usd:0},entity:{wallet_address:'0x123',chain_namespace:'eip155',chain_id:'8453'}},now)
 eq(rows.length,1);eq(rows[0].value,0);eq(store.calls.some(c=>JSON.stringify(c)===JSON.stringify(['lte','observed_at',iso(now)])),true)
 await rejects(()=>gatherCandidates(db(Array(101).fill({})),{...rule,trigger_type:'wallet_activity',entity:{wallet_address:'0x123',chain_namespace:'eip155',chain_id:'8453'}},now),'history_limit')
})
Deno.test('same-symbol supply never joins another chain, provider identity, future snapshot or zero denominator',async()=>{
 const supplyRule={...rule,trigger_type:'supply_shock',entity:{...rule.entity,provider_ids:{coingecko:'dai'}},config:{threshold_pct:5}},current={id:'latest',stablecoin:'Dai',chain:'ethereum',provider:'defillama',source_ref:'same',raw_response:{id:'5',gecko_id:'dai'},ts:iso(now-60000),fetched_at:iso(now-60000),stale_after:iso(now+60000),circulating_usd:0},prior={...current,id:'prior',ts:iso(now-3600000),fetched_at:iso(now-3600000),circulating_usd:100}
 const store=db([current,prior]),rows=await gatherCandidates(store,supplyRule,now);eq(rows[0].value,-100);eq(rows[0].payload.from_usd,100);eq(rows[0].payload.to_usd,0);eq(rows[0].payload.source_observed_at,null);eq(store.calls.some(c=>c[0]==='eq'&&c[1]==='raw_response->>gecko_id'&&c[2]==='dai'),true)
 for(const patch of [{chain:'base'},{raw_response:{id:'6',gecko_id:'other'}},{fetched_at:iso(now+1)},{stale_after:iso(now-1)}])await rejects(()=>gatherCandidates(db([{...current,...patch},prior]),supplyRule,now),'incompatible_or_stale')
 await rejects(()=>gatherCandidates(db([current,{...prior,circulating_usd:0}]),supplyRule,now),'baseline_unavailable')
 await rejects(()=>gatherCandidates(db([current,prior]),{...supplyRule,entity:{display_symbol:'DAI'}},now),'identity_unavailable')
})
Deno.test('holder samples without retained population and source clocks are unavailable, never an inferred shift',async()=>{
 await rejects(()=>gatherCandidates(db([{top10_pct:10},{top10_pct:5}]),{...rule,trigger_type:'holder_shift'},now),'comparable_population')
})
Deno.test('metadata changes retain original values and both clocks, including zero severity',async()=>{
 const row={id:'drift',drift_type:'name',severity:0,occurred_at:iso(now-2000),created_at:iso(now-1000),old_value:'Original',new_value:'Later',source_provider:'coingecko'}
 const rows=await gatherCandidates(db([row]),{...rule,trigger_type:'metadata_migration'},now);eq(rows[0].value,0);eq(rows[0].payload.before,'Original');eq(rows[0].payload.known_at,row.created_at)
 await rejects(()=>gatherCandidates(db([{...row,created_at:iso(now+1)}]),{...rule,trigger_type:'metadata_migration'},now),'clock_unavailable')
})
