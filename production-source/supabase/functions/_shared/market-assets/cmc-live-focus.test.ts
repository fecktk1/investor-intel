import {assertEquals as eq,assertThrows,assertNotEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {decodeCmcLive,liveObservation,liveFocusPlan,liveFocusGroups,liveFocusSubject,liveContractSubject,liveObservationSubject,liveSubscribeMessages,liveTapeKind,liveWindowSeconds,
  LIVE_ONCHAIN_CHANNELS,LIVE_TAPE_METRICS,LIVE_PERSISTED_KINDS,LIVE_STALE_MS} from './cmc-live-focus.ts'
const now=Date.parse('2026-09-15T03:00:00Z')
const market='market:coinmarketcap:1',evm='0x'+'ab'.repeat(20),base=`contract:base:${evm}`,baseChain=`eip155:8453:${evm}`
const mint='So11111111111111111111111111111111111111112',sol=`contract:solana:${mint}`,solChain=`solana:${mint}`
const subjects=[market,base,sol]
const push=(channel:string,data:any,params:any,ts:number=now)=>JSON.stringify({type:'data',channel,params,data,ts})
const swap=(patch:any={},params:any={platform_id:199,address:evm})=>push('onchain@transaction',{tx:'0xfeed',lgid:7,v:1250.5,tp:'buy',en:'Uniswap v3',t0a:evm,t1a:'0x'+'cd'.repeat(20),a0:10,a1:2,t0pu:125.05,...patch},params)
const liquidity=(patch:any={})=>push('onchain@liquidity_event',{txn:'0xbeef',lgid:3,tu:9000,tp:'add',en:'Aerodrome',t0a:evm,t1a:'0x'+'cd'.repeat(20),a0:4,a1:5,...patch},{platform_id:199,address:evm})
const agg=(patch:any={})=>push('onchain@token_agg_event',{pid:199,a:evm,ap:0.0047202,p:0.0047203,lu:2065408.09,ts:now,...patch},{platform_id:199,address:evm})
const traders=(patch:any={})=>push('onchain@unique_trader',{ut:412,ot:now-3600000,win:'1h',...patch},{platform_id:16,address:mint})

Deno.test('both lease grammars parse, and nothing else does',()=>{
  eq(liveFocusSubject(market),{kind:'market',subject:market,cryptoId:1})
  eq(liveFocusSubject(base),{kind:'contract',subject:base,platform:'base',platformId:199,chain:'eip155:8453',chainSubject:baseChain,address:evm})
  eq(liveFocusSubject(sol)?.platformId,16)
  for(const bad of [`contract:base:${evm.toUpperCase()}`,'contract:bnb:'+evm,'contract:base:0xnothex','contract:solana:0','market:coinmarketcap:0','market:coingecko:1','BTC',null,{},'contract:base:'+evm+'0'])
    eq(liveFocusSubject(bad),null,`rejected: ${String(bad)}`)
})
Deno.test('a canonical contract key becomes exactly one lease subject',()=>{
  eq(liveContractSubject(`eip155:8453:${evm}`)?.subject,base)
  eq(liveContractSubject(`eip155:8453/erc20:0x${'AB'.repeat(20)}`)?.subject,base,'checksum casing folds to one subject')
  eq(liveContractSubject(`solana:mainnet/spl:${mint}`)?.subject,sol)
  eq(liveContractSubject('eip155:56:'+evm),null,'an unverified platform is not a live subject')
  eq(liveContractSubject(market),null)
})
Deno.test('the lease grammar never becomes a second evidence namespace',()=>{
  eq(liveObservationSubject(base),baseChain,'a streamed contract event is stored where the REST DEX rows are')
  eq(liveObservationSubject(sol),solChain)
  eq(liveObservationSubject(market),market,'a market identity is already its own evidence subject')
  eq(liveObservationSubject(baseChain),null,'only the lease grammar names a lease')
  eq(liveObservationSubject('BTC'),null)
  eq(liveContractSubject(liveObservationSubject(base))?.subject,base,'the two directions are exact inverses')
})
Deno.test('the plan accepts both grammars, drops expired and unknown subjects and stays bounded at ten',()=>{
  const live=new Date(now+1000).toISOString()
  const rows=[{subject:base,viewers:4,expires_at:live},{subject:sol,viewers:9,expires_at:live},{subject:market,viewers:9,expires_at:live},
    {subject:base,viewers:4,expires_at:live},{subject:'contract:base:0xnope',viewers:99,expires_at:live},
    {subject:'contract:arbitrum:'+evm,viewers:1,expires_at:new Date(now).toISOString()},
    ...Array.from({length:10},(_,i)=>({subject:`market:coinmarketcap:${i+2}`,viewers:1,expires_at:live}))]
  const plan=liveFocusPlan(rows,now)
  eq(plan.length,10)
  eq(new Set(plan.map(r=>r.subject)).size,10,'a duplicated demand is one subscription')
  eq(plan.some(r=>r.subject==='contract:base:0xnope'),false)
  eq(plan.some(r=>r.subject==='contract:arbitrum:'+evm),false,'an expired lease holds no subscription')
  eq(plan.slice(0,3).map(r=>r.subject),[sol,market,base],'viewers first, then subject; a contract ranks like any other subject')
  const groups=liveFocusGroups(plan)
  eq(groups.market.length+groups.contract.length,10)
  eq(groups.contract.map(s=>s.subject),[sol,base])
  eq(groups.market.every(s=>s.kind==='market'),true)
})
Deno.test('subscribe frames batch market identities and address each contract channel by platform id',()=>{
  eq(liveSubscribeMessages(subjects,false),[{id:1,method:'subscribe',channel:'market@crypto_latest_price',params:{crypto_ids:[1]}}])
  const frames=liveSubscribeMessages(subjects,true)
  eq(frames.length,9,'one market frame plus four channels for each of the two contracts')
  eq(frames[0].params,{crypto_ids:[1]})
  eq(frames.slice(1,5).map(f=>f.channel),[...LIVE_ONCHAIN_CHANNELS])
  eq(frames[1].params,{platform_id:199,address:evm})
  eq(frames[5].params,{platform_id:16,address:mint})
  eq(frames[4].params,{platform_id:199,address:evm,interval:'1h'},'unique traders need the window they are counted over (probed 2026-09-15, error 2401 without it)')
  eq(frames[8].params,{platform_id:16,address:mint,interval:'1h'})
  eq(frames.every(f=>f.method==='subscribe'),true)
  eq(frames.map(f=>f.id),[1,2,3,4,5,6,7,8,9],'ids are unique within the connection')
  eq(liveSubscribeMessages([base],false),[],'contracts alone raise no subscription while the tape is off')
  eq(liveSubscribeMessages(['BTC'],true),[])
})
Deno.test('every on-chain kind decodes with its own shape',()=>{
  eq(decodeCmcLive(swap(),subjects,now),{kind:'swap',subject:base,tx:'0xfeed',side:'buy',amountUsd:1250.5,priceUsd:125.05,timestamp:now,venue:'Uniswap v3',
    logIndex:'7',excluded:false,baseAddress:evm,quoteAddress:'0x'+'cd'.repeat(20),baseQuantity:10,quoteQuantity:2})
  eq(decodeCmcLive(liquidity(),subjects,now),{kind:'liquidity',subject:base,eventType:'add',amountUsd:9000,timestamp:now,venue:'Aerodrome',transaction:'0xbeef',
    logIndex:'3',baseAddress:evm,quoteAddress:'0x'+'cd'.repeat(20),baseQuantity:4,quoteQuantity:5})
  eq(decodeCmcLive(agg(),subjects,now),{kind:'agg',subject:base,liquidityUsd:2065408.09,priceUsd:0.0047202,aggregatePriceUsd:0.0047202,timestamp:now})
  const live:any=decodeCmcLive(swap({v:undefined,vu:0.1226,t0a:'0x'+'42'.repeat(20),t1a:evm,t1pu:0.00472,t0pu:2457.9}),subjects,now)
  eq([live.kind,live.amountUsd,live.priceUsd],['swap',0.1226,0.00472],'the probed body: vu is the value and the subject token price is its own leg')
  eq(decodeCmcLive('{"id":2,"code":0,"ts":1,"msg":"PONG"}',subjects,now),{kind:'control'})
  eq(decodeCmcLive(traders(),subjects,now),{kind:'traders',subject:sol,uniqueTraders:412,window:'1h',timestamp:now,windowStart:now-3600000})
  eq(decodeCmcLive(swap({tp:'liquidate'}),subjects,now).kind,'swap')
  eq((decodeCmcLive(swap({tp:'liquidate'}),subjects,now) as any).side,'unclassified','an unknown side is reported, not guessed')
  eq((decodeCmcLive(liquidity({tp:42}),subjects,now) as any).eventType,'Unclassified')
})
Deno.test('a zero swap, a zero window and a zero trader count are values',async()=>{
  const zero=decodeCmcLive(swap({v:0}),subjects,now) as any
  eq(zero.kind,'swap');eq(zero.amountUsd,0)
  eq((await liveObservation(zero,now)).value,0)
  eq((decodeCmcLive(agg({lu:0}),subjects,now) as any).liquidityUsd,0)
  eq((await liveObservation(decodeCmcLive(traders({ut:0}),subjects,now),now)).value,0)
})
Deno.test('unreadable on-chain frames are invalid, never a silent drop',()=>{
  const bad=[swap({tx:undefined}),swap({lgid:null}),swap({v:'oops'}),swap({v:-1}),liquidity({txn:undefined}),liquidity({tu:null}),
    agg({lu:undefined}),agg({lu:-5}),traders({ut:null}),traders({ut:2.5}),traders({ut:-1}),
    swap({},{platform_id:199,address:'0xnot-an-address'}),swap({},{platform_id:56,address:evm}),
    push('onchain@transaction',{tx:'0x1',lgid:1,v:1},{platform_id:199,address:'0x'+'11'.repeat(20)})]
  for(const frame of bad)eq(decodeCmcLive(frame,subjects,now).kind,'invalid',frame.slice(0,90))
  eq(decodeCmcLive(swap({},{platform_id:199,address:evm.toUpperCase()}),subjects,now).kind,'swap','the provider may echo checksum casing')
})
Deno.test('stream clocks bound every channel the same way',()=>{
  for(const channel of ['onchain@transaction','onchain@liquidity_event','onchain@token_agg_event']){
    const body=channel==='onchain@transaction'?{tx:'0x1',lgid:1,v:5}:channel==='onchain@liquidity_event'?{txn:'0x1',lgid:1,tu:5}:{lu:5}
    eq(decodeCmcLive(push(channel,body,{platform_id:199,address:evm},now-LIVE_STALE_MS-1),subjects,now).kind,'invalid','stale')
    eq(decodeCmcLive(push(channel,body,{platform_id:199,address:evm},now+5001),subjects,now).kind,'invalid','future')
    eq(decodeCmcLive(push(channel,body,{platform_id:199,address:evm},now-LIVE_STALE_MS),subjects,now).kind!=='invalid',true)
  }
})
Deno.test('control, error and off-plan frames keep their existing meaning',()=>{
  eq(decodeCmcLive(JSON.stringify({type:'error',status:{error_code:1006}}),subjects,now),{kind:'error',code:1006,id:null,detail:null})
  eq(decodeCmcLive(JSON.stringify({type:'ack',code:0}),subjects,now),{kind:'ack',accepted:true,id:null,channel:null})
  eq(decodeCmcLive(JSON.stringify({type:'welcome'}),subjects,now),{kind:'control'})
  eq(decodeCmcLive(push('onchain@kline',{o:1},{platform_id:199,address:evm}),subjects,now),{kind:'ignored'},'an unsubscribed channel is not a tape event')
  eq(decodeCmcLive(JSON.stringify({id:2,code:0,ts:now,msg:'pong'}),subjects,now),{kind:'ignored'})
  eq(decodeCmcLive(swap(),[market],now).kind,'invalid','a contract outside the plan cannot write')
  assertThrows(()=>decodeCmcLive('x'.repeat(65537),subjects,now),Error,'live_message_too_large')
  assertThrows(()=>decodeCmcLive('{',subjects,now))
})
Deno.test('the price channel is unchanged',async()=>{
  const tick=JSON.stringify({type:'data',channel:'market@crypto_latest_price',ts:now,data:{cid:1,p:100,vu:5,mc:7}})
  eq(decodeCmcLive(tick,subjects,now),{kind:'quote',subject:market,price:100,timestamp:now,volumeUsd:5,marketCapUsd:7})
  const row=await liveObservation({subject:market,price:100,timestamp:now},now)
  eq(row.metric,'price');eq(row.unit,'USD');eq(row.sourceRef,'coinmarketcap:market@crypto_latest_price')
  eq(row.metadata,{timeMeaning:'Provider stream timestamp',transport:'shared_server_stream'})
  eq(row.periodSeconds,null)
  // Identity is computed from the same three fields as before the tape existed,
  // so a price already recorded by the released worker keeps its exact id.
  eq(row.id,(await liveObservation(decodeCmcLive(tick,subjects,now),now)).id)
})
Deno.test('observations carry the tape metrics, the source channel and the DEX evidence metadata',async()=>{
  const s=await liveObservation(decodeCmcLive(swap(),subjects,now),now+250)
  eq([s.metric,s.unit,s.value,s.provider],['swap_event_usd','USD',1250.5,'coinmarketcap'])
  eq(s.subject,baseChain,'the stream joins the REST DEX evidence under one subject')
  eq(s.sourceRef,'coinmarketcap:onchain@transaction')
  eq(s.observedAt,new Date(now).toISOString());eq(s.recordedAt,new Date(now+250).toISOString())
  eq(s.expiresAt,new Date(now+LIVE_STALE_MS).toISOString(),'every kind keeps the 20-second expiry')
  eq(s.metadata,{chain:'base',contract:evm,leaseSubject:base,timeMeaning:'Provider stream timestamp',transport:'shared_server_stream',
    eventType:'buy',venue:'Uniswap v3',transaction:'0xfeed',logIndex:'7',baseAddress:evm,quoteAddress:'0x'+'cd'.repeat(20),baseQuantity:10,quoteQuantity:2,
    basePriceUsd:125.05,excluded:false,scope:'Reported public swap; not a personal trade.'})
  const l=await liveObservation(decodeCmcLive(liquidity(),subjects,now),now)
  eq([l.metric,l.unit,l.value,l.subject],['liquidity_event_usd','USD',9000,baseChain])
  eq(l.metadata.leaseSubject,base)
  eq(l.sourceRef,'coinmarketcap:onchain@liquidity_event')
  eq(l.metadata.eventType,'add');eq(l.metadata.transaction,'0xbeef');eq(l.metadata.venue,'Aerodrome');eq(l.metadata.baseAddress,evm)
  eq(l.metadata.scope,'Reported pool liquidity activity; not a personal trade or executable order-book depth.')
  const a=await liveObservation(decodeCmcLive(agg(),subjects,now),now)
  eq([a.metric,a.unit,a.value,a.periodSeconds],['liquidity_usd','USD',2065408.09,null])
  eq(a.sourceRef,'coinmarketcap:onchain@token_agg_event');eq(a.metadata.priceUsd,0.0047202);eq(a.metadata.aggregatePriceUsd,0.0047202)
  const t=await liveObservation(decodeCmcLive(traders(),subjects,now),now)
  eq([t.metric,t.unit,t.value,t.periodSeconds],['unique_traders','accounts',412,3600])
  eq(t.subject,solChain);eq(t.metadata.chain,'solana');eq(t.metadata.contract,mint);eq(t.metadata.leaseSubject,sol)
  eq(t.sourceRef,'coinmarketcap:onchain@unique_trader')
  eq((await liveObservation(decodeCmcLive(traders({win:'13h'}),subjects,now),now)).periodSeconds,null,'an unknown window is no period, never a guess')
})
Deno.test('every observation id is stable per event and separates one event from the next',async()=>{
  const first=decodeCmcLive(swap(),subjects,now),second=decodeCmcLive(swap({lgid:8}),subjects,now)
  eq((await liveObservation(first,now)).id,(await liveObservation(first,now+9000)).id,'a re-read of one swap is one row')
  assertNotEquals((await liveObservation(first,now)).id,(await liveObservation(second,now)).id)
  eq(/^cmc:[a-f0-9]{64}$/.test((await liveObservation(first,now)).id),true)
})
Deno.test('the metric vocabulary the read path and the worker share is closed',()=>{
  eq([...LIVE_TAPE_METRICS],['swap_event_usd','liquidity_event_usd','liquidity_usd','unique_traders'])
  eq(LIVE_TAPE_METRICS.map(liveTapeKind),['swap','liquidity','agg','traders'])
  eq(liveTapeKind('price'),'quote');eq(liveTapeKind('holder_count'),null)
  eq(LIVE_PERSISTED_KINDS.sort(),['agg','liquidity','quote','swap','traders'])
  eq([liveWindowSeconds('5m'),liveWindowSeconds('24h'),liveWindowSeconds('7d'),liveWindowSeconds('nope'),liveWindowSeconds(null)],[300,86400,604800,null,null])
})

Deno.test('acknowledgements and refusals name the subscription they answer',()=>{
  const ack:any=decodeCmcLive(JSON.stringify({type:'ack',id:3,code:0,channel:'onchain@token_agg_event',params:{platform_id:199,address:evm},msg:'ok'}),subjects,now)
  eq([ack.kind,ack.accepted,ack.id,ack.channel],['ack',true,3,'onchain@token_agg_event'])
  const refused:any=decodeCmcLive(JSON.stringify({type:'error',id:4,status:{error_code:'2401',error_message:'Missing required param for channel.',error_detail:"Param 'interval' is required for channel 'onchain@unique_trader'."}}),subjects,now)
  eq([refused.kind,refused.code,refused.id],['error',2401,4])
  eq(refused.detail,"Param 'interval' is required for channel 'onchain@unique_trader'.")
  const bare:any=decodeCmcLive(JSON.stringify({type:'error',status:{error_code:1006}}),subjects,now)
  eq([bare.kind,bare.id],['error',null],'a refusal without an id names no subscription')
})
