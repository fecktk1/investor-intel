// Live on-chain tape client (CMC plan Stage 4, proposal 28).
// docs/investor-intel/live-on-chain-tape.md
//
// Two reads against the `intel-investigate` Edge Function:
//   {operation:'live', subject, enabled, viewId}  touches the 45-second lease
//   {operation:'tape', subject, since}            answers the recent public tape
//
// `subject` is the CANONICAL key the asset page already holds
// (`eip155:8453:0x…`, `solana:<mint>`), not the lease grammar: `operation:'live'`
// runs `investigationIdentity` first and only that grammar survives it, and
// `operation:'tape'` accepts the canonical key through the same
// `liveContractSubject` conversion. The lease subject is still derived here, for
// the gate (four platforms only) and so a caller can name the lease it holds.
//
// Nothing in this module throws. Every failure — an unsupported identity, a
// refused lease, a transport error — comes back as a `reason`, because the
// honest state of this feature today is "not streaming", and a thrown error
// would be indistinguishable from a tape that simply has nothing in it.
import {cmcDexIdentity} from '../../../supabase/functions/_shared/market-assets/cmc-dex.ts'
import {invokeInvestigation} from './useInvestigation'

/** The only platforms CMC_DEX_NETWORKS carries, and therefore the only contracts
 * that can hold a live lease. Anything else is not a live subject at all. */
export const LIVE_TAPE_PLATFORMS=['ethereum','base','arbitrum','solana']
/** The lease is 45 s (cmc-live-focus.ts). Touch well inside it, poll the tape at
 * the price lane's cadence, and ask for five minutes of tape by default. */
export const LIVE_TAPE_LEASE_MS=45000
export const LIVE_TAPE_TOUCH_MS=30000
export const LIVE_TAPE_POLL_MS=5000
export const LIVE_TAPE_SINCE_MS=300000
// The service refuses a `since` older than one hour (`invalid_live_tape_since`).
// Clamp short of it so a long-open panel never asks for a window it cannot have.
const SINCE_FLOOR_MS=3300000
export const LIVE_TAPE_EMPTY_LEASE={active:false,expiresAt:null,viewers:0}

/** Client mirror of `liveContractSubject` in
 * supabase/functions/_shared/market-assets/cmc-live-focus.ts: the canonical key
 * becomes exactly one lease subject, EVM addresses lowercased (`cmcDexIdentity`
 * lowercases them) and Solana mints left untouched, because a checksum-cased
 * address would otherwise be a second lease for the same contract. */
export function liveTapeIdentity(canonicalKey) {
  const identity=cmcDexIdentity(canonicalKey)
  if(!identity||!LIVE_TAPE_PLATFORMS.includes(identity.platform))return null
  return {
    subject:`contract:${identity.platform}:${identity.address}`,
    // Where the evidence lives — shared with the retained REST DEX rows.
    observationSubject:identity.subject,
    platform:identity.platform,chain:identity.chain,address:identity.address,label:identity.label,
  }
}
export const liveTapeSubject=canonicalKey=>liveTapeIdentity(canonicalKey)?.subject??null

const reasonOf=error=>{
  const code=error?.code??error?.message
  return typeof code==='string'&&code?code:'investigation_unavailable'
}
/** Bounded to the window the service accepts, so a stale cursor degrades to a
 * shorter tape rather than to an error. */
export function liveTapeSince(since,now=Date.now()) {
  const parsed=typeof since==='number'?since:since==null?null:Date.parse(since)
  const wanted=parsed==null||!Number.isFinite(parsed)?now-LIVE_TAPE_SINCE_MS:parsed
  return new Date(Math.min(now,Math.max(now-SINCE_FLOOR_MS,wanted))).toISOString()
}

/** Touch or release this org's lease on a contract. `enabled:false` always
 * works, whatever the operating profile, so pausing is never refused. */
export async function touchLiveTape(supabase,{orgId,canonicalKey,enabled,viewId,signal}={}) {
  const identity=liveTapeIdentity(canonicalKey)
  if(!identity||!orgId)return {ok:false,subject:identity?.subject??null,state:null,expiresAt:null,reason:'invalid_live_tape'}
  try{
    const data=await invokeInvestigation(supabase,{operation:'live',orgId,subject:canonicalKey,enabled:enabled===true,...(viewId?{viewId}:{})},signal)
    return {ok:true,subject:identity.subject,state:typeof data?.state==='string'?data.state:null,
      // A refused lease answers no `expiresAt` at all — that absence, not a
      // message string, is how a caller knows nothing was leased.
      expiresAt:data?.expiresAt??null,reason:data?.reason??null}
  }catch(error){return {ok:false,subject:identity.subject,state:null,expiresAt:null,reason:reasonOf(error)}}
}

/** The recent public tape for one contract plus this org's lease state. */
export async function readLiveTape(supabase,{orgId,canonicalKey,since,signal}={},now=Date.now()) {
  const identity=liveTapeIdentity(canonicalKey)
  const base={subject:identity?.subject??null,observationSubject:identity?.observationSubject??null,events:[],asOf:null,lease:LIVE_TAPE_EMPTY_LEASE}
  if(!identity||!orgId)return {ok:false,...base,reason:'invalid_live_tape'}
  try{
    const data=await invokeInvestigation(supabase,{operation:'tape',orgId,subject:canonicalKey,since:liveTapeSince(since,now)},signal)
    const events=(Array.isArray(data?.events)?data.events:[])
      .filter(event=>event&&Number.isFinite(Date.parse(event.observedAt)))
      .sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))
    const answered=data?.lease
    const lease=answered&&typeof answered==='object'?{active:answered.active===true,expiresAt:answered.expiresAt??null,
      viewers:Number.isFinite(Number(answered.viewers))?Number(answered.viewers):0}:LIVE_TAPE_EMPTY_LEASE
    return {ok:true,...base,subject:data?.subject??identity.subject,observationSubject:data?.observationSubject??identity.observationSubject,
      events,asOf:data?.asOf??null,lease,reason:data?.reason??null}
  }catch(error){return {ok:false,...base,reason:reasonOf(error)}}
}
