import assert from 'node:assert/strict'
import {cmcPriceAssets} from './cmc-price.ts'

async function withPolicy(allowed:boolean,run:()=>Promise<void>){
  const previous=Deno.env.get('CMC_ALLOW_CONTENT_CREATION')
  Deno.env.set('CMC_ALLOW_CONTENT_CREATION',String(allowed))
  try{await run()}finally{previous===undefined?Deno.env.delete('CMC_ALLOW_CONTENT_CREATION'):Deno.env.set('CMC_ALLOW_CONTENT_CREATION',previous)}
}
const response=(rows:unknown[],state='fresh')=>({payload:{data:rows},state,reason:null,provenance:{provider:'coinmarketcap',observedAt:null,fetchedAt:null,expiresAt:null,sourceUrl:''}} as any)
const row=(id:number,price=100,last_updated=new Date().toISOString())=>({id,symbol:'DO-NOT-JOIN',quote:[{id:2781,price,last_updated,percent_change_24h:2}]})

Deno.test('Content CMC restriction stops before transport or cache access',()=>withPolicy(false,async()=>{
  const result=await cmcPriceAssets(['BTC','ETH'],{supabase:{rpc:()=>{throw Error('Forbidden database call')}}},(()=>{throw Error('Forbidden provider call')}) as any)
  assert.deepEqual(result,[])
}))
Deno.test('Content CMC batches deduplicated stable identities and preserves observation time',()=>withPolicy(true,async()=>{
  const observed=new Date(Date.now()-30000).toISOString(),calls:unknown[]=[]
  const context={caller:'content-studio',supabase:{}}
  const result=await cmcPriceAssets(['BTC','ETH','BTC','SOL','XRP'],context,(async(name:any,params:any,ctx:any)=>{calls.push([name,params,ctx]);return response([row(1,100,observed),row(1027,200,observed),row(5426,3,observed),row(52,4,observed)])}) as any)
  assert.equal(calls.length,1);assert.deepEqual(calls[0],['quotes',{id:'1,1027,5426'},context])
  assert.deepEqual(result.map(r=>r.ticker),['BTC','ETH','SOL']);assert.ok(result.every(r=>r.as_of_utc===observed))
}))
Deno.test('Unknown ticker aliases never trigger first-result CMC lookup',()=>withPolicy(true,async()=>{
  let calls=0
  assert.deepEqual(await cmcPriceAssets(['DUP','__proto__','constructor'],undefined,(()=>{calls++;throw Error('No unknown identities')}) as any),[])
  assert.equal(calls,0)
}))
Deno.test('Content CMC ignores mismatched identities and malformed numerical quotes',()=>withPolicy(true,async()=>{
  const result=await cmcPriceAssets(['BTC','ETH','SOL'],undefined,(async()=>response([row(999),row(1,NaN),row(1027,-2),{...row(5426),quote:[{id:2781,price:3,percent_change_24h:Infinity,last_updated:new Date().toISOString()}]}])) as any)
  assert.equal(result.length,1);assert.equal(result[0].ticker,'SOL');assert.equal(result[0].change_24h_pct,null)
}))
Deno.test('Content CMC rejects stale, unavailable and future prices without relabeling fetch time',()=>withPolicy(true,async()=>{
  for(const state of ['stale','unavailable','refreshing','unsupported'])assert.deepEqual(await cmcPriceAssets(['BTC'],undefined,(async()=>response([row(1)],state)) as any),[])
  for(const at of ['',new Date(Date.now()-1000000).toISOString(),new Date(Date.now()+600000).toISOString()])assert.deepEqual(await cmcPriceAssets(['BTC'],undefined,(async()=>response([row(1,100,at)])) as any),[])
}))
Deno.test('Content CMC transport failure leaves other price providers available',()=>withPolicy(true,async()=>{
  assert.deepEqual(await cmcPriceAssets(['BTC'],undefined,(async()=>{throw Error('Reservation service unavailable')}) as any),[])
}))
