import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { CMC_CAPABILITIES, cmcParams, cmcRows, cmcObservedAt, planAllows, estimateCmcCredits } from './cmc-capabilities.ts'
import { fixtureData } from '../src/fixtures.mjs'
import { createKeylessClient, KEYLESS_CAVEAT } from './keyless.mjs'
const ALLOWED=new Set(['quotes','metadata','history','ohlcv','rwaList','rwaInfo','rwaQuotes','issuers','issuer','derivativeExchanges','derivativePairs','liquidations'])
export function createResearchService({filename=':memory:',mode='fixture',key='',plan='basic',creditLimit=20,fetcher=fetch,now=()=>Date.now()}={}) {
  const db=new DatabaseSync(filename)
  db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=1000;CREATE TABLE IF NOT EXISTS budget(period TEXT PRIMARY KEY,used REAL NOT NULL DEFAULT 0,reserved REAL NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,payload TEXT,expires REAL NOT NULL DEFAULT 0,observed TEXT,fetched TEXT);')
  // Keyless mode never reads or sends a key, so the configured one is discarded
  // here rather than merely left unused further down.
  const keylessMode=mode==='keyless'
  if(keylessMode)key=''
  const keyless=keylessMode?createKeylessClient({fetcher,now}):null
  let account=null,verifiedAt=0,lastCall=0,live=false
  const state=()=>({mode:keylessMode?'keyless':mode==='live'?'live':'fixture',keyConfigured:!!key,verifiedPlan:plan,localCreditLimit:creditLimit,keyless:keyless?{...keyless.stats(),caveat:KEYLESS_CAVEAT}:null})
  const unavailable=(capability,reason)=>({version:1,capability,state:'unavailable',fixture:false,data:{rows:[],total:null,hasMore:false},reason,provenance:{provider:'coinmarketcap',observedAt:null,fetchedAt:null,expiresAt:null,sourceUrl:'https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview'}})
  async function read(capability,input={}) {
    // The keyless demo has its own route table, bounds, cache and ceilings, and
    // never reaches the keyed transport, the SQLite cache or the credit ledger.
    if(keylessMode)return keyless.read(capability,input)
    if(!ALLOWED.has(capability))throw Error('unsupported_capability')
    const params=cmcParams(capability,input),spec=CMC_CAPABILITIES[capability]
    if(Number(params.limit||params.count||0)>100)throw Error('maximum_rows_100')
    for(const id of ['id','rwa_id','crypto_id','slug','rwa_slug'])if((params[id]?.split(',').length||0)>20)throw Error('maximum_identifiers_20')
    if(mode!=='live')return fixtureData(capability,params)
    if(!key)return unavailable(capability,'Server key is not configured.')
    if(!planAllows(plan,spec.tier))return unavailable(capability,'This capability requires a separately verified plan.')
    const cacheKey=JSON.stringify([plan,createHash('sha256').update(key).digest('hex').slice(0,24),capability,params]),cached=db.prepare('SELECT * FROM cache WHERE key=?').get(cacheKey)
    if(cached&&cached.expires>now())return JSON.parse(cached.payload)
    if(live||now()-lastCall<2100)return unavailable(capability,'Shared local rate limit; retry in a few seconds.')
    live=true;lastCall=now()
    const period=new Date(now()).toISOString().slice(0,7)
    let reserved=false,actual=null,estimate=estimateCmcCredits(capability,params)
    try{
      if(!account||now()-verifiedAt>300000){
        const r=await fetcher('https://pro-api.coinmarketcap.com/v1/key/info',{headers:{'X-CMC_PRO_API_KEY':key},signal:AbortSignal.timeout(6000),redirect:'error'})
        const info=await r.json(),limit=Number(info?.data?.plan?.credit_limit_monthly),used=Number(info?.data?.usage?.current_month?.credits_used)
        if(!r.ok||!Number.isFinite(limit)||!Number.isFinite(used)||!info?.data?.plan?.rate_limit_minute)return unavailable(capability,'Account verification unavailable.')
        account={remaining:Math.max(0,limit*0.8-used)};verifiedAt=now()
      }
      if(account.remaining<estimate)return unavailable(capability,'Account headroom is exhausted.')
      db.prepare('INSERT OR IGNORE INTO budget(period)VALUES(?)').run(period)
      const claim=db.prepare('UPDATE budget SET reserved=reserved+? WHERE period=? AND used+reserved+?<=?').run(estimate,period,estimate,creditLimit)
      if(!claim.changes)return unavailable(capability,'The persistent local credit ceiling is reached.')
      reserved=true
      const query=new URLSearchParams(params)
      if(!['metadata','rwaInfo','issuers','issuer'].includes(capability))query.set('convert','USD')
      const response=await fetcher(`https://pro-api.coinmarketcap.com${spec.path}?${query}`,{headers:{'X-CMC_PRO_API_KEY':key,Accept:'application/json'},signal:AbortSignal.timeout(8000),redirect:'error'})
      const raw=await response.text();if(raw.length>2000000)throw Error('Response exceeds local bound')
      const body=JSON.parse(raw)
      if(body?.status?.credit_count!=null&&Number.isFinite(Number(body.status.credit_count)))actual=Math.max(0,Number(body.status.credit_count))
      if(!response.ok||body?.status?.error_code)return unavailable(capability,response.status===403?'The account does not support this endpoint.':'Provider response is unavailable.')
      if(body?.data==null)throw Error('Malformed response')
      const result={version:1,capability,state:'fresh',fixture:false,data:cmcRows(capability,body),reason:null,provenance:{provider:'coinmarketcap',observedAt:capability==='ohlcv'?ohlcvObservedAt(body):cmcObservedAt(body,capability),fetchedAt:new Date(now()).toISOString(),expiresAt:new Date(now()+spec.ttl*1000).toISOString(),sourceUrl:'https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview'}}
      db.prepare('INSERT INTO cache(key,payload,expires,observed,fetched)VALUES(?,?,?,?,?) ON CONFLICT(key)DO UPDATE SET payload=excluded.payload,expires=excluded.expires,observed=excluded.observed,fetched=excluded.fetched').run(cacheKey,JSON.stringify(result),now()+spec.ttl*1000,result.provenance.observedAt,result.provenance.fetchedAt)
      return result
    }catch{return unavailable(capability,'Provider or local accounting is unavailable.')}
    finally{
      if(reserved){const billed=actual??estimate;db.prepare('UPDATE budget SET reserved=max(0,reserved-?),used=used+? WHERE period=?').run(estimate,billed,period);account.remaining=Math.max(0,account.remaining-billed);if(actual==null)verifiedAt=0}
      live=false
    }
  }
  return {read,state,close:()=>db.close(),usage:()=>db.prepare('SELECT * FROM budget').all()}
}

function ohlcvObservedAt(body){const times=cmcRows('ohlcv',body).rows.flatMap(row=>(row.quotes||[]).map(p=>Date.parse(p.time_close||''))).filter(t=>Number.isFinite(t)&&t<=Date.now()+300000);return times.length?new Date(Math.max(...times)).toISOString():null}
