import {assertEquals as eq,assertThrows,assertRejects,assert} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {cmcParams,cmcRows,estimateCmcCredits,cmcObservedAt} from './cmc-capabilities.ts'
import {cmcDexIdentity,validateCmcDexResponse} from './cmc-dex.ts'
import {normalizeCmcInvestigation} from '../intel/investigation-normalize.ts'
import {readContractResearch} from '../intel/contract-research.ts'
import {evidenceAt} from '../intel/investigation-evidence.ts'
const address='0x'+'a'.repeat(40),subject=`eip155:1:${address}`,at=Date.parse('2026-09-12T02:00:00Z'),stamp=new Date(at).toISOString(),expiry=new Date(at+3600000).toISOString()
Deno.test('live CMC holder numeric strings retain zero and millisecond interval clocks',async()=>{
 const params={platform:'ethereum',tokenAddress:address,limit:'30'}
 assert(validateCmcDexResponse('dexHolderCount',{data:{platformId:1,tokenAddress:address,count:'0'}},params))
 for(const count of ['',true,'NaN','9007199254740993','-1'])eq(validateCmcDexResponse('dexHolderCount',{data:{platformId:1,tokenAddress:address,count}},params),false)
 const result=await normalizeCmcInvestigation('dexHolderHistory',{data:[{platform:1,tokenAddress:address,ts:String(at-86400000),endTs:String(at-1000),holders:'0'}]},params,stamp,expiry,expiry)
 eq(result.observations.length,1);eq(result.observations[0].value,0);eq(result.observations[0].observedAt,new Date(at-1000).toISOString())
})
Deno.test('CMC expansion enforces exact contract, chain, query and pagination bounds',()=>{
 eq(cmcDexIdentity(subject)?.address,address);eq(cmcDexIdentity(`eip155:999999:${address}`),null);eq(cmcDexIdentity('WETH'),null)
 assertThrows(()=>cmcParams('dexToken',{platform:'unverified',address}));assertThrows(()=>cmcParams('dexToken',{address}));assertThrows(()=>cmcParams('dexToken',{platform:'ethereum',address,url:'https://evil.test'}));assertThrows(()=>cmcParams('dexHolderHistory',{platform:'ethereum',tokenAddress:address,limit:5000}));assertThrows(()=>cmcParams('dexLiquidityEvents',{platform:'ethereum',address,lastId:'x&url=evil'}))
 eq(cmcParams('dexHolderHistory',{platform:'ethereum',tokenAddress:address}).interval,'1d')
 eq(cmcParams('dexLiquidityEvents',{platform:'ethereum',address,lastId:'AVd6RTNPR/+MQ=='}).lastId,'AVd6RTNPR/+MQ==')
 eq(estimateCmcCredits('dexHolderHistory',cmcParams('dexHolderHistory',{platform:'ethereum',tokenAddress:address})),1)
})
Deno.test('CMC source schemas reject cross-chain and cross-contract responses and preserve zero',()=>{
 const params={platform:'ethereum',tokenAddress:address,limit:'30'}
 assert(validateCmcDexResponse('dexHolderCount',{data:{platformId:1,tokenAddress:address,count:0}},params))
 eq(validateCmcDexResponse('dexHolderCount',{data:{platformId:8453,tokenAddress:address,count:0}},params),false)
 eq(validateCmcDexResponse('dexHolderHistory',{data:[{platform:1,tokenAddress:'0x'+'b'.repeat(40)}]},params),false)
 eq(cmcObservedAt({data:{count:0},status:{timestamp:stamp}},'dexHolderCount'),null)
 eq(cmcRows('globalHistory',{data:{}}).rows,[])
 eq(cmcRows('liquidationExchanges',{data:{exchanges:[{exchange_id:270,quotes:[{convert_id:2781,total_liquidations_24h:0}]}],total_size:1}}).rows[0].quote.total_liquidations_24h,0)
})
Deno.test('Dated holder evidence retains zero and actual clocks; fetch-only updates keep evidence identity',async()=>{
 const body={data:[{platform:1,tokenAddress:address,ts:at-86400000,endTs:at-1000,holders:0}]},params={platform:'ethereum',tokenAddress:address,limit:'30'}
 const a=await normalizeCmcInvestigation('dexHolderHistory',body,params,stamp,expiry,expiry,()=>undefined),b=await normalizeCmcInvestigation('dexHolderHistory',body,params,new Date(at+5000).toISOString(),expiry,expiry,()=>undefined)
 eq(a.observations.length,1);eq(a.observations[0].value,0);eq(a.observations[0].subject,subject);eq(a.observations[0].observedAt,new Date(at-1000).toISOString());eq(a.observations[0].id,b.observations[0].id);eq(a.observations[0].exportAllowed,false)
 eq((await normalizeCmcInvestigation('dexHolderCount',{data:{platformId:1,tokenAddress:address,count:0}},params,stamp,expiry,expiry)).observations.length,0)
})
Deno.test('Liquidity events retain exact transaction legs and separate log identities without personal trades',async()=>{
 const row={t0a:address,t1a:'0x'+'b'.repeat(40),ts:at-1000,tp:'ADD',txn:'0x123',lgid:1,a0:0,a1:5,tu:0},params={platform:'ethereum',address,limit:'25'}
 const result=await normalizeCmcInvestigation('dexLiquidityEvents',{data:{lcs:[row,{...row,lgid:2}]}},params,stamp,expiry,expiry)
 eq(result.observations.length,2);eq(evidenceAt(result.observations,at).length,2);assert(result.observations[0].id!==result.observations[1].id);eq(result.observations[0].value,0);eq(result.observations[0].metadata?.baseQuantity,0);assert(String(result.observations[0].metadata?.scope).includes('not a personal trade'))
 const paged=await normalizeCmcInvestigation('dexLiquidityEvents',{data:{lcs:[row]}},{...params,lastId:'prior_cursor',limit:'2'},stamp,expiry,expiry);eq(paged.observations[0].id,result.observations[0].id)
})
Deno.test('Contract research reads are cache-only, refresh is bounded and unsupported identities do not call providers',async()=>{
 const calls:any[]=[],request=async(name:string,p:any,c:any)=>{calls.push({name,p,c});return {payload:null,state:'unavailable' as const,reason:'refresh_required',provenance:{provider:'coinmarketcap' as const,observedAt:null,fetchedAt:null,expiresAt:null,sourceUrl:''}}}
 const actor={userId:'u',orgId:'o'}
 const a=await readContractResearch({}, {canonicalKey:subject,view:'overview'},actor,request);eq(a.state,'unavailable');eq(calls.length,2);assert(calls.every(c=>c.c.kind==='render'&&c.c.maxCalls===2))
 calls.length=0;await readContractResearch({}, {canonicalKey:subject,view:'holders',refresh:true},actor,request);eq(calls.length,1);eq(calls[0].c.kind,'request');eq(calls[0].p.limit,'30')
 calls.length=0;await readContractResearch({}, {canonicalKey:subject,view:'liquidity',refresh:true,cursor:'AVd6RTNPR/+MQ=='},actor,request);eq(calls.length,1);eq(calls[0].p.lastId,'AVd6RTNPR/+MQ==')
 calls.length=0;await readContractResearch({}, {canonicalKey:subject,view:'overview',refresh:true},actor,request,true);eq(calls.length,2);assert(calls.every(c=>c.c.kind==='render'&&c.c.maxCalls===0&&!c.c.waitForFresh))
 calls.length=0;eq((await readContractResearch({}, {canonicalKey:'native:bitcoin'},actor,request)).state,'unsupported');eq(calls.length,0)
})
Deno.test('Historical context uses bounded daily counts and preserves sparse observations',()=>{
 for(const cap of ['globalHistory','cmc100History','cmc20History']){eq(cmcParams(cap).count,cap==='globalHistory'?'30':'10');assertThrows(()=>cmcParams(cap,{interval:'5m'}));assertThrows(()=>cmcParams(cap,{time_start:stamp}));eq(cmcRows(cap,{data:[]}).rows.length,0)}
 for(const cap of ['cmc100History','cmc20History'])assertThrows(()=>cmcParams(cap,{count:11}),Error,'maximum_index_observations_10')
})
Deno.test('Contract research uses the first retained recording and fails explicitly when evidence storage cannot be read',async()=>{
 let saved:any[]=[],fail=false
 const db={rpc:(_name:string,args:any)=>{saved=args.p_rows.map((o:any)=>({id:o.id,observation:{...o,recordedAt:new Date(at-1000).toISOString()}}));return Promise.resolve({error:null})},from:(table:string)=>{
  if(table!=='intel_market_observations')throw Error('no_test_settings')
  const q:any={select:()=>q,in:()=>q,gt:()=>q,limit:()=>Promise.resolve(fail?{error:Error('read failed'),data:null}:{error:null,data:saved})};return q
 }}
 const request=async():Promise<any>=>({payload:{data:[{platform:1,tokenAddress:address,ts:at-86400000,endTs:at-2000,holders:'0'}]},state:'fresh' as const,reason:null,provenance:{provider:'coinmarketcap' as const,observedAt:null,fetchedAt:stamp,expiresAt:expiry,sourceUrl:''}})
 const r=await readContractResearch(db,{canonicalKey:subject,view:'holders'},{userId:'u',orgId:'o'},request)
 eq(r.observations.length,1);eq(r.observations[0].recordedAt,new Date(at-1000).toISOString());eq(r.observations[0].value,0)
 fail=true;await assertRejects(()=>readContractResearch(db,{canonicalKey:subject,view:'holders'},{userId:'u',orgId:'o'},request),Error,'contract_evidence_storage_unavailable')
})
