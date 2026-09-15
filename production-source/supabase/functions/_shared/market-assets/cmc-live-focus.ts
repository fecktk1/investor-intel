import {digest,finite,instant,stableJson,type Observation} from '../intel/investigation-evidence.ts'
import {cmcHistoryPolicy,cmcSubject} from '../intel/investigation-normalize.ts'
import {CMC_DEX_NETWORKS,cmcDexAddress,cmcDexIdentity} from './cmc-dex.ts'
export const LIVE_WINDOW_MS=20000,LIVE_MESSAGE_LIMIT=200,LIVE_STALE_MS=20000
export const LIVE_MARKET_CHANNEL='market@crypto_latest_price'
/** Documented CoinMarketCap on-chain stream channels used by the live tape.
 * https://coinmarketcap.com/api/documentation/pro-api-websocket/overview
 * The stream endpoint is wss://pro-stream.coinmarketcap.com/v1 and the client
 * protocol is `{id, method, channel, params}` with `subscribe`, `unsubscribe`,
 * `unsubscribe_all` and `ping`; the server answers `welcome`, `ack`, `data`,
 * `error` and `pong`, and every `data` push carries `{channel, params, data, ts}`
 * with `ts` in epoch milliseconds. On-chain channels are addressed by the
 * numeric `platform_id` plus the token `address`, not by the platform slug. */
export const LIVE_ONCHAIN_CHANNELS=['onchain@transaction','onchain@liquidity_event','onchain@token_agg_event','onchain@unique_trader'] as const
export const MARKET_SUBJECT=/^market:coinmarketcap:[1-9][0-9]{0,11}$/
/** One grammar, restated identically by the table CHECK and by
 * intel_live_focus_touch. EVM addresses are lowercased at every boundary so one
 * contract is exactly one subject and one shared subscription. */
export const CONTRACT_SUBJECT=/^contract:([a-z][a-z0-9]{1,31}):(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/
export type LiveSubject=
  {kind:'market';subject:string;cryptoId:number}|
  {kind:'contract';subject:string;platform:string;platformId:number;chain:string;chainSubject:string;address:string}
/** The single reader for both grammars. An unknown platform, a checksum-cased
 * EVM address or a malformed mint is not a subject: it never reaches a lease,
 * a subscription or an observation. */
export function liveFocusSubject(value:unknown):LiveSubject|null {
  if(typeof value!=='string'||value.length>240)return null
  if(MARKET_SUBJECT.test(value))return {kind:'market',subject:value,cryptoId:Number(value.slice(value.lastIndexOf(':')+1))}
  const match=CONTRACT_SUBJECT.exec(value);if(!match)return null
  const network=CMC_DEX_NETWORKS.find(n=>n.platform===match[1])
  if(!network||!cmcDexAddress(match[2],network.platform))return null
  return {kind:'contract',subject:value,platform:network.platform,platformId:network.platformId,chain:network.chain,chainSubject:`${network.chain}:${match[2]}`,address:match[2]}
}
/** `eip155:8453:0x…` / `solana:<mint>` (the canonical key the REST DEX evidence
 * uses) into the live-tape grammar, so a page holding one identity can lease. */
export function liveContractSubject(value:unknown):LiveSubject|null {
  const identity=cmcDexIdentity(value)
  return identity?liveFocusSubject(`contract:${identity.platform}:${identity.address}`):null
}
/** The inverse, for the write and read paths. A streamed contract event is
 * stored under the same subject the REST DEX evidence uses, so one contract has
 * exactly one evidence namespace; only the lease speaks the `contract:` grammar. */
export function liveObservationSubject(value:unknown):string|null {
  const focus=liveFocusSubject(value)
  return focus?focus.kind==='contract'?focus.chainSubject:focus.subject:null
}
export function liveFocusPlan(rows:{subject:string;viewers:number;expires_at:string}[],now:number) {
  return [...new Map(rows.filter(r=>liveFocusSubject(r.subject)!=null&&(instant(r.expires_at)??0)>now).map(r=>[r.subject,r])).values()]
    .sort((a,b)=>b.viewers-a.viewers||a.subject.localeCompare(b.subject)).slice(0,10)
}
/** The plan is one ordered list; the transport needs it split, because market
 * identities share a single subscription and contracts do not. */
export function liveFocusGroups(subjects:(string|{subject:string})[]) {
  const market:Extract<LiveSubject,{kind:'market'}>[]=[],contract:Extract<LiveSubject,{kind:'contract'}>[]=[]
  for(const row of subjects){
    const parsed=liveFocusSubject(typeof row==='string'?row:row?.subject)
    if(parsed?.kind==='market')market.push(parsed);else if(parsed?.kind==='contract')contract.push(parsed)
  }
  return {market,contract}
}
/** Subscribe frames, exactly the documented client shape. Market identities
 * batch into one `crypto_ids` subscription; each contract takes one frame per
 * on-chain channel. UNVERIFIED until probed after G2: the `params` key spelling
 * (`platform_id`) and whether several addresses may share one on-chain frame. */
export function liveSubscribeMessages(subjects:(string|{subject:string})[],onchainEnabled=false) {
  const {market,contract}=liveFocusGroups(subjects)
  const frames:{id:number;method:'subscribe';channel:string;params:Record<string,unknown>}[]=[]
  if(market.length)frames.push({id:1,method:'subscribe',channel:LIVE_MARKET_CHANNEL,params:{crypto_ids:market.map(s=>s.cryptoId)}})
  if(onchainEnabled)for(const s of contract)for(const channel of LIVE_ONCHAIN_CHANNELS)
    frames.push({id:frames.length+1,method:'subscribe',channel,params:{platform_id:s.platformId,address:s.address}})
  return frames
}
const WINDOW_SECONDS:Record<string,number>={'1m':60,'5m':300,'15m':900,'30m':1800,'1h':3600,'4h':14400,'12h':43200,'24h':86400,'7d':604800}
export const liveWindowSeconds=(window:unknown)=>typeof window==='string'&&Object.hasOwn(WINDOW_SECONDS,window)?WINDOW_SECONDS[window]:null
const integer=(value:unknown)=>{const n=finite(value);return n!=null&&Number.isInteger(n)&&n>=0?n:null}
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max?value:null
const fresh=(timestamp:number|null,now:number)=>timestamp!=null&&timestamp<=now+5000&&now-timestamp<=LIVE_STALE_MS
/** Identity comes from the echoed subscription parameters first: the provider
 * repeats what we asked for, so a mislabelled body cannot retarget a lease. */
function onchainSubject(message:any,subjects:string[]) {
  const params=message?.params??{},data=message?.data??{}
  const network=CMC_DEX_NETWORKS.find(n=>n.platformId===finite(params.platform_id??params.platformId??data.pid))
  const raw=params.address??data.a??data.addr??data.tokenAddress
  if(!network||typeof raw!=='string')return null
  const address=network.platform==='solana'?raw:raw.toLowerCase()
  if(!cmcDexAddress(address,network.platform))return null
  const subject=`contract:${network.platform}:${address}`
  return subjects.includes(subject)?subject:null
}
/** Provider field abbreviations mirror the REST DEX responses this repository
 * already validates (`/v1/dex/tokens/transactions`, `/v1/dex/liquidity-change/list`):
 * `tx`/`txn` transaction hash, `lgid` log index, `tp` type, `en` venue,
 * `t0a`/`t1a` token addresses, `a0`/`a1` quantities, `v`/`tu` USD value,
 * `t0pu` base leg price, `ex` provider exclusion. UNVERIFIED for the streamed
 * bodies of `onchain@token_agg_event` (`vu`, `tc`, `win`) and
 * `onchain@unique_trader` (`ut`, `ot`): the overview page names the channels and
 * these fields but does not publish a full body, so a zero-credit probe after
 * G2 confirms them. An unreadable frame is `invalid` and still counted. */
export type LiveTapeEvent={kind:'invalid'}|
  {kind:'swap';subject:string;tx:string;side:string;amountUsd:number;priceUsd:number|null;timestamp:number;venue:string|null;logIndex:string|null;excluded:boolean;
   baseAddress:string|null;quoteAddress:string|null;baseQuantity:number|null;quoteQuantity:number|null}|
  {kind:'liquidity';subject:string;eventType:string;amountUsd:number;timestamp:number;venue:string|null;transaction:string;logIndex:string|null;
   baseAddress:string|null;quoteAddress:string|null;baseQuantity:number|null;quoteQuantity:number|null}|
  {kind:'agg';subject:string;window:string|null;volumeUsd:number;txCount:number|null;timestamp:number}|
  {kind:'traders';subject:string;uniqueTraders:number;window:string|null;timestamp:number;windowStart:number|null}
function decodeOnchain(channel:string,message:any,subjects:string[],now:number):LiveTapeEvent {
  const subject=onchainSubject(message,subjects),d=message?.data??{},timestamp=finite(message?.ts)??finite(d.ts)
  if(!subject||!fresh(timestamp,now))return {kind:'invalid'}
  const venue=text(d.en,120),logIndex=d.lgid==null?null:String(d.lgid)
  const legs={baseAddress:text(d.t0a,120),quoteAddress:text(d.t1a,120),baseQuantity:finite(d.a0),quoteQuantity:finite(d.a1)}
  if(channel==='onchain@transaction'){
    const tx=text(d.tx??d.txn,200),amountUsd=finite(d.v),side=d.tp==='buy'||d.tp==='sell'?d.tp:'unclassified'
    if(!tx||logIndex==null||amountUsd==null||amountUsd<0)return {kind:'invalid'}
    return {kind:'swap',subject,tx,side,amountUsd,priceUsd:finite(d.t0pu),timestamp:timestamp!,venue,logIndex,excluded:d.ex===true,...legs}
  }
  if(channel==='onchain@liquidity_event'){
    const transaction=text(d.txn??d.tx,200),amountUsd=finite(d.tu??d.v)
    if(!transaction||logIndex==null||amountUsd==null||amountUsd<0)return {kind:'invalid'}
    return {kind:'liquidity',subject,eventType:text(d.tp,64)??'Unclassified',amountUsd,timestamp:timestamp!,venue,transaction,logIndex,...legs}
  }
  if(channel==='onchain@token_agg_event'){
    const volumeUsd=finite(d.vu),txCount=integer(d.tc??d.txc)
    if(volumeUsd==null||volumeUsd<0)return {kind:'invalid'}
    return {kind:'agg',subject,window:text(d.win,16),volumeUsd,txCount,timestamp:timestamp!}
  }
  const uniqueTraders=integer(d.ut)
  if(uniqueTraders==null)return {kind:'invalid'}
  return {kind:'traders',subject,uniqueTraders,window:text(d.win,16),timestamp:timestamp!,windowStart:integer(d.ot)}
}
export function decodeCmcLive(raw:string,subjects:string[],now:number) {
  if(raw.length>65536)throw new Error('live_message_too_large')
  const message=JSON.parse(raw)
  if(message.type==='error')return {kind:'error',code:Number(message.status?.error_code)||null}
  if(message.type==='ack')return {kind:'ack',accepted:Number(message.code)===0}
  if(message.type==='pong'||message.type==='welcome')return {kind:'control'}
  if(message.type!=='data')return {kind:'ignored'}
  if(LIVE_ONCHAIN_CHANNELS.includes(message.channel))return decodeOnchain(message.channel,message,subjects,now)
  if(message.channel!==LIVE_MARKET_CHANNEL)return {kind:'ignored'}
  const subject=cmcSubject(message.data?.cid),price=finite(message.data?.p),timestamp=finite(message.ts)
  if(!subject||!subjects.includes(subject)||price==null||price<=0||timestamp==null||timestamp>now+5000||now-timestamp>LIVE_STALE_MS)return {kind:'invalid'}
  return {kind:'quote',subject,price,timestamp,volumeUsd:finite(message.data.vu),marketCapUsd:finite(message.data.mc)}
}
export const LIVE_TAPE_METRICS=['swap_event_usd','liquidity_event_usd','swap_volume_usd','unique_traders'] as const
const LIVE_METRICS={
  quote:{metric:'price',unit:'USD',channel:LIVE_MARKET_CHANNEL},
  swap:{metric:'swap_event_usd',unit:'USD',channel:'onchain@transaction'},
  liquidity:{metric:'liquidity_event_usd',unit:'USD',channel:'onchain@liquidity_event'},
  agg:{metric:'swap_volume_usd',unit:'USD',channel:'onchain@token_agg_event'},
  traders:{metric:'unique_traders',unit:'accounts',channel:'onchain@unique_trader'},
} as const
export const LIVE_PERSISTED_KINDS=Object.keys(LIVE_METRICS) as (keyof typeof LIVE_METRICS)[]
export const liveTapeKind=(metric:unknown)=>(Object.entries(LIVE_METRICS).find(([,spec])=>spec.metric===metric)?.[0]??null) as keyof typeof LIVE_METRICS|null
/** One observation writer for every channel. A zero swap, a zero window volume
 * and a zero trader count are values and are stored as zeros. */
export async function liveObservation(event:any,recordedAt:number):Promise<Observation&{retainUntil:string}> {
  const kind=(event?.kind??'quote') as keyof typeof LIVE_METRICS,spec=LIVE_METRICS[kind]
  if(!spec)throw new Error('unsupported_live_event')
  const policy=cmcHistoryPolicy(recordedAt,new Date(recordedAt+60000).toISOString())
  const sourceRef=`coinmarketcap:${spec.channel}`
  // Quote identity is unchanged, so an already-recorded price keeps its id.
  const payload=kind==='quote'?{subject:event.subject,price:event.price,timestamp:event.timestamp}:{...event}
  const id=`cmc:${await digest(stableJson({...payload,sourceRef}))}`
  const identity=liveFocusSubject(event.subject)
  // One contract, one evidence subject: the stream joins the REST DEX rows.
  const subject=identity?.kind==='contract'?identity.chainSubject:event.subject
  const place=identity?.kind==='contract'?{chain:identity.platform,contract:identity.address,leaseSubject:identity.subject}:{}
  const clock={timeMeaning:'Provider stream timestamp',transport:'shared_server_stream'}
  const periodSeconds=kind==='agg'||kind==='traders'?liveWindowSeconds(event.window):null
  const value=kind==='quote'?event.price:kind==='swap'||kind==='liquidity'?event.amountUsd:kind==='agg'?event.volumeUsd:event.uniqueTraders
  const metadata=kind==='quote'?clock:kind==='swap'?{...place,...clock,eventType:event.side,venue:event.venue??null,transaction:event.tx,logIndex:event.logIndex??null,
      baseAddress:event.baseAddress??null,quoteAddress:event.quoteAddress??null,baseQuantity:event.baseQuantity??null,quoteQuantity:event.quoteQuantity??null,
      basePriceUsd:event.priceUsd??null,excluded:event.excluded===true,scope:'Reported public swap; not a personal trade.'}:
    kind==='liquidity'?{...place,...clock,eventType:event.eventType,venue:event.venue??null,transaction:event.transaction,logIndex:event.logIndex??null,
      baseAddress:event.baseAddress??null,quoteAddress:event.quoteAddress??null,baseQuantity:event.baseQuantity??null,quoteQuantity:event.quoteQuantity??null,
      scope:'Reported pool liquidity activity; not a personal trade or executable order-book depth.'}:
    kind==='agg'?{...place,...clock,window:event.window??null,txCount:event.txCount??null,scope:'Provider-aggregated on-chain swap volume for the window; not a personal trade.'}:
      {...place,...clock,window:event.window??null,windowStart:event.windowStart??null,scope:'Provider-reported unique on-chain trader accounts for the window; accounts, not people.'}
  return {id,subject,provider:'coinmarketcap',metric:spec.metric,value,unit:spec.unit,sourceRef,sourceUrl:'https://coinmarketcap.com/api/documentation/pro-api-websocket/overview',
    observedAt:new Date(event.timestamp).toISOString(),recordedAt:new Date(recordedAt).toISOString(),expiresAt:new Date(event.timestamp+LIVE_STALE_MS).toISOString(),periodSeconds,
    retainUntil:policy.retainUntil,exportAllowed:policy.exportAllowed,aiAllowed:policy.aiAllowed,metadata}
}
