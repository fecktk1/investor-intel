import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {resolveMarketAsset} from './market-asset-resolver.ts'
function db(rows:any[]){return {from:()=>{const filters:any={};const q:any={select:()=>q,eq:(k:string,v:string)=>{filters[k]=v;return q},limit:(n:number)=>{eq(n,2);const found=rows.filter(r=>Object.entries(filters).every(([k,v])=>r[k]===v));return {data:found.slice(0,n),count:found.length}}};return q}}}
const cg={source_provider:'coingecko',provider_id:'bitcoin',normalized_symbol:'BTC'},cmc={source_provider:'coinmarketcap',provider_id:'1',normalized_symbol:'BTC'}
Deno.test('legacy asset URLs survive the addition of an independent CMC catalogue',async()=>{eq((await resolveMarketAsset(db([cg,cmc]),'BTC')).data,cg);eq((await resolveMarketAsset(db([cg,cmc]),'BTC','coinmarketcap','1')).data,cmc);eq((await resolveMarketAsset(db([cmc]),'BTC')).data,cmc)})
Deno.test('duplicate legacy tickers still require identity and never select the first row',async()=>{const r=await resolveMarketAsset(db([cg,{...cg,provider_id:'another-bitcoin'},cmc]),'BTC');eq(r.ambiguous,true);eq(r.data,null);eq((await resolveMarketAsset(db([cg]),'BTC','coingecko')).error,'incomplete_identity')})
Deno.test('a pasted contract resolves from its own chain and address, never from the catalogue',async()=>{
 const seen:any[]=[],built={source_provider:'contract',provider_id:'solana:ADDR'}
 const build=(...args:any[])=>{seen.push(args.slice(1,3));return Promise.resolve(built as any)}
 const hit=await resolveMarketAsset(db([cg,cmc]),'','contract','solana:ADDR',undefined,build)
 eq(hit,{data:built,error:null,ambiguous:false});eq(seen,[['solana','ADDR']])
 for(const bad of ['solana:','notachain:0x1','SOLANA:0x1','bitcoin','solana:0x1 2'])eq((await resolveMarketAsset(db([]),'','contract',bad,undefined,build)).error,'invalid_provider',bad)
 eq(seen.length,1)
 eq((await resolveMarketAsset(db([]),'','contract')).error,'incomplete_identity')
})
