import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {readInvestigationHistory,investigationService} from './investigation-service.ts'
function database(){const calls:any[]=[];const query:any=new Proxy({}, {get:(_t,key)=>key==='then'?(resolve:any)=>Promise.resolve({data:[],error:null}).then(resolve):(...args:any[])=>{calls.push([key,...args]);return query}});return {calls,from:(name:string)=>{calls.push(['from',name]);return query}}}
Deno.test('historical CMC reads fail closed on policy revocation without removing independent provider history',async()=>{
 const now=Date.now(),db=database();await readInvestigationHistory(db,['market:coinmarketcap:1'],{from:now-86400000,to:now,limit:20},now)
 eq(db.calls.find(c=>c[0]==='neq'),['neq','provider','coinmarketcap']);eq(db.calls.find(c=>c[0]==='limit'),['limit',21])
 const enabled=database();await readInvestigationHistory(enabled,['market:coinmarketcap:1'],{from:now-86400000,to:now,limit:20},now,true)
 eq(enabled.calls.some(c=>c[0]==='neq'),false)
})
Deno.test('revoked cohort policy rejects an old saved cohort before reading membership or fetching quotes',async()=>{
 const db=database();const result=await investigationService(db,{orgId:'org',userId:'owner'},{operation:'cohort',lens:'cohort',subject:'native:bitcoin',cohortId:'20000000-0000-4000-8000-000000000001'})
 if(!('state' in result))throw new Error('Expected an explicit policy state')
 eq(result.state,'unsupported');eq(db.calls.some(c=>c[0]==='from'&&c[1]==='intel_market_cohorts'),false)
})
