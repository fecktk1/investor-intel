import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {portfolioBenchmarkExposure} from './portfolio-benchmark-exposure.ts'
import {readAssetBenchmarkEvidence} from './asset-benchmark-evidence.ts'
const holding=(id:string,value:number|null)=>({canonicalAssetKey:id,name:id,value,observedAt:'2026-09-12T03:00:00Z',priceStatus:'fresh'})
const evidence=(id:string,times=[1,2,3])=>({canonicalAssetKey:id,benchmark_state:{status:'available',comparisons:[{index:'100',rows:times.map(t=>({t,asset:{id:id+t,value:10*t,unit:'USD'},benchmark:{id:'index'+t,value:100+t,unit:'index_points'}}))}]}})
Deno.test('portfolio exposure uses one shared interval, current ledger values and names the scenario boundary',()=>{
 const r=portfolioBenchmarkExposure([holding('a',100),holding('b',200)],[evidence('a'),evidence('b',[2,3])],1000,'100')
 eq(r.from,2);eq(r.to,3);eq(r.rows.map(r=>r.movePercent),[50,50]);eq(r.rows.map(r=>r.hypotheticalMoveUsd),[50,100]);eq(r.hypotheticalMoveUsd,150);eq(r.coveredPortfolioPercent,30);eq(r.rows[0].positionObservedAt,'2026-09-12T03:00:00Z');eq(r.note.includes('not past portfolio performance'),true)
})
Deno.test('unpriced and missing source rows stay excluded, with no invented portfolio return',()=>{
 const r=portfolioBenchmarkExposure([holding('a',null),holding('b',0),holding('c',5)],[evidence('a'),evidence('b')],null,'100')
 eq(r.excluded.map(r=>r.reason),['unpriced_position','insufficient_matching_history']);eq(r.status,'partial');eq(r.hypotheticalMoveUsd,0);eq(r.coveredPortfolioPercent,null)
 const incompatible=portfolioBenchmarkExposure([holding('a',10),holding('b',20)],[evidence('a',[1,2]),evidence('b',[3,4])],30,'100');eq(incompatible.status,'insufficient_matching_times');eq(incompatible.hypotheticalMoveUsd,null)
})
Deno.test('one request shares global index reads across positions while asset reads remain exact and failures explicit',async()=>{
 const now=Date.parse('2026-09-12T04:00:00Z'),calls:any[]=[];let fail=false
 const db={from(table:string){const q:any=new Proxy({},{get:(_,method)=>method==='then'?(resolve:any)=>Promise.resolve({data:[],error:fail?{message:'offline'}:null}).then(resolve):(...args:any[])=>{calls.push([table,method,...args]);if(method==='maybeSingle')return Promise.resolve({data:{config:{CMC_ALLOW_HISTORICAL_RETENTION:'true',CMC_ALLOW_AI_PROCESSING:'true'}},error:null});return q}});return q}}
 const r=await Promise.all(['1','1027'].map(id=>readAssetBenchmarkEvidence(db,'market:coinmarketcap:'+id,now)));eq(r[0].status,'missing');eq(calls.filter(c=>c[1]==='eq'&&c[2]==='subject').length,4);eq(calls.filter(c=>c[1]==='limit').every(c=>c[2]===61),true);eq(calls.filter(c=>c[1]==='like').length,2)
 fail=true;eq((await readAssetBenchmarkEvidence(db,'market:coinmarketcap:1',now+1)).status,'error')
})
