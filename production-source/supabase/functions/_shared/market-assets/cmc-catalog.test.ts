import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {fetchCoinmarketcapTopAssets} from './coinmarketcap-provider.ts'
const item=(id:number)=>({id,name:'Asset '+id,symbol:'T'+id,cmc_rank:id,last_updated:new Date().toISOString(),quote:{USD:{price:id,market_cap:id*100}}})
const response=(payload:any):any=>({payload,state:'fresh',reason:null,provenance:{}})
Deno.test('shared CMC catalogue batches listings and metadata and rejects partial listing failures',async()=>{
 const calls:any[]=[];const request=async(name:string,p:any,ctx:any)=>{calls.push({name,p,maxCalls:ctx.maxCalls,wait:ctx.waitForFresh});return response({data:name==='listings'?Array.from({length:p.limit},(_,i)=>item(p.start+i)):Object.fromEntries(p.id.split(',').map((id:string)=>[id,{id:Number(id),logo:'https://example.com/'+id+'.png',tags:['stablecoin']}]))})}
 const rows=await fetchCoinmarketcapTopAssets(501,{kind:'job'},request);eq(rows?.length,501);eq(calls.length,6);eq(calls.map(c=>c.maxCalls),[6,6,6,6,6,6]);eq(calls.every(c=>c.wait),true);eq(calls.filter(c=>c.name==='listings').map(c=>c.p.limit),[250,250,1]);eq(rows?.[500].imageUrl,'https://example.com/501.png')
 eq(await fetchCoinmarketcapTopAssets(501,{},async(n,p={})=>Number(p.start)>1?response(null):response({data:Array.from({length:250},(_,i)=>item(i+1))})),null)
})
Deno.test('rank reordering reuses the same sorted metadata keys and failed metadata retains quote rows',async()=>{
 const ids:string[]=[];for(const reversed of [false,true])await fetchCoinmarketcapTopAssets(3,{},async(n,p={})=>{if(n==='metadata'){ids.push(String(p.id));return response(null)}const rows=[item(3),item(1),item(2)];return response({data:reversed?rows.reverse():rows})});eq(ids,['1,2,3','1,2,3'])
})

Deno.test('catalogue membership churn reuses fresh per-asset metadata without resetting its clock',async()=>{
 const checked=new Date(Date.now()-60000).toISOString(),calls:string[]=[];const cached={provider_id:'1',image_url:'https://example.com/1.png',image_source:'coinmarketcap',image_last_checked_at:checked,categories:['defi'],platforms:{ethereum:'0x1111111111111111111111111111111111111111'}};
 const db={from:()=>({select:()=>({eq:()=>({limit:()=>({data:[cached]})})})})};
 const rows=await fetchCoinmarketcapTopAssets(1,{supabase:db},async(n)=>{calls.push(n);return response({data:[item(1)]})});eq(calls,['listings']);eq(rows?.[0].metadataFetchedAt,checked);eq(rows?.[0].imageUrl,cached.image_url);
 const failed={from:()=>({select:()=>({eq:()=>({limit:()=>({error:{message:'unavailable'}})})})})};eq(await fetchCoinmarketcapTopAssets(1,{supabase:failed},async()=>response({data:[item(1)]})),null)
})
