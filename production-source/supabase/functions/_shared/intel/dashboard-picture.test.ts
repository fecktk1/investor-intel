import {assert,assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {readDashboardPicture} from './dashboard-picture.ts'
const now=new Date('2026-09-12T22:00:00Z')
function fixture(fail=''){
 const calls:any[]=[],db={from:(table:string)=>{const call:any={table,ops:[]};calls.push(call);const q:any=new Proxy({then:(yes:any)=>Promise.resolve({data:table==='market_macro_available'?[{total_market_cap_usd:0,as_of:'2026-09-12T21:00:00Z'}]:table==='large_transfer_events'?[{usd_value:0,observed_at:'2026-09-11T21:00:00Z'}]:[],error:fail===table?Error('private detail'):null}).then(yes)},{get:(t:any,p:string)=>p==='then'?t.then:(...a:any[])=>{call.ops.push([p,...a]);return q}});return q}}
 return {db,calls}
}
Deno.test('picture requests only its three bounded sources, preserving actual zeros and separate clocks',async()=>{
 const {db,calls}=fixture(),r=await readDashboardPicture(db,'org','owner',now);eq(calls.length,3);eq(r.picture.macro_rotation.macro[0].total_market_cap_usd,0);eq(r.picture.flow_highlights[0].usd_value,0);eq(r.picture.flow_highlights[0].observed_at,'2026-09-11T21:00:00Z')
 const flow=calls.find(c=>c.table==='large_transfer_events');assert(flow.ops.some((o:any[])=>o[0]==='eq'&&o[1]==='org_id'&&o[2]==='org'));assert(flow.ops.some((o:any[])=>o[0]==='eq'&&o[1]==='user_id'&&o[2]==='owner'));eq(flow.ops.find((o:any[])=>o[0]==='limit')[1],9)
 assert(calls.every(c=>!c.table.includes('holdings')&&!c.table.includes('asset_evidence')));assert(r.timing.includes('macro;dur='))
})
Deno.test('picture failures remain named failures alongside independent available sources',async()=>{
 const {db}=fixture('large_transfer_events'),r=await readDashboardPicture(db,'org','owner',now);eq(r.picture.read_states.flows.state,'error');eq(r.picture.read_states.news.state,'empty');eq(r.picture.read_states.macro.state,'available');eq(r.picture.data_coverage.unavailable_sources,['flows']);assert(!JSON.stringify(r).includes('private detail'));await assertRejects(()=>readDashboardPicture(db,'','owner',now))
})
