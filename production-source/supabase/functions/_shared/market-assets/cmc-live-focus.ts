import {digest,finite,instant,stableJson,type Observation} from '../intel/investigation-evidence.ts'
import {cmcHistoryPolicy,cmcSubject} from '../intel/investigation-normalize.ts'
export const LIVE_WINDOW_MS=20000,LIVE_MESSAGE_LIMIT=200,LIVE_STALE_MS=20000
export function liveFocusPlan(rows:{subject:string;viewers:number;expires_at:string}[],now:number) {
  return [...new Map(rows.filter(r=>/^market:coinmarketcap:[1-9][0-9]{0,11}$/.test(r.subject)&&(instant(r.expires_at)??0)>now).map(r=>[r.subject,r])).values()]
    .sort((a,b)=>b.viewers-a.viewers||a.subject.localeCompare(b.subject)).slice(0,10)
}
export function decodeCmcLive(raw:string,subjects:string[],now:number) {
  if(raw.length>65536)throw new Error('live_message_too_large')
  const message=JSON.parse(raw)
  if(message.type==='error')return {kind:'error',code:Number(message.status?.error_code)||null}
  if(message.type==='ack')return {kind:'ack',accepted:Number(message.code)===0}
  if(message.type==='pong'||message.type==='welcome')return {kind:'control'}
  if(message.type!=='data'||message.channel!=='market@crypto_latest_price')return {kind:'ignored'}
  const subject=cmcSubject(message.data?.cid),price=finite(message.data?.p),timestamp=finite(message.ts)
  if(!subject||!subjects.includes(subject)||price==null||price<=0||timestamp==null||timestamp>now+5000||now-timestamp>LIVE_STALE_MS)return {kind:'invalid'}
  return {kind:'quote',subject,price,timestamp,volumeUsd:finite(message.data.vu),marketCapUsd:finite(message.data.mc)}
}
export async function liveObservation(quote:{subject:string;price:number;timestamp:number},recordedAt:number):Promise<Observation&{retainUntil:string}> {
  const policy=cmcHistoryPolicy(recordedAt,new Date(recordedAt+60000).toISOString())
  const sourceRef='coinmarketcap:market@crypto_latest_price',id=`cmc:${await digest(stableJson({...quote,sourceRef}))}`
  return {id,subject:quote.subject,provider:'coinmarketcap',metric:'price',value:quote.price,unit:'USD',sourceRef,sourceUrl:'https://coinmarketcap.com/api/documentation/pro-api-websocket/overview',
    observedAt:new Date(quote.timestamp).toISOString(),recordedAt:new Date(recordedAt).toISOString(),expiresAt:new Date(quote.timestamp+LIVE_STALE_MS).toISOString(),
    retainUntil:policy.retainUntil,exportAllowed:policy.exportAllowed,aiAllowed:policy.aiAllowed,metadata:{timeMeaning:'Provider stream timestamp',transport:'shared_server_stream'}}
}
