import {assert,assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {createDashboardReads,dashboardSourceReads} from './dashboard-reads.ts'
Deno.test('dashboard starts independent lazy reads, bounds concurrency and releases slots after failures',async()=>{
 const q=createDashboardReads(2),started:string[]=[],release:Record<string,(v:any)=>void>={}
 const task=(name:string)=>q.read(name,()=>{started.push(name);return new Promise(r=>release[name]=r)})
 const a=task('first'),b=task('second'),c=task('third');await Promise.resolve();eq(started,['first','second'])
 release.first({data:[{zero:0}],error:null});eq((await a).data[0].zero,0);await new Promise(r=>setTimeout(r,0));eq(started,['first','second','third'])
 release.second({data:[],error:{message:'private provider detail'}});release.third({data:[],error:null});await Promise.all([b,c]);eq(q.states.second.state,'error');eq(q.states.third.state,'empty');assert(!JSON.stringify(q.states).includes('private'))
})
Deno.test('dashboard distinguishes thrown, reported and malformed reads from genuinely empty records',async()=>{
 const q=createDashboardReads();await Promise.all([q.read('throws',()=>{throw Error('secret')}),q.read('malformed',async()=>({data:null,error:null})),q.read('empty',async()=>({data:null,error:null}),'optional')]);eq(q.states.throws.state,'error');eq(q.states.malformed.state,'error');eq(q.states.empty.state,'empty');assert(q.timing().includes('throws;dur='));assert(!q.timing().includes('secret'))
})
Deno.test('dashboard reads preserve owners, scope and bounds; outages do not cause schema fallback',async()=>{
 const calls:any[]=[],db={from:(name:string)=>query(name),rpc:(name:string,args:any)=>query(name,args)}
 function query(name:string,args?:any){const call:any={name,args,ops:[]};calls.push(call);const q:any=new Proxy({then:(yes:any)=>Promise.resolve({data:name==='intel_global_news'?null:name==='intel_what_changed_context'?{items:[]}:[],error:name==='intel_global_news'?{code:'503'}:null}).then(yes)},{get:(t:any,p:string)=>p==='then'?t.then:(...a:any[])=>{call.ops.push([p,...a]);return q}});return q}
 const result=dashboardSourceReads(db,'org','owner','chain','ethereum');await Promise.all(Object.values(result.sources))
 eq(calls.length,13);eq(calls.filter(c=>c.name==='intel_global_news').length,1);eq(result.states.global_news.state,'error')
 for(const name of ['watchlist_items','intel_alert_events','research_artifacts']){const c=calls.find(c=>c.name===name);assert(c.ops.some((o:any[])=>o[0]==='eq'&&o[2]==='owner'));assert(c.ops.some((o:any[])=>o[0]==='eq'&&o[2]==='org'));assert(c.ops.some((o:any[])=>o[0]==='limit'))}
 eq(calls.find(c=>c.name==='signal_feed_v2').args.p_chains,['ethereum']);eq(calls.find(c=>c.name==='signal_feed_v2').args.p_limit,48)
})
