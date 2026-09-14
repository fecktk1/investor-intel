import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {chartLinkPreview} from './chart-link-preview.ts'
const token='a'.repeat(64),now=Date.parse('2026-09-11T08:00:00Z'),snapshot={capturedAt:now,source:{provider:'coinmarketcap'},policy:{retain:true,productShare:true,export:false,retainUntil:now+10000},bars:[{t:now,c:77777}],title:'Private title',portfolio:{notes:'private'}}
const env=(k:string)=>['INTEL_CHART_CMC_PRODUCT_SHARING','CMC_ALLOW_HISTORICAL_RETENTION'].includes(k)?'true':undefined
Deno.test('crawler preview permits only public or unlisted links and contains no research data',async()=>{
 for(const audience of ['public','unlisted']){const calls:any[]=[];const db={rpc:async(...a:any[])=>{calls.push(a);return {data:{audience,snapshot}}}};const r=await chartLinkPreview(db,token,env,now);eq(r,{preview:{version:1,available:true,kind:'brand',audience}});eq(calls,[['intel_resolve_chart_share',{p_token:token,p_viewer:null}]]);eq(JSON.stringify(r).includes('77777'),false)}
})
Deno.test('crawler preview denies private, revoked, expired-source and malformed capabilities',async()=>{
 for(const data of [null,{audience:'owner',snapshot},{audience:'org',snapshot},{audience:'public',snapshot:{...snapshot,policy:{...snapshot.policy,retainUntil:now-1}}}])await assertRejects(()=>chartLinkPreview({rpc:async()=>({data})},token,env,now),Error,'unavailable')
 await assertRejects(()=>chartLinkPreview({rpc:()=>{throw Error('must not query')}},'<script>',env,now),Error,'chart_share_unavailable')
 await assertRejects(()=>chartLinkPreview({rpc:async()=>({data:{audience:'public',snapshot}})},token,()=>undefined,now),Error,'unavailable')
})
Deno.test('crawler preview preserves outages without exposing database messages',async()=>{await assertRejects(()=>chartLinkPreview({rpc:async()=>({error:{message:'secret'}})},token,env,now),Error,'chart_share_storage_unavailable')})
