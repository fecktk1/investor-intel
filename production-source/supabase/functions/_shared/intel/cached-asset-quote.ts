import {finite,instant} from './investigation-evidence.ts'
import {researchCmcId,type AssetEvidenceSubject} from './research-identity.ts'
export async function readCachedAssetQuote(db:any,input:AssetEvidenceSubject,now:number) {
 const id=researchCmcId(input)
 const empty={subject:null,observations:[],fields:{},freshness:null,error:null} as any
 if(!id)return empty
 const subject=`market:coinmarketcap:${id}`
 try{
  const {data,error}=await db.from('intel_market_observations').select('observation').eq('subject',subject).eq('provider','coinmarketcap')
   .or('observation->>sourceRef.like.coinmarketcap:/v%/cryptocurrency/quotes/latest:%,observation->>sourceRef.like.coinmarketcap:/v%/cryptocurrency/listings/latest:%')
   .gte('observed_at',new Date(now-86400000).toISOString()).lte('observed_at',new Date(now).toISOString())
   .gt('retain_until',new Date(now).toISOString()).order('observed_at',{ascending:false}).limit(96)
  if(error)throw error
  const fields:Record<string,any>={}
  for(const {observation:o}of data||[]){
   if(o?.subject!==subject||o.provider!=='coinmarketcap'||o.aiAllowed!==true||!/^coinmarketcap:\/v\d+\/cryptocurrency\/(?:quotes|listings)\/latest:/.test(o.sourceRef||''))continue
   if((instant(o.recordedAt)??Infinity)>now||(instant(o.observedAt)??Infinity)>now||(instant(o.expiresAt)??0)<=now||finite(o.value)==null)continue
   const key=o.metric==='price_change'?`change_${o.periodSeconds}`:o.metric
   if(!['price','market_cap','volume_24h','change_3600','change_86400','change_604800'].includes(key)||o.unit!==(key.startsWith('change_')?'%':'USD'))continue
   if(!fields[key]||(instant(o.observedAt)||0)>(instant(fields[key].observedAt)||0))fields[key]=o
  }
  const observations=Object.values(fields),price=fields.price
  return {subject,observations,fields,freshness:price?{status:'fresh',as_of:price.observedAt,recorded_at:price.recordedAt,stale_after:price.expiresAt,age_hours:(now-Date.parse(price.observedAt))/3600000,provider:price.provider,source_ref:price.sourceRef}:null,error:null}
 }catch{return {...empty,subject,error:'Retained market quotes could not be loaded.'}}
}
