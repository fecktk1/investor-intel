import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {readNativeChainPerformance} from './chain-performance-read.ts'
Deno.test('Markets native summaries read bounded snapshots and never authorize provider refresh',async()=>{
 let limit=0;const db={from:(table:string)=>{const q:any={select:()=>q,eq:()=>q,in:()=>q,limit:(n:number)=>{limit=n;return {data:table==='market_assets'?[{provider_id:'1027',normalized_symbol:'ETH',current_price:2501,as_of:new Date().toISOString()}]:[{coingecko_id:'arbitrum',symbol:'ARB',price:.15,updated_at:new Date().toISOString()},{coingecko_id:'ethereum',symbol:'ETH',price:2500,updated_at:new Date().toISOString()}]}}};return q}}

 const result=await readNativeChainPerformance(db,async(_n,_p,ctx)=>{eq(ctx?.kind,'render');eq(ctx?.maxCalls,0);return {payload:null,state:'unavailable',reason:'cache_miss',provenance:{provider:'coinmarketcap',observedAt:null,fetchedAt:null,expiresAt:null,sourceUrl:''}}});eq(limit,100);eq(result.rows.find(r=>r.chain_id==='arbitrum')?.price,2501);eq(result.rows.find(r=>r.chain_id==='arbitrum')?.symbol,'ETH');eq(result.rows.find(r=>r.chain_id==='arbitrum')?.source,'coinmarketcap')
})
