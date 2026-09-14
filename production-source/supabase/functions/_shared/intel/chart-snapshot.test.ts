import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {buildChartSnapshot,chartSnapshotService} from './chart-snapshot-service.ts'
import {makeChartCaptureProof,chartRetentionDeadline,chartPricesReadable} from './chart-capture-proof.ts'
import {chartSeriesResponse} from './chart-series-contract.ts'
const secret='local-snapshot-test-key-not-a-real-credential',now=1789050000000,id='20000000-0000-4000-8000-000000000001'
const drawing={id,tool:'text',anchors:[{t:now-1000,price:11}],text:'Private original reasoning'}
const layout={schemaVersion:1,asset:'native:bitcoin',range:{from:now-10000,to:now},studies:[],drawings:[drawing],visibility:{portfolio:true}}
const source=chartSeriesResponse({source:'coingecko',candles:[{t:now-1000,c:11}]},now)
const input=async()=>({title:'Chart research',layout,capture:{bars:source.candles,proof:await makeChartCaptureProof('native:bitcoin',source.candles,source.source,secret,now)}})
Deno.test('retained captures expire without discarding selected research, and a later policy cannot extend the original deadline',async()=>{
 const env=(key:string)=>key==='INTEL_CHART_COINGECKO_RETENTION'?'true':undefined
 const snapshot=await buildChartSnapshot({...await input(),includeDrawingIds:[id]},secret,env,now)
 eq(snapshot.policy.retainUntil,now+30*86400000);eq(chartPricesReadable(snapshot,env,now+29*86400000),true);eq(chartPricesReadable(snapshot,env,now+30*86400000),false)
 const cmc={...snapshot,source:{provider:'coinmarketcap'}};eq(chartRetentionDeadline(cmc,k=>k==='CMC_HISTORY_RETENTION_DAYS'?'365':undefined),snapshot.policy.retainUntil)
 const r=await chartSnapshotService(dbMock({id,state:snapshot}),{orgId:'org',userId:'owner'},{operation:'snapshot_get',id},{secret,env,now:now+31*86400000});eq(r.snapshot.state.bars,null);eq(r.snapshot.state.layout.drawings[0].text,drawing.text);eq(snapshot.bars?.length,1)
})
Deno.test('snapshot defaults exclude annotations and all ambient portfolio/journal details',async()=>{const result=await buildChartSnapshot({...await input(),portfolio:{notes:'Never share',quantity:8}},secret,()=>undefined,now);eq(result.layout.drawings,[]);eq(result.layout.visibility,{});eq(result.bars,null);eq(result.barCount,1);eq('portfolio' in result,false);eq(result.sourceHash.length,64)})
Deno.test('explicit annotation selection preserves exact words and rejects nonexistent IDs',async()=>{const result=await buildChartSnapshot({...await input(),includeDrawingIds:[id]},secret,()=>undefined,now);eq(result.layout.drawings[0].text,drawing.text);await assertRejects(async()=>buildChartSnapshot({...await input(),includeDrawingIds:['30000000-0000-4000-8000-000000000001']},secret,()=>undefined,now),Error,'annotations')})
Deno.test('retention and export come only from server policy and signed source identity',async()=>{const result=await buildChartSnapshot({...await input(),policy:{retain:true,export:true}},secret,key=>key==='INTEL_CHART_COINGECKO_RETENTION'?'true':undefined,now);eq(result.bars?.length,1);eq(result.policy.export,false);eq(result.createdAt,now)})
function dbMock(data:any){const calls:any[]=[];const query:any=new Proxy({}, {get:(_t,key)=>key==='then'?(resolve:any)=>Promise.resolve({data,error:null}).then(resolve):(...args:any[])=>{calls.push([key,...args]);return query}});return {calls,from:(name:string)=>{calls.push(['from',name]);return query},rpc:(name:string,args:any)=>{calls.push(['rpc',name,args]);return query}}}
const actor={orgId:'org',userId:'owner'},options={secret,env:()=>undefined,now}
Deno.test('CMC captures use the server review deadline and cannot acquire file export from client policy',async()=>{
 const cmc=chartSeriesResponse({source:'coinmarketcap',candles:[{t:now-1000,c:11}]},now)
 const data={title:'CMC research',layout,capture:{bars:cmc.candles,proof:await makeChartCaptureProof('native:bitcoin',cmc.candles,cmc.source,secret,now)},policy:{export:true,retainUntil:now+365*86400000}}
 const env=(key:string)=>['CMC_ALLOW_HISTORICAL_RETENTION','INTEL_CHART_CMC_PRODUCT_SHARING'].includes(key)?'true':key==='CMC_SOURCE_POLICY_EXPIRES_AT'?new Date(now+86400000).toISOString():undefined
 const capture=await buildChartSnapshot(data,secret,env,now)
 eq(capture.policy,{retain:true,export:false,retainUntil:now+86400000,productShare:true});eq(capture.bars?.length,1)
 const result=await chartSnapshotService(dbMock({id,state:capture}),actor,{operation:'snapshot_get',id},{secret,env,now})
 eq(result.snapshot.availability.prices,true);eq(result.snapshot.availability.export,false)
 await assertRejects(()=>chartSnapshotService(dbMock({id,state:capture}),actor,{operation:'snapshot_export',id},{secret,env,now}),Error,'export_unavailable')
 const expired=await buildChartSnapshot(data,secret,k=>k==='CMC_SOURCE_POLICY_EXPIRES_AT'?new Date(now).toISOString():env(k),now)
 eq(expired.bars,null);eq(expired.policy.retain,false)
})
Deno.test('successful save retries survive proof expiry without re-saving altered input',async()=>{const db=dbMock({snapshot_id:id});eq(await chartSnapshotService(db,actor,{operation:'snapshot_save',operationId:id,capture:'expired',userId:'spoofed'},options),{id});eq(db.calls.some(c=>c[0]==='rpc'),false);eq(db.calls.some(c=>c[0]==='eq'&&c[1]==='user_id'&&c[2]==='owner'),true)})
Deno.test('deleted snapshot retries cannot revive private content',async()=>{await assertRejects(()=>chartSnapshotService(dbMock({snapshot_id:null}),actor,{operation:'snapshot_save',operationId:id},options),Error,'deleted')})
Deno.test('revoked export permission overrides the immutable capture-time policy',async()=>{const db=dbMock({id,state:{source:{provider:'coingecko'},bars:[{t:now,c:11}],policy:{export:true}}});await assertRejects(()=>chartSnapshotService(db,actor,{operation:'snapshot_export',id},options),Error,'export_unavailable')})
Deno.test('revoked retention removes raw observations from owner reads without mutating stored evidence',async()=>{const original={id,state:{hash:'original',source:{provider:'coingecko'},bars:[{t:now,c:11}],policy:{retain:true}}};const r=await chartSnapshotService(dbMock(original),actor,{operation:'snapshot_get',id},options);eq(r.snapshot.state.bars,null);eq(r.snapshot.state.hash,'original');eq(r.snapshot.viewRestrictions.length,1);eq(original.state.bars.length,1)})
Deno.test('a single-asset capture cannot certify an entire comparison snapshot',async()=>{await assertRejects(async()=>buildChartSnapshot({...await input(),layout:{...layout,comparison:{assets:[{asset:'native:bitcoin',label:'BTC'},{asset:'native:ethereum',label:'ETH'}]}}},secret,()=>undefined,now),Error,'invalid_snapshot_comparison_capture')})

Deno.test('saved replay verifies the entire signed capture but retains only eligible completed candles',async()=>{
 const bars=[0,1,2].map(i=>({t:now-6000+i*2000,closedAt:now-4001+i*2000,recordedAt:i===0?now-4000:now,o:10,h:12,l:9,c:11+i/10,v:100}))
 const proof=await makeChartCaptureProof(layout.asset,bars,source.source,secret,now),replay={at:now-2000,knownOnly:false},env=(key:string)=>key==='INTEL_CHART_COINGECKO_RETENTION'?'true':undefined
 const request={title:'Retrospective checkpoint',layout:{...layout,replay},capture:{bars,proof}}
 const historical=await buildChartSnapshot(request,secret,env,now);eq(historical.bars?.length,2);eq(historical.layout.drawings,[]);eq(historical.barCount,2);eq(historical.sourceBarCount,3);eq(historical.sourceHash,proof.hash);eq(historical.replaySeriesHash?.length,64);eq(historical.createdAt,now)
 const recorded=await buildChartSnapshot({...request,layout:{...layout,replay:{...replay,knownOnly:true}}},secret,env,now);eq(recorded.bars?.length,1);eq(recorded.bars?.[0].t,bars[0].t);eq(recorded.gaps.some((s:string)=>s.includes('saved later')),true)
 await assertRejects(()=>buildChartSnapshot({...request,includeDrawingIds:[id]},secret,env,now),Error,'invalid_replay_snapshot_annotations')
 await assertRejects(()=>buildChartSnapshot({...request,layout:{...layout,replay:{at:now+1,knownOnly:false}}},secret,env,now),Error,'invalid_chart_replay')
 await assertRejects(()=>buildChartSnapshot({...request,capture:{proof,bars:bars.slice(0,2)}},secret,env,now),Error,'series_changed')
})
Deno.test('recorded-only replay with no then-recorded data remains an honest empty checkpoint',async()=>{
 const data=await input(),result=await buildChartSnapshot({...data,layout:{...layout,replay:{at:now-500,knownOnly:true}}},secret,key=>key==='INTEL_CHART_COINGECKO_RETENTION'?'true':undefined,now)
 eq(result.bars,[]);eq(result.barCount,0);eq(result.gaps.some((g:string)=>g.includes('No eligible')),true);eq(result.layout.drawings,[])
})
