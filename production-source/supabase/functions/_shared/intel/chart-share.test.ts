import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {projectChartShare,resolveChartShare,chartShareService,validChartShareToken,chartSourceShareAllowed} from './chart-share-service.ts'
const id='20000000-0000-4000-8000-000000000001',id2='20000000-0000-4000-8000-000000000002',now=1789050000000
const state={schemaVersion:1,title:'Saved research',calculationVersion:'chart-1',capturedAt:now,sourceHash:'series',hash:'hash-of-private-original',barCount:1,source:{provider:'coingecko',currency:'USD'},policy:{retain:true,export:true},bars:[{t:now,c:11}],layout:{schemaVersion:1,asset:'native:bitcoin',range:{from:now-10000,to:now},studies:[],visibility:{portfolio:true},drawings:[{id,tool:'text',text:'Selected words',anchors:[{t:now,price:11}]},{id:id2,tool:'text',text:'Private omitted words',anchors:[{t:now,price:11}]}]},portfolio:{quantity:99,notes:'Never include'},user_id:'owner'}
const all=()=> 'true',actor={orgId:'org',userId:'owner'}
const productEnv=(key:string)=>['CMC_ALLOW_HISTORICAL_RETENTION','INTEL_CHART_CMC_PRODUCT_SHARING'].includes(key)?'true':undefined
Deno.test('CMC product sharing has separate permission from image or data exports',async()=>{
 const capture={...state,source:{provider:'coinmarketcap',currency:'USD'},policy:{retain:true,retainUntil:now+86400000,export:false,productShare:true}}
 eq(chartSourceShareAllowed(capture,productEnv,now),true)
 const view=await projectChartShare({snapshot:capture,audience:'org',drawingIds:[id]},productEnv,now)
 eq(view.bars,capture.bars);eq(view.retainUntil,now+86400000);eq(view.layout.drawings.length,1)
 eq(chartSourceShareAllowed({...capture,policy:{...capture.policy,productShare:false}},productEnv,now),false)
 eq(chartSourceShareAllowed({...capture,bars:null},productEnv,now),false)
 eq(chartSourceShareAllowed(capture,productEnv,now+86400000),false)
 eq(chartSourceShareAllowed(capture,k=>k==='CMC_ALLOW_HISTORICAL_RETENTION'?'true':undefined,now),false)
 await assertRejects(()=>projectChartShare({snapshot:capture,audience:'org'},productEnv,now+86400000),Error,'source_unavailable')
 const expired=await projectChartShare({snapshot:capture,audience:'owner',drawingIds:[id]},productEnv,now+86400000)
 eq(expired.bars,null);eq(expired.layout.drawings[0].text,'Selected words')
})
Deno.test('a Binance or stitched archive capture is shareable only when every part permits it',async()=>{
 const binanceEnv=(key:string)=>['INTEL_CHART_BINANCE_RETENTION','INTEL_CHART_BINANCE_EXPORT','INTEL_CHART_BINANCE_SHARING'].includes(key)?'true':undefined
 const capture={...state,source:{provider:'binance',currency:'USDT'},policy:{retain:true,retainUntil:now+86400000,export:true,productShare:false}}
 eq(chartSourceShareAllowed(capture,binanceEnv,now),true)
 eq(chartSourceShareAllowed(capture,k=>k==='INTEL_CHART_BINANCE_SHARING'?undefined:binanceEnv(k),now),false)
 eq(chartSourceShareAllowed({...capture,policy:{...capture.policy,export:false}},binanceEnv,now),false)
 const view=await projectChartShare({snapshot:capture,audience:'public',drawingIds:[id]},binanceEnv,now)
 eq(view.bars,capture.bars)
 // A stitched archive series: the whole never exported (CoinMarketCap export is
 // off), so the Binance part clears on its recorded part permission and the
 // CoinMarketCap part on product sharing. Either missing refuses the share.
 const stitched={...capture,source:{provider:'binance+coinmarketcap',currency:'USD'},policy:{...capture.policy,export:false,partExport:['binance'],productShare:true}}
 eq(chartSourceShareAllowed(stitched,binanceEnv,now),false)
 eq(chartSourceShareAllowed(stitched,k=>binanceEnv(k)??productEnv(k),now),true)
 eq(chartSourceShareAllowed({...stitched,policy:{...stitched.policy,partExport:[]}},k=>binanceEnv(k)??productEnv(k),now),false)
 await assertRejects(()=>projectChartShare({snapshot:stitched,audience:'org'},binanceEnv,now),Error,'source_unavailable')
})
Deno.test('share projection includes only selected annotations and has a separate integrity hash',async()=>{const r=await projectChartShare({snapshot:state,audience:'public',drawingIds:[id],expiresAt:'2026-09-11'},all);eq(r.layout.drawings.length,1);eq(r.layout.drawings[0].text,'Selected words');eq(r.layout.visibility,{});eq(JSON.stringify(r).includes('Private omitted'),false);eq(JSON.stringify(r).includes('Never include'),false);eq('user_id'in r,false);eq(r.hash===state.hash,false);eq(state.layout.drawings.length,2)})
Deno.test('sharing defaults omit every private drawing',async()=>{const r=await projectChartShare({snapshot:state,audience:'org',expiresAt:'2026-09-11'},all);eq(r.layout.drawings,[])})
Deno.test('current source permission revocation blocks non-owner projections even if previously permitted',async()=>{for(const audience of ['org','unlisted','public'])await assertRejects(()=>projectChartShare({snapshot:state,audience},()=>undefined),Error,'source_unavailable')})
Deno.test('owner projection omits retained prices after policy revocation without exposing omitted notes',async()=>{const r=await projectChartShare({snapshot:state,audience:'owner'},()=>undefined);eq(r.bars,null);eq(r.layout.drawings,[]);eq(r.gaps.length,1)})
Deno.test('new export permission cannot retroactively allow sharing a capture originally restricted',async()=>{await assertRejects(()=>projectChartShare({snapshot:{...state,policy:{export:false}},audience:'public'},all),Error,'source_unavailable')})
function dbMock(results:any[]){const calls:any[]=[];const query:any=new Proxy({}, {get:(_t,key)=>key==='then'?(resolve:any)=>Promise.resolve({data:results.shift(),error:null}).then(resolve):(...args:any[])=>{calls.push([key,...args]);return query}});return {calls,from:(name:string)=>{calls.push(['from',name]);return query},rpc:(name:string,args:any)=>{calls.push(['rpc',name,args]);return query}}}
Deno.test('invalid capabilities are rejected before touching the database',async()=>{for(const value of [null,'abc','A'.repeat(64),'0'.repeat(63),'https://evil.test']){eq(validChartShareToken(value),false);const db=dbMock([]);await assertRejects(()=>resolveChartShare(db,value,null,all));eq(db.calls,[])}})
Deno.test('resolver supplies only the verified viewer identity, and no client-selected organization',async()=>{const db=dbMock([{snapshot:state,audience:'org',drawingIds:[],expiresAt:'2026-09-11'}]);await resolveChartShare(db,'a'.repeat(64),'verified-user',all);eq(db.calls[0],['rpc','intel_resolve_chart_share',{p_token:'a'.repeat(64),p_viewer:'verified-user'}])})
Deno.test('unavailable resolver result returns no state',async()=>{await assertRejects(()=>resolveChartShare(dbMock([null]),'a'.repeat(64),null,all),Error,'unavailable')})
Deno.test('revoked or deleted successful-operation retries cannot reactivate a link',async()=>{for(const previous of [{revoked_at:'2026-09-10',snapshot_id:id},{revoked_at:null,snapshot_id:null},{revoked_at:null,snapshot_id:id,expires_at:'2026-09-01'}]){const db=dbMock([previous]);await assertRejects(()=>chartShareService(db,actor,{operation:'share_create',snapshotId:id,operationId:id},all,now),Error,'unavailable');eq(db.calls.some(c=>c[0]==='rpc'),false)}})
Deno.test('share management always scopes owner and organization, including list pagination',async()=>{const db=dbMock([Array.from({length:21},()=>({id}))]);const result=await chartShareService(db,actor,{operation:'share_list',snapshotId:id,page:2},all,now);eq(result.shares.length,20);eq(result.hasMore,true);eq(db.calls.filter(c=>c[0]==='eq'),[['eq','org_id','org'],['eq','user_id','owner'],['eq','snapshot_id',id]]);eq(db.calls.find(c=>c[0]==='range'),['range',40,60])})
Deno.test('create rejects forged annotation IDs, oversized expiry and source relabeling',async()=>{
 await assertRejects(()=>chartShareService(dbMock([null,{state}]),actor,{operation:'share_create',snapshotId:id,operationId:id,includeDrawingIds:['20000000-0000-4000-8000-000000000003'],expiresAt:now+86400000},all,now),Error,'annotations')
 await assertRejects(()=>chartShareService(dbMock([null]),actor,{operation:'share_create',snapshotId:id,operationId:id,expiresAt:now+31*86400000},all,now),Error,'invalid_chart_share')
 await assertRejects(()=>chartShareService(dbMock([null,{state}]),actor,{operation:'share_create',snapshotId:id,operationId:id,audience:'public',policy:{share:true},expiresAt:now+86400000},()=>undefined,now),Error,'source_unavailable')
})

Deno.test('replay sharing rechecks completed and recorded times and never projects undated drawings',async()=>{
 const original={...state,replaySeriesHash:'subset',sourceBarCount:4,bars:[{t:now-9000,closedAt:now-8000,c:10,recordedAt:now-7000},{t:now-6000,closedAt:now-5000,c:20,recordedAt:now+1},{t:now-4000,closedAt:now-3000,c:30},{t:now,closedAt:now+1,c:999999,recordedAt:now}],layout:{...state.layout,replay:{at:now,knownOnly:true}}}
 const view=await projectChartShare({snapshot:original,audience:'owner',drawingIds:[id,id2]},all,now)
 eq(view.bars,[original.bars[0]]);eq(view.layout.drawings,[]);eq(view.sourceHash,'series');eq(view.replaySeriesHash,'subset');eq(JSON.stringify(view).includes('999999'),false);eq(original.bars.length,4)
})

const live={id,token:'a'.repeat(64),snapshot_id:id,audience:'org',drawing_ids:[],expires_at:new Date(now+86400000).toISOString(),revoked_at:null,created_at:new Date(now).toISOString()}
Deno.test('a created link carries the short address a member actually hands out',async()=>{
 const db=dbMock([null,{state},live,'Ab3xZ9kQ'])
 const result=await chartShareService(db,actor,{operation:'share_create',snapshotId:id,operationId:id,audience:'org',includeDrawingIds:[id],expiresAt:now+86400000},all,now)
 eq(result.share.short_slug,'Ab3xZ9kQ')
 eq(result.share.shortUrl,'https://tcfqr.link/Ab3xZ9kQ')
 // The capability is still the token; the slug only points at it.
 eq(result.share.token,'a'.repeat(64))
 // The mint is scoped to the owner and the share it belongs to, never to a
 // destination chosen by the request.
 eq(db.calls.find(c=>c[0]==='rpc'&&c[1]==='intel_chart_share_short_link'),['rpc','intel_chart_share_short_link',{p_org:'org',p_user:'owner',p_share:id}])
})
Deno.test('a short address that cannot be minted never loses the link itself',async()=>{
 for(const answer of [null,'',{},'no slash/here','A'.repeat(40)]){
  const db=dbMock([null,{state},live,answer])
  const result=await chartShareService(db,actor,{operation:'share_create',snapshotId:id,operationId:id,audience:'org',includeDrawingIds:[],expiresAt:now+86400000},all,now)
  eq(result.share.shortUrl,null)
  eq(result.share.token,'a'.repeat(64))
 }
})
Deno.test('a retried create reuses the stored slug instead of minting a second one',async()=>{
 const db=dbMock([{...live,short_slug:'Ab3xZ9kQ'}])
 const result=await chartShareService(db,actor,{operation:'share_create',snapshotId:id,operationId:id,audience:'org',expiresAt:now+86400000},all,now)
 eq(result.share.shortUrl,'https://tcfqr.link/Ab3xZ9kQ')
 eq(db.calls.some(c=>c[0]==='rpc'),false)
})
Deno.test('the management list shows the short address of each live link',async()=>{
 const db=dbMock([[{...live,short_slug:'Ab3xZ9kQ'},{...live,id:id2,short_slug:null}]])
 const result=await chartShareService(db,actor,{operation:'share_list',snapshotId:id},all,now)
 eq(result.shares[0].shortUrl,'https://tcfqr.link/Ab3xZ9kQ')
 eq(result.shares[1].shortUrl,null)
 // Listing never mints: a read stays a read.
 eq(db.calls.some(c=>c[0]==='rpc'),false)
})
