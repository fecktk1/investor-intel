import {digest,evidenceAt,instant,observationState,stableJson,type Observation} from './investigation-evidence.ts'

// Editorial factual summaries, not copied issuer documents or live executable
// quotes. Identity triples were verified with CMC on 2026-09-10 (see evidence).
// Each revision remains immutable. Review expiry is our freshness policy, not
// a claim that the issuer's legal terms expire on that date.
export const ISSUER_REVIEWED_AT='2026-09-10T17:55:45.000Z'
export const ISSUER_REVIEW_EXPIRES='2026-09-17T17:55:45.000Z'
const paxos='https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions'
const ondo='https://docs.ondo.finance/ondo-stocks/'
type Fact={key:string;label:string;summary:string;sourceUrl:string;schedule?:string;terms?:Record<string,unknown>}
type Review={rwaId:string;cryptoId:string;issuerId:string;name:string;issuer:string;market:string|null;facts:Fact[];reviewedAt?:string;expiresAt?:string;version?:string}
export const EXTENDED_ISSUER_REVIEWED_AT='2026-09-12T04:53:06.000Z'
const extendedReview={reviewedAt:EXTENDED_ISSUER_REVIEWED_AT,expiresAt:'2026-09-19T04:53:06.000Z',version:'issuer-review-2'}
const REVIEWS:Review[]=[
 {rwaId:'1',cryptoId:'4705',issuerId:'68904c24abae9b5b9fb35815',name:'PAX Gold',issuer:'Paxos',market:null,facts:[
  {key:'backing',label:'Underlying claim',summary:'Paxos describes each PAXG as ownership of one fine troy ounce of allocated London Good Delivery gold.',sourceUrl:paxos},
  {key:'trading',label:'Secondary trading',summary:'The issuer describes secondary-market trading as 24/7. Individual venue availability and liquidity still need checking.',sourceUrl:'https://docs.paxos.com/guides/stablecoin/paxg'},
  {key:'issuer_hours',label:'Issuer quote hours',summary:'The Paxos guide lists Sunday 18:00 through Friday 17:00, with a daily 17:00–18:00 pause, using the label EST. Its daylight-saving interpretation is unresolved here; no automatic open/closed status is asserted.',sourceUrl:'https://docs.paxos.com/guides/dashboard/paxg'},
  {key:'redemption',label:'Allocated-gold redemption',summary:'Physical-bar redemption requires at least 430 PAXG plus fees per bar. Delivery arrangements and additional due diligence apply; completion can take several business days.',sourceUrl:paxos},
  {key:'eligibility',label:'Issuer eligibility',summary:'Direct conversion and redemption require a verified Paxos customer account and compliance with the issuer’s restrictions. A token balance does not establish eligibility.',sourceUrl:paxos},
 ]},
 {rwaId:'2',cryptoId:'38093',issuerId:'688ca4ccabae9b5b9fb3167a',name:'NVIDIA Tokenized Stock (Ondo)',issuer:'Ondo',market:'XNAS',facts:[
  {key:'backing',label:'Price basis',summary:'Ondo describes a total-return tracker. Shares per token can change with corporate actions; chain-specific display scaling also matters. A one-token/one-share price comparison is unsupported without a dated multiplier.',sourceUrl:ondo+'token-and-quote-pricing'},
  {key:'issuer_hours',label:'Conventional platform sessions',summary:'Published New York sessions: 04:01–09:29, 09:31–15:59, 16:01–19:59 and 20:05–03:55 overnight. Session pauses, holidays, maintenance and asset halts apply. Off-hours access is asset-specific and is not verified here.',sourceUrl:ondo+'market-hours-and-trading-availability',schedule:'ondo_conventional_1'},
  {key:'redemption',label:'Issuer redemption',summary:'The published minimum is USD 1. Redemption supports USDon or USDC; immediate USDC conversion depends on swapper liquidity. Bank-wire USD redemption is not supported by the documented flow.',sourceUrl:ondo+'investing-and-redeeming'},
  {key:'eligibility',label:'Issuer eligibility',summary:'Issuer onboarding and jurisdiction restrictions apply, including prohibitions for US persons and Canada. Read the current eligibility terms; this view does not determine your eligibility.',sourceUrl:ondo+'eligibility'},
 ]},
 {rwaId:'1',cryptoId:'5176',issuerId:'68904e9cabae9b5b9fb358ac',name:'Tether Gold',issuer:'Tether Holdings',market:null,...extendedReview,facts:[
  {key:'redemption',label:'Issuer gold-bar redemption',summary:'The issuer fee schedule describes redemption in 430-token increments, adjusted to the delivered bar. Physical delivery is within Switzerland; a broker sale is a separate option.',sourceUrl:'https://gold.tether.to/legal/feeschedule'},
  {key:'fees',label:'Issuer fees and minimums',summary:'The reviewed schedule lists a 50-token purchase minimum and 0.25% purchase/redemption fees. Redemption may add brokerage or delivery costs. These are issuer terms, not a venue spread or execution quote.',sourceUrl:'https://gold.tether.to/legal/feeschedule'},
  {key:'eligibility',label:'Issuer access',summary:'Direct purchase and redemption are for verified issuer customers, subject to the applicable terms. A token balance alone does not establish eligibility or present redemption availability.',sourceUrl:'https://gold.tether.to/legal/feeschedule'},
 ]},
 {rwaId:'1',cryptoId:'34212',issuerId:'68905a7babae9b5b9fb35a8d',name:'Matrixdock Gold',issuer:'Matrixdock',market:null,...extendedReview,facts:[
  {key:'backing',label:'Reported token basis',summary:'Matrixdock describes one XAUm as one troy ounce of 99.99% fine gold from LBMA-listed refiners, stored in Asian vaults. This issuer description is separate from a fresh reserve measurement.',sourceUrl:'https://www.matrixdock.com/xaum'},
  {key:'allocation',label:'Allocation and redemption access',summary:'The product page distinguishes dynamically allocated fungible tokens from fixed-bar NFTs. Primary minting and redemption use permissioned workflows; current eligibility, fees and minimums must be checked with the issuer.',sourceUrl:'https://www.matrixdock.com/xaum'},
  {key:'network_status',label:'Issuer network notice',summary:'The current contract list marks Polygon, HashKey Chain and Tron deployments discontinued on August 7, 2026 and not recognized as valid XAUm. Historical balances must not be silently priced as currently supported representations.',sourceUrl:'https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/smart-contract/contract-address.md'},
 ]},
 {rwaId:'1',cryptoId:'20245',issuerId:'68904cceabae9b5b9fb35839',name:'Comtech Gold',issuer:'Comtech Gold',market:null,...extendedReview,facts:[
  {key:'redemption',label:'Token-contract redemption terms',summary:'Section 8 of the issuer terms describes conversion in whole-kilogram increments, with fees and collection or delivery requirements. Section 9 separately describes partner exchanges starting at one gram; partner availability is not established here.',sourceUrl:'https://comtechgold.com/assets/pdf/Terms_and_Conditions.pdf'},
  {key:'eligibility',label:'Issuer-platform access',summary:'The terms require registration and identity, anti-money-laundering and sanctions checks for trading through the issuer platform. This summary does not determine eligibility.',sourceUrl:'https://comtechgold.com/assets/pdf/Terms_and_Conditions.pdf'},
  {key:'coverage_difference',label:'Different published product flows',summary:'A separate digital-gold app FAQ describes delivery from 10 grams. That app flow is not established as identical to redeeming the CMC-listed token; its minimum must not replace the token-contract terms.',sourceUrl:'https://www.comtechgold.com/assets/pdf/ComTech_Gold_FAQ_Final.pdf'},
 ]},
]
export const STRUCTURED_TERMS_REVIEWED_AT='2026-09-12T22:13:16.000Z'
const structuredReview={reviewedAt:STRUCTURED_TERMS_REVIEWED_AT,expiresAt:'2026-09-19T22:13:16.000Z',version:'issuer-structured-terms-1'}
// Additional independently dated facts. Do not restamp the older reviews of
// other source documents, or substitute an illustrative share multiplier.
REVIEWS.push(
 {rwaId:'1',cryptoId:'4705',issuerId:'68904c24abae9b5b9fb35815',name:'PAX Gold',issuer:'Paxos',market:null,...structuredReview,facts:[
  {key:'denomination',label:'Recorded units per token',summary:'The issuer terms define one PAXG as one fine troy ounce of allocated London Good Delivery gold. This is a token denomination, not a current gold price or reserve audit.',sourceUrl:paxos,terms:{kind:'denomination',unitsPerToken:1,underlyingUnit:'fine_troy_ounce',variable:false}},
  {key:'redemption_conditions',label:'Allocated-bar conversion conditions',summary:'Allocated-bar redemption starts at 430 PAXG per bar, plus fees. Excess tokens are credited after the actual bar weight and fees are settled. Verified-account access, further due diligence and delivery arrangements are separate requirements.',sourceUrl:paxos,terms:{kind:'redemption',minimum:430,minimumUnit:'token',increment:null,feesIncluded:false,channel:'allocated_gold_bar',availability:'unverified'}},
 ]},
 {rwaId:'2',cryptoId:'38093',issuerId:'688ca4ccabae9b5b9fb3167a',name:'NVIDIA Tokenized Stock (Ondo)',issuer:'Ondo',market:'XNAS',...structuredReview,facts:[
  {key:'denomination',label:'Shares per token and display scaling',summary:'Shares per token change with corporate actions and reinvested distributions. Ondo publishes the asset multiplier on-chain and in its app. Solana and BNB Scaled UI balances may use different display units; no dated multiplier for this token was captured in this review.',sourceUrl:ondo+'token-and-quote-pricing',terms:{kind:'denomination',unitsPerToken:null,underlyingUnit:'share',variable:true}},
  {key:'redemption_conditions',label:'Stablecoin redemption conditions',summary:'The documented redemption minimum is USD 1. USDC conversion depends on swapper liquidity and access; USD bank-wire redemption is not supported by this flow. A token count alone cannot establish the USD threshold without an executable quote.',sourceUrl:ondo+'investing-and-redeeming',terms:{kind:'redemption',minimum:1,minimumUnit:'USD',increment:null,feesIncluded:false,channel:'USDon_or_USDC',availability:'unverified'}},
 ]},
 {rwaId:'1',cryptoId:'20245',issuerId:'68904cceabae9b5b9fb35839',name:'Comtech Gold',issuer:'Comtech Gold',market:null,...structuredReview,facts:[
  {key:'denomination',label:'Recorded units per token',summary:'Section 3.2 defines one digital-gold unit as an interest in one gram of gold with at least 999 purity. This is distinct from a fine-troy-ounce denomination and from a fresh reserve measurement.',sourceUrl:'https://comtechgold.com/assets/pdf/Terms_and_Conditions.pdf',terms:{kind:'denomination',unitsPerToken:1,underlyingUnit:'gram_gold_minimum_999_purity',variable:false}},
 ]},
)

/** Scheduled re-reviews. A cycle re-reads every source and restates the current
 * facts under one review date: unchanged wording carries forward, a changed fact
 * replaces its key, and a fact that could not be re-verified is omitted, so its
 * earlier review expires on its own date. An omission persists until a later
 * cycle supplies the fact again. Append cycles; never edit a deployed one.
 * Timeline and procedure: docs/investor-intel/issuer-review-schedule.md */
export const ISSUER_REVIEW_WINDOW_MS=7*86400000
export type ReviewCycle={version:string;reviewedAt:string;expiresAt:string;changes?:Record<string,Fact[]>;omitted?:string[];lapse?:string}
export function reviewCycleRestatements(seed:readonly Review[],cycles:readonly ReviewCycle[],problems:string[]=[]):Review[] {
 const dated=(r:Review)=>Date.parse(r.reviewedAt||ISSUER_REVIEWED_AT),out:Review[]=[]
 const current=new Map<string,{review:Review;facts:Map<string,{fact:Fact;expiresAt:number}>}>()
 let latest=-Infinity
 for(const review of [...seed].sort((a,b)=>dated(a)-dated(b))) {
  const facts=current.get(review.cryptoId)?.facts??new Map<string,{fact:Fact;expiresAt:number}>(),expiresAt=Date.parse(review.expiresAt||ISSUER_REVIEW_EXPIRES)
  for(const fact of review.facts)facts.set(fact.key,{fact,expiresAt})
  current.set(review.cryptoId,{review,facts});latest=Math.max(latest,dated(review))
 }
 for(const cycle of cycles) {
  const reviewed=Date.parse(cycle.reviewedAt),expires=Date.parse(cycle.expiresAt)
  if(!(reviewed>latest))problems.push(`${cycle.version}: review date must follow every earlier review`)
  if(expires-reviewed!==ISSUER_REVIEW_WINDOW_MS)problems.push(`${cycle.version}: window must be seven days`)
  for(const ref of cycle.omitted??[]) {
   const split=ref.indexOf(':')
   if(split<1||!current.get(ref.slice(0,split))?.facts.delete(ref.slice(split+1)))problems.push(`${cycle.version}: omits unknown fact ${ref}`)
  }
  // A carried or replaced fact must still be current when its sources are re-read.
  if(!cycle.lapse)for(const [cryptoId,{facts}] of current)for(const [key,entry] of facts)
   if(entry.expiresAt<=reviewed)problems.push(`${cycle.version}: ${cryptoId}:${key} expired before this review`)
  for(const [cryptoId,facts] of Object.entries(cycle.changes??{})) {
   const token=current.get(cryptoId)
   if(!token){problems.push(`${cycle.version}: changes unknown token ${cryptoId}`);continue}
   for(const fact of facts)token.facts.set(fact.key,{fact,expiresAt:expires})
  }
  for(const {review,facts} of current.values()) {
   if(!facts.size)continue
   for(const entry of facts.values())entry.expiresAt=expires
   out.push({rwaId:review.rwaId,cryptoId:review.cryptoId,issuerId:review.issuerId,name:review.name,issuer:review.issuer,market:review.market,
    reviewedAt:cycle.reviewedAt,expiresAt:cycle.expiresAt,version:cycle.version,facts:[...facts.values()].map(entry=>entry.fact)})
  }
  latest=reviewed
 }
 return out
}
export const ISSUER_REVIEW_SEED:readonly Review[]=[...REVIEWS]
export const ISSUER_REVIEW_CYCLES:readonly ReviewCycle[]=[
 // Every source re-read on 2026-09-14: docs/investor-intel/evidence/issuer-review-3-20260914.md
 {version:'issuer-review-3',reviewedAt:'2026-09-14T16:35:00.000Z',expiresAt:'2026-09-21T16:35:00.000Z',changes:{
  '4705':[{key:'redemption',label:'Allocated-gold redemption',summary:'Physical-bar redemption requires at least 430 PAXG plus the Paxos user-guide fee per London Good Delivery bar, and can involve additional due diligence. The holder arranges delivery. Paxos says an account balance can take several business days to reflect a redemption; no delivery completion time is stated.',sourceUrl:paxos}],
  '38093':[
   {key:'issuer_hours',label:'Conventional platform sessions',summary:'Published New York sessions: 04:01–09:29, 09:31–15:59, 16:01–19:59 and 20:05–03:55 overnight. Session pauses, holidays, maintenance and asset halts apply. Off-Hours trading is a separate service, described in its own fact.',sourceUrl:ondo+'market-hours-and-trading-availability',schedule:'ondo_conventional_1'},
   {key:'off_hours',label:'Off-Hours trading',summary:'Ondo lists NVDAon for its Off-Hours service, which runs while conventional sessions are closed, mainly weekends and market holidays, on the Ethereum, BNB Chain and Solana networks. Each asset has a dynamic limit; spreads can be wider, and quotes can be declined or trading restricted at the limit. Availability on a given network or at a given time is not verified here.',sourceUrl:ondo+'off-hours-trading'},
  ],
  '5176':[{key:'eligibility',label:'Issuer access',summary:'Direct purchase and redemption are for verified issuer customers under the applicable terms; the schedule lists a non-refundable 150 USDt verification fee. A token balance alone does not establish eligibility or present redemption availability.',sourceUrl:'https://gold.tether.to/legal/feeschedule'}],
  '20245':[{key:'redemption',label:'Token-contract redemption terms',summary:'Section 8 of the issuer terms describes conversion to physical gold in one-kilogram minimums and increments, released less fees, with collection at the vault or delivery at the holder’s cost. Section 9 separately lets partner jewellers or bullion providers exchange units from one gram; partner availability is not established here.',sourceUrl:'https://comtechgold.com/assets/pdf/Terms_and_Conditions.pdf'}],
 }},
 // Every source re-read on 2026-09-16: docs/investor-intel/evidence/issuer-review-4-20260916.md
 // Every reviewed fact was found again in its source, so no wording changed and
 // nothing was omitted. The cycle restates the current words under one new date.
 {version:'issuer-review-4',reviewedAt:'2026-09-16T12:56:00.000Z',expiresAt:'2026-09-23T12:56:00.000Z'},
]
REVIEWS.push(...reviewCycleRestatements(ISSUER_REVIEW_SEED,ISSUER_REVIEW_CYCLES))

/** Exact CMC relationship, never ticker/name similarity. Conflicting duplicate
 * relationships are withheld, rather than selecting whichever row came first. */
export function reviewedRelationships(records:any[]) {
 const candidates=new Map<string,any[]>();
 for(const r of records.slice(0,20))for(const token of (Array.isArray(r?.tokens)?r.tokens:[]).slice(0,500)) {
  if(!/^[1-9][0-9]{0,11}$/.test(String(r.rwa_id))||!/^[1-9][0-9]{0,11}$/.test(String(token?.crypto_id)))continue
  const key=`${r.rwa_id}:${token.crypto_id}`,items=candidates.get(key)||[];items.push(token);candidates.set(key,items)
 }
 return REVIEWS.filter(review=>{
  const tokens=candidates.get(`${review.rwaId}:${review.cryptoId}`)
  return !!tokens?.length&&tokens.every(t=>t.issuer_id===review.issuerId)
 })
}
export async function issuerReviewObservations(records:any[],recordedAt:string):Promise<Observation[]> {
 const recorded=instant(recordedAt)
 if(recorded==null)return []
 return Promise.all(reviewedRelationships(records).filter(review=>recorded>=Date.parse(review.reviewedAt||ISSUER_REVIEWED_AT)&&recorded<Date.parse(review.expiresAt||ISSUER_REVIEW_EXPIRES)).flatMap(review=>review.facts.map(async fact=>{
  const reviewedAt=review.reviewedAt||ISSUER_REVIEWED_AT,reviewExpiresAt=review.expiresAt||ISSUER_REVIEW_EXPIRES,version=review.version||'issuer-review-1'
  const content={review:version,rwaId:review.rwaId,cryptoId:review.cryptoId,issuerId:review.issuerId,fact,reviewedAt,reviewExpiresAt}
  return {id:`issuer:${await digest(stableJson(content))}`,subject:`rwa:coinmarketcap:${review.rwaId}`,metric:`issuer_${fact.key}`,value:fact.summary,unit:'text',provider:'investor-intel-editorial',
   sourceRef:`${version}:${review.cryptoId}:${fact.key}`,sourceUrl:fact.sourceUrl,observedAt:reviewedAt,recordedAt,expiresAt:reviewExpiresAt,
   universe:`token:coinmarketcap:${review.cryptoId}:${review.issuerId}`,exportAllowed:true,aiAllowed:false,
   metadata:{cryptoId:review.cryptoId,issuerId:review.issuerId,tokenName:review.name,issuerName:review.issuer,label:fact.label,market:review.market,schedule:fact.schedule??null,...(fact.terms?{terms:fact.terms}:{}),
    timeMeaning:'Editorial source review, not an issuer publication or market observation time',reviewVersion:version,rights:'Original factual summary with links; source documents are not stored'}} satisfies Observation
 })))
}
/** Preserve the first server recording clock on a retried public observation.
 * No private text, account or position is supplied to this store. */
export async function recordIssuerReviews(db:any,records:any[],now:number) {
 const observations=await issuerReviewObservations(records,new Date(now).toISOString())
 if(!observations.length)return []
 const {error}=await db.rpc('intel_record_market_observations',{p_rows:observations.map(o=>({...o,retainUntil:new Date(now+30*86400000).toISOString()}))})
 if(error)throw new Error('issuer_review_storage_unavailable')
 const stored=await db.from('intel_market_observations').select('observation').in('id',observations.map(o=>o.id)).gt('retain_until',new Date(now).toISOString())
 if(stored.error||stored.data?.length!==observations.length)throw new Error('issuer_review_storage_unavailable')
 return stored.data.map((r:any)=>r.observation) as Observation[]
}
export function issuerReviewAt(observations:Observation[],subject:string,cryptoId:string,asOf:number) {
 const facts=evidenceAt(observations.filter(o=>o.subject===subject&&o.provider==='investor-intel-editorial'&&o.metadata?.cryptoId===cryptoId),asOf)
 const identities=new Set(facts.map(o=>o.metadata?.issuerId))
 if(identities.size!==1)return {state:'unavailable',facts:[],market:null,schedule:null}
 const current=facts.filter(o=>observationState(o,asOf)==='known'),stale=current.length!==facts.length
 return {state:!current.length?'review_expired':stale?'partially_reviewed':'reviewed',facts,market:String(current.find(o=>o.metadata?.market)?.metadata?.market||'')||null,
  schedule:current.find(o=>o.metadata?.schedule)?.metadata?.schedule??null}
}
