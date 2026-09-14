import {assertEquals} from 'jsr:@std/assert'
import {generationDecision} from './generation-governance.ts'
Deno.test('governance always supplies the selected workspace, including force and rate checks',async()=>{
 for(const name of ['intel_generation_allowed','intel_rate_check','intel_force_refresh_allowed']){
  let captured:any
  const db={rpc:async(n:string,p:any)=>{captured={n,p};return {data:{allowed:true,cap:0,used:0}}}}
  assertEquals(await generationDecision(db,name,'selected',{p_limit_key:'comparisons_per_day',p_org_id:'wrong'}),{allowed:true,cap:0,used:0})
  assertEquals(captured,{n:name,p:{p_limit_key:'comparisons_per_day',p_org_id:'selected'}})
 }
})
Deno.test('governance denies unavailable, malformed and rejected checks without retrying',async()=>{
 for(const response of [null,{data:{}},{data:{allowed:'true'}},{data:{allowed:true},error:{code:'denied'}}]){
  let calls=0;assertEquals(await generationDecision({rpc:async()=>{calls++;return response}},'gate','org'),{allowed:false,reason:'governance_unavailable'});assertEquals(calls,1)
 }
 assertEquals(await generationDecision({rpc:async()=>{throw Error('network')}},'gate','org'),{allowed:false,reason:'governance_unavailable'})
 assertEquals(await generationDecision({rpc:async()=>({data:{allowed:false,reason:'cost_cap',used:2,cap:2}})},'gate','org'),{allowed:false,reason:'cost_cap',used:2,cap:2})
})
