import {CHAINS} from '../chains.ts'
import {chartAsset} from './chart-workspace-contract.ts'
import {normalizeBars} from './chart-analysis.ts'
import {digest,stableJson} from './investigation-evidence.ts'
import type {ChartSource} from './chart-series-contract.ts'
export type ChartCaptureProof={version:1;asset:string;source:ChartSource;hash:string;count:number;issuedAt:number;expiresAt:number;signature:string}
const bytes=new TextEncoder(),hex=(v:ArrayBuffer)=>Array.from(new Uint8Array(v),b=>b.toString(16).padStart(2,'0')).join('')
const signed=({signature:_,...payload}:ChartCaptureProof)=>stableJson(payload)
const keyFor=(secret:string,usage:KeyUsage[])=>{if(secret.length<32)throw new Error('chart_capture_signing_unavailable');return crypto.subtle.importKey('raw',bytes.encode(secret),{name:'HMAC',hash:'SHA-256'},false,usage)}
export function chartProofAsset(ref:string) {
 const native=CHAINS.find(c=>ref===`native:${c.id}`||ref===`${c.namespace}:${c.caip2Ref}/native:${c.nativeSymbol.toLowerCase()}`)
 if(native)return native.evmChainId!=null?`eip155:${native.evmChainId}:native`:`${native.namespace}:native:${native.nativeSymbol}`
 const app=/^([^:]+):(.+)$/.exec(ref),chain=app&&CHAINS.find(c=>c.id===app[1])
 if(chain&&app&&/^0x[a-f0-9]{40}$/i.test(app[2])&&chain.evmChainId!=null)return `eip155:${chain.evmChainId}:${app[2].toLowerCase()}`
 const caip=/^eip155:([1-9][0-9]*)(?:\/erc20:|:)(0x[a-f0-9]{40})$/i.exec(ref)
 if(caip)return `eip155:${caip[1]}:${caip[2].toLowerCase()}`
 return chartAsset(ref)
}
export async function makeChartCaptureProof(asset:string,bars:unknown[],source:ChartSource,secret:string,now=Date.now()):Promise<ChartCaptureProof> {
 const normalized=normalizeBars(bars)
 if(normalized.rejected||normalized.truncated||!normalized.bars.length)throw new Error('invalid_chart_capture_series')
 const proof:ChartCaptureProof={version:1,asset:chartProofAsset(asset),source,hash:await digest(stableJson(normalized.bars)),count:normalized.bars.length,issuedAt:now,expiresAt:now+3600000,signature:''}
 proof.signature=hex(await crypto.subtle.sign('HMAC',await keyFor(secret,['sign']),bytes.encode(signed(proof))))
 return proof
}
export async function verifyChartCapture(proof:ChartCaptureProof,bars:unknown[],asset:string,secret:string,now=Date.now()) {
 if(!proof||proof.version!==1||!Number.isFinite(proof.issuedAt)||!Number.isFinite(proof.expiresAt)||proof.issuedAt>now||proof.expiresAt<=now||proof.expiresAt-proof.issuedAt>3600000||!/^[a-f0-9]{64}$/.test(proof.signature))throw new Error('chart_capture_expired_or_invalid')
 const signature=Uint8Array.from(proof.signature.match(/../g)!,v=>parseInt(v,16))
 if(!await crypto.subtle.verify('HMAC',await keyFor(secret,['verify']),signature,bytes.encode(signed(proof))))throw new Error('chart_capture_expired_or_invalid')
 if(proof.asset!==chartProofAsset(asset))throw new Error('chart_capture_asset_mismatch')
 const normalized=normalizeBars(bars)
 if(normalized.rejected||normalized.truncated||normalized.bars.length!==proof.count||await digest(stableJson(normalized.bars))!==proof.hash)throw new Error('chart_capture_series_changed')
 return {bars:normalized.bars,source:proof.source,hash:proof.hash,capturedAt:proof.issuedAt}
}
/** The policy prefix of every source a chart series can name. The stored candle
 * archive stitches Binance klines onto CoinMarketCap OHLCV for the years before a
 * listing and labels the series `binance+coinmarketcap`, so a source label is a
 * `+`-joined list and every part must permit an action before the whole does. */
export const CHART_SOURCE_POLICY_PREFIX:Record<string,string>={coingecko:'COINGECKO',geckoterminal:'GECKOTERMINAL',birdeye:'BIRDEYE',coinmarketcap:'CMC',binance:'BINANCE'}
export const chartSourceProviders=(provider:unknown):string[]=>typeof provider==='string'?provider.split('+').map(p=>p.trim()).filter(Boolean):[]
export const chartSourcePolicyKey=(prefix:string,action:'RETENTION'|'EXPORT'|'SHARING')=>prefix==='CMC'&&action!=='SHARING'?action==='RETENTION'?'CMC_ALLOW_HISTORICAL_RETENTION':'CMC_ALLOW_EXPORT':`INTEL_CHART_${prefix}_${action}`
export function chartCapturePolicy(provider:string,env:(name:string)=>string|undefined) {
 const parts=chartSourceProviders(provider).map(p=>CHART_SOURCE_POLICY_PREFIX[p])
 if(!parts.length||parts.some(p=>!p))return {retain:false,export:false}
 const retain=parts.every(p=>env(chartSourcePolicyKey(p,'RETENTION'))==='true')
 return {retain,export:retain&&parts.every(p=>env(chartSourcePolicyKey(p,'EXPORT'))==='true')}
}
export function chartRetentionDeadline(state:any,env:(name:string)=>string|undefined){
 // A series with any CoinMarketCap part keeps CoinMarketCap's retention terms.
 const cmc=chartSourceProviders(state.source?.provider).includes('coinmarketcap'),days=cmc?Math.max(1,Math.min(365,Number(env('CMC_HISTORY_RETENTION_DAYS'))||30)):30
 const captured=Number(state.createdAt??state.capturedAt),saved=Number(state.policy?.retainUntil),terms=cmc?Date.parse(env('CMC_SOURCE_POLICY_EXPIRES_AT')||''):NaN
 if(!Number.isFinite(captured))return 0
 return Math.min(captured+days*86400000,Number.isFinite(saved)&&saved>0?saved:Infinity,Number.isFinite(terms)?terms:Infinity)
}
export function chartPricesReadable(state:any,env:(name:string)=>string|undefined,now=Date.now()){
 return chartCapturePolicy(state.source?.provider,env).retain&&chartRetentionDeadline(state,env)>now
}
