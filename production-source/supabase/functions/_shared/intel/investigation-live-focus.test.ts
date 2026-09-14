import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {investigationService} from './investigation-service.ts'
const actor={orgId:'10000000-0000-4000-8000-000000000001',userId:'20000000-0000-4000-8000-000000000001'},view='30000000-0000-4000-8000-000000000001'
function database(fail=false){
 const calls:any[]=[]
 return {calls,from:(name:string)=>{calls.push(['from',name]);if(name!=='provider_quota_budgets')throw Error('A release must not read price history or fetch provider data');const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>Promise.resolve({data:{config:{}},error:null})};return q},rpc:(name:string,args:any)=>{calls.push(['rpc',name,args]);return Promise.resolve({data:null,error:fail?{message:'storage failure'}:null})}}
}
Deno.test('release forwards the exact authorized view lease and skips market reads',async()=>{
 const db=database(),response=await investigationService(db,actor,{subject:'native:bitcoin',operation:'live',enabled:false,viewId:view})
 eq(db.calls.filter(c=>c[0]==='rpc'),[['rpc','intel_live_focus_touch',{p_org:actor.orgId,p_user:actor.userId,p_subject:'market:coinmarketcap:1',p_enabled:false,p_view:view}]])
 eq(response,{state:'paused',reason:null,observation:null,expiresAt:null})
})
Deno.test('old clients keep the separate legacy RPC signature',async()=>{
 const db=database();await investigationService(db,actor,{subject:'native:bitcoin',operation:'live',enabled:false})
 eq('p_view' in db.calls.find(c=>c[0]==='rpc')[2],false)
})
Deno.test('invalid view identities are rejected before demand mutation',async()=>{
 for(const viewId of ['other-tab',{},'30000000-0000-4000-8000-000000000001'.repeat(100)]){
  const db=database();await assertRejects(()=>investigationService(db,actor,{subject:'native:bitcoin',operation:'live',enabled:false,viewId}),Error,'invalid_live_focus');eq(db.calls.some(c=>c[0]==='rpc'),false)
 }
})
Deno.test('failed demand release is a failure, never a successful pause receipt',async()=>{
 await assertRejects(()=>investigationService(database(true),actor,{subject:'native:bitcoin',operation:'live',enabled:false,viewId:view}),Error,'investigation_storage_unavailable')
})
