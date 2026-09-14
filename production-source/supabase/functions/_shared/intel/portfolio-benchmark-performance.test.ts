import {assert,assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {cashflowBenchmark,withCashflowBenchmarks} from './portfolio-benchmark-performance.ts'
const start=Date.parse('2026-09-10T12:00:00Z'),day=86400000,end=start+day,mid=start+day/2,iso=(n:number)=>new Date(n).toISOString()
const obs=(at:number,value:number,index='100',id=String(at))=>({id,provider:'coinmarketcap',subject:`index:coinmarketcap:${index}`,metric:'index_level',unit:'index_points',value,observedAt:iso(at),recordedAt:iso(at+1),expiresAt:null,sourceRef:'coinmarketcap:test',aiAllowed:true,exportAllowed:false})
const period=(flows:any[]=[])=>({from:iso(start),to:iso(end),status:'estimate',startValueUsd:1000,endValueUsd:1760,weightedCapitalUsd:1250,returnPercent:20.8,flows,snapshotIds:['s1','s2']})
Deno.test('benchmark follows actual dated flows and uses the same weighted capital as the recorded book',()=>{
 const flow={id:'manual:buy',at:iso(mid),valueUsd:500,weight:.5},p=period([flow]),r=cashflowBenchmark({periods:[p]},[obs(start,100),obs(mid,110),obs(end,121)],'100',end+2)
 eq(r.status,'comparable');assert(Math.abs(r.periods[0].benchmarkEndValueUsd!-1760)<1e-9);assert(Math.abs(r.periods[0].benchmarkReturnPercent!-20.8)<1e-9);assert(Math.abs(r.periods[0].differencePercentagePoints!)<1e-9);assert(Math.abs(r.periods[0].excessChangeUsd!)<1e-9);eq(r.observations.length,3)
})
Deno.test('missing exact instants, different identity or units, and future-known evidence are gaps',()=>{
 const p=period([{id:'f',at:iso(mid),valueUsd:500,weight:.5}]),valid=[obs(start,100),obs(mid,110),obs(end,121)]
 for(const rows of [valid.filter(o=>o.observedAt!==iso(mid)),valid.map(o=>({...o,subject:'index:coinmarketcap:20'})),valid.map(o=>({...o,unit:'USD'})),valid.map(o=>({...o,recordedAt:iso(end+100)})),[obs(start+1,100),obs(mid,110),obs(end,121)]]){
  const r=cashflowBenchmark({periods:[p]},rows,'100',end+2);eq(r.status,'incomplete');eq(r.benchmarkReturnPercent,null);eq(r.periods[0].benchmarkReturnPercent,null)
 }
})
Deno.test('zero return and complete loss remain values; zero baseline and conflicting observations are invalid',()=>{
 const p={...period(),endValueUsd:1000,weightedCapitalUsd:1000,returnPercent:0}
 eq(cashflowBenchmark({periods:[p]},[obs(start,100),obs(end,100)],'100',end+2).benchmarkReturnPercent,0)
 eq(cashflowBenchmark({periods:[p]},[obs(start,100),obs(end,0)],'100',end+2).benchmarkReturnPercent,-100)
 for(const rows of [[obs(start,0),obs(end,100)],[obs(start,100),obs(start,110,'100','conflict'),obs(end,121)]])eq(cashflowBenchmark({periods:[p]},rows,'100',end+2).status,'incomplete')
})
Deno.test('withdrawals at closing time retain zero units; unsupported book periods never become a comparison',()=>{
 const p={...period([{id:'sale',at:iso(end),valueUsd:-1100,weight:0}]),endValueUsd:0,weightedCapitalUsd:1000,returnPercent:10}
 const r=cashflowBenchmark({periods:[p]},[obs(start,100),obs(end,110)],'100',end+2);eq(r.status,'comparable');assert(Math.abs(r.periods[0].benchmarkEndValueUsd)<1e-9)
 eq(cashflowBenchmark({periods:[{...p,status:'unavailable'}]},[obs(start,100),obs(end,110)],'100',end+2).status,'incomplete')
 const excessive={...p,flows:[{id:'sale',at:iso(mid),valueUsd:-2000,weight:.5}]};eq(cashflowBenchmark({periods:[excessive]},[obs(start,100),obs(mid,110),obs(end,121)],'100',end+2).status,'incomplete')
})
Deno.test('restricted observations, overflowing arithmetic and non-chronological periods cannot pass',()=>{
 const p=period(),rows=[obs(start,100),obs(end,121)]
 eq(cashflowBenchmark({periods:[p]},rows.map(o=>({...o,aiAllowed:false})),'100',end+2).status,'incomplete')
 eq(cashflowBenchmark({periods:[p]},[obs(start,1e-300),obs(end,1e300)],'100',end+2).status,'incomplete')
 eq(cashflowBenchmark({periods:[{...p,to:p.from}]},rows,'100',end+2).status,'incomplete')
 for(const malformed of [' ',[],{},true])eq(cashflowBenchmark({periods:[p]},[obs(start,100),{...obs(end,100),value:malformed as any}],'100',end+2).status,'incomplete')
})
Deno.test('bounded shared index reads preserve version parity, failure states and permission expiry without provider calls',async()=>{
 const requests:any[]=[],make=(response:any,permitted=true)=>({from(table:string){const calls:any[]=[];requests.push({table,calls});const q:any={};for(const key of ['select','eq','gte','lte','gt','order','limit'])q[key]=(...args:any[])=>{calls.push([key,...args]);return q};q.maybeSingle=async()=>({data:{config:{CMC_ALLOW_HISTORICAL_RETENTION:String(permitted),CMC_ALLOW_AI_PROCESSING:String(permitted)}}});q.then=(resolve:any)=>Promise.resolve(response).then(resolve);return q}})
 const p={version:'original-private-book',status:'estimate',periods:[{...period(),flows:[]}]},db=make({data:[{observation:obs(start,100)},{observation:obs(end,121)}]})
 const a=await withCashflowBenchmarks(db,p,end+2),b=await withCashflowBenchmarks(db,p,end+3);eq(a.version,b.version);eq(a.bookVersion,p.version);eq(a.benchmarkComparisons[0].status,'comparable');eq(a.benchmarkComparisons[1].status,'incomplete')
 for(const r of requests.filter(r=>r.table==='intel_market_observations')){assert(r.calls.some((c:any)=>c[0]==='limit'&&c[1]===501));assert(r.calls.some((c:any)=>c[0]==='gt'&&c[1]==='retain_until'));assert(r.calls.some((c:any)=>c[0]==='eq'&&c[1]==='subject'));assert(!JSON.stringify(r).includes('original-private-book'))}
 const failed=await withCashflowBenchmarks(make({error:{message:'private diagnostic'}}),p,end+2);eq(failed.benchmarkComparisons[0].status,'error');assert(!JSON.stringify(failed).includes('private diagnostic'))
 eq((await withCashflowBenchmarks(make({data:[]}),p,end+2)).benchmarkComparisons[0].status,'incomplete')
 eq((await withCashflowBenchmarks(make({data:Array(501).fill({})}),p,end+2)).benchmarkComparisons[0].reason,'source_limit_exceeded')
 eq((await withCashflowBenchmarks(make({data:[]},false),p,end+2)).benchmarkComparisons[0].status,'restricted')
 const before=requests.filter(r=>r.table==='intel_market_observations').length
 const incomplete=await withCashflowBenchmarks(make({error:'unused'}),{...p,periods:[{...period(),status:'unavailable'}]},end+2)
 eq(incomplete.benchmarkComparisons[0].periods[0].reason,'portfolio_period_unavailable');eq(requests.filter(r=>r.table==='intel_market_observations').length,before)
})
