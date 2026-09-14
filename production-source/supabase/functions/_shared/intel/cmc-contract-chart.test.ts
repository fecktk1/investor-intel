import {assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {cmcContractIdentity,legacyChartRange,loadCmcContractChart} from './cmc-contract-chart.ts'

Deno.test('legacy charts retain useful ranges while selecting CMC without a new range argument',()=>{
  for(const [interval,range]of[['1H','7D'],['4H','1M'],['1D','1M'],['1W','1Y']])assertEquals(legacyChartRange(null,interval),range)
  assertEquals(legacyChartRange('3M','1D'),'3M')
})
Deno.test('contract chart lookup preserves Base58 case and normalizes only known EVM addresses',async()=>{
  const calls:any[]=[];const db={rpc:async(name:string,args:any)=>{calls.push({name,args});return {data:[{provider_id:'825'}],error:null}}}
  assertEquals((await cmcContractIdentity(db,'base','0x11111111111111111111111111111111111111AA')).id,'825')
  await cmcContractIdentity(db,'solana','AbCdEf123')
  assertEquals(calls[0].args,{p_chain:'base',p_address:'0x11111111111111111111111111111111111111aa'})
  assertEquals(calls[1].args,{p_chain:'solana',p_address:'AbCdEf123'})
  assertEquals((await cmcContractIdentity(db,'unknown','AbCdEf123')).id,null)
  assertEquals(calls.length,2)
})
Deno.test('ambiguous, invalid and missing CMC identities cannot trigger provider requests',async()=>{
  for(const data of [[],[{provider_id:'1'},{provider_id:'2'}],[{provider_id:'ETH'}]]){
    const db={rpc:async()=>({data,error:null})}
    const identity=await cmcContractIdentity(db,'ethereum','0x1111111111111111111111111111111111111111')
    assertEquals(identity.id,null)
    const result=await loadCmcContractChart(db,'ethereum','0x1111111111111111111111111111111111111111','qa:ref','1M','1D',{},
      {identity:cmcContractIdentity,chart:async()=>{throw Error('No history query without identity')},asset:async()=>{throw Error('No quote query without identity')}} as any)
    assertEquals(result,null)
  }
})
Deno.test('CMC contract charts retain the canonical personal-event reference and market-price provenance',async()=>{
  const calls:string[]=[],ref='eip155:1/erc20:0x1111111111111111111111111111111111111111'
  const result=await loadCmcContractChart({},'ethereum',ref.split(':').at(-1)!,ref,'7D','1H',{}, {
    identity:async()=>({id:'825'}),chart:async(_db:any,id:string)=>{calls.push(id);return {candles:[{t:1,o:1,h:2,l:1,c:2}],coverage:'UTC completed candles',source:'coinmarketcap'}},
    asset:async()=>({data:{symbol:'USDT',name:'Tether',current_price:1,image_url:'https://example.com/logo.png'}})
  } as any)
  assertEquals(calls,['825']);assertEquals(result?.entity.ref,ref);assertEquals(result?.source,'coinmarketcap')
  assertEquals(result?.overview?.image_url,'https://example.com/logo.png');assertEquals(result?.coverage.includes('not a pool execution price'),true)
})
