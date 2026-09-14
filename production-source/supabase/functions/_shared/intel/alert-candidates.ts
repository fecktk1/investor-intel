import { DAY_MS, entityChain, exceedsThreshold, supplyShockPct, unlockQualifies, walletActivityQualifies } from './alert-bridge.ts'
type DB = any
type Rule = any

interface Candidate {
  sourceSystem: string
  sourceTable: string
  sourceRef: string
  metric: string
  value: number | null
  payload: Record<string, unknown>
}

// Dispatch a rule to its data source and return the source rows that should fire.
export async function gatherCandidates(db: DB, r: Rule, now = Date.now()): Promise<Candidate[]> {
  const ent = r.entity
  const cfg = r.config || {}
    switch (r.trigger_type) {
      case 'unlock': return await unlockCandidates(db, ent, cfg, now)
      case 'supply_shock': return await supplyShockCandidates(db, ent, cfg, now)
      case 'wallet_activity': return await walletActivityCandidates(db, ent, cfg, r, now)
      case 'holder_shift': return await holderShiftCandidates(db, ent, cfg)
      case 'metadata_migration': return await metadataMigrationCandidates(db, ent, now)
      default: throw Error('unsupported_alert_trigger')
    }
}

// deno-lint-ignore no-explicit-any
async function unlockCandidates(db: DB, ent: any, cfg: any, now:number): Promise<Candidate[]> {
  const keys = [ent.canonical_ref_key]
  if(ent.chain_namespace==='eip155' && ent.chain_id && ent.contract_address)keys.push(`eip155:${ent.chain_id}:${ent.contract_address.toLowerCase()}`)
  if(ent.chain_namespace==='solana' && ent.contract_address)keys.push(`solana:${ent.contract_address}`)
  const exactKeys = [...new Set(keys.filter(Boolean))]
  if(!exactKeys.length)throw Error('canonical_identity_unavailable')
  const windowDays = cfg.window_days == null ? 7 : Number(cfg.window_days)
  if(!Number.isFinite(windowDays)||windowDays<0||windowDays>90)throw Error('invalid_unlock_window')
  const { data, error } = await db.rpc('intel_alert_unlock_candidates',{p_asset_keys:exactKeys,p_now:new Date(now).toISOString(),p_window_days:windowDays})
  if(error)throw Error('unlock_source_read_failed')
  if(!Array.isArray(data))throw Error('unlock_source_response_invalid')
  if(data.length>100)throw Error('unlock_history_limit')
  const out: Candidate[] = []
  for (const u of data) {
    if(!u.asset_keys?.some((key:string)=>exactKeys.includes(key)) || u.event_status!=='scheduled' || Date.parse(u.recorded_at)>now || !Number.isFinite(Date.parse(u.recorded_at)))continue
    if(!u.expires_at || Date.parse(u.expires_at)<=now || !Number.isFinite(Date.parse(u.expires_at)))continue
    const inWindow = u.time_precision==='instant' ? unlockQualifies(Date.parse(u.scheduled_at),now,windowDays) : u.time_precision==='date' && u.event_date>=new Date(now).toISOString().slice(0,10) && u.event_date<=new Date(now+windowDays*DAY_MS).toISOString().slice(0,10)
    if(!inWindow)continue
    out.push({
      sourceSystem: 'unlock', sourceTable: 'intel_calendar_versions', sourceRef: `unlock:${u.source_id}:${u.id}`,
      metric: 'unlock_pct_supply', value: finite(u.detail?.pct_supply),
      payload: { ref:ent.canonical_ref_key, symbol:ent.display_symbol, title:u.title, calendar_version:u.id, calendar_event_id:u.source_id, source:u.source, source_ref:u.source_ref, source_url:u.source_url,
        source_observed_at:u.observed_at, known_at:u.recorded_at, expires_at:u.expires_at, event_status:u.event_status, scheduled_at:u.scheduled_at, unlock_date:u.event_date, time_precision:u.time_precision, amount:finite(u.detail?.amount), pct_supply:finite(u.detail?.pct_supply),
        coverage:'Exact canonical asset; source schedule may be revised. Date-only releases have no known intraday time.' },
    })
  }
  return out
}
const finite=(v:unknown)=>v==null||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))?null:Number(v)

// deno-lint-ignore no-explicit-any
async function supplyShockCandidates(db: DB, ent: any, cfg: any, now:number): Promise<Candidate[]> {
  const id=ent.provider_ids?.coingecko||ent.provider_ids?.coingecko_id
  const network=entityChain(ent.chain_namespace,ent.chain_id),chain=network==='bsc'?'bnb':network
  if(typeof id!=='string'||!id||!chain)throw Error('supply_verified_identity_unavailable')
  const thr=threshold(cfg.threshold_pct,5)
  const { data, error } = await db.from('stablecoin_supply_snapshots')
    .select('id,stablecoin,chain,ts,circulating_usd,provider,source_ref,fetched_at,stale_after,raw_response')
    .eq('raw_response->>gecko_id',id).eq('chain',chain).eq('provider','defillama')
    .gte('ts',new Date(now-2*DAY_MS).toISOString()).lte('ts',new Date(now).toISOString())
    .lte('fetched_at',new Date(now).toISOString()).order('ts', { ascending: false }).limit(2)
  if(error)throw Error('supply_source_read_failed')
  if (!Array.isArray(data)||data.length<2)throw Error('supply_history_incomplete')
  const [current,prior]=data
  if(data.some(row=>row.chain!==chain||row.raw_response?.gecko_id!==id||row.provider!=='defillama'||!past(row.fetched_at,now)||!past(row.ts,now))||current.raw_response.id!==prior.raw_response.id||current.source_ref!==prior.source_ref||Date.parse(current.ts)<=Date.parse(prior.ts)||!future(current.stale_after,now))throw Error('supply_history_incompatible_or_stale')
  const before=finite(prior.circulating_usd),after=finite(current.circulating_usd)
  if(before==null||before<=0||after==null||after<0)throw Error('supply_percent_baseline_unavailable')
  const pct = supplyShockPct(before,after)
  if (!exceedsThreshold(pct, thr)) return []
  return [{
    sourceSystem: 'supply', sourceTable: 'stablecoin_supply_snapshots', sourceRef: `supply:${data[0].id}`,
    metric: 'supply_change_pct', value: pct,
    payload: { ref:ent.canonical_ref_key,stablecoin:current.stablecoin,chain,from_usd:before,to_usd:after,baseline_ref:prior.source_ref,baseline_known_at:prior.fetched_at,known_at:current.fetched_at,source_observed_at:null,source_ref:current.source_ref,source:current.provider,expires_at:current.stale_after,coverage:'Same provider asset and chain, consecutive retained snapshots. Timestamps are capture clocks; source observation time is not supplied.' },
  }]
}

// deno-lint-ignore no-explicit-any
async function walletActivityCandidates(db: DB, ent: any, cfg: any, rule: Rule, now:number): Promise<Candidate[]> {
  const addr = (ent.wallet_address || '').toString()
  if (!addr || !rule.org_id || !rule.user_id) throw Error('wallet_identity_unavailable')
  const minUsd = threshold(cfg.min_usd,100_000)
  const chain=entityChain(ent.chain_namespace,ent.chain_id)
  if(!chain)throw Error('wallet_chain_unavailable')
  const { data, error } = await db.from('large_transfer_events')
    .select('id, event_key, usd_value, symbol, direction, tx_hash, observed_at, fetched_at, provider, source_ref, canonical_asset_key, amount')
    .eq('wallet_address', addr).eq('org_id', rule.org_id).eq('user_id', rule.user_id)
    .eq('chain',chain)
    .gte('observed_at', new Date(now - DAY_MS).toISOString()).lte('observed_at',new Date(now).toISOString())
    .gte('usd_value',minUsd).lte('fetched_at',new Date(now).toISOString())
    .order('observed_at', { ascending: false }).order('id').limit(101)
  if(error)throw Error('wallet_source_read_failed')
  if(!Array.isArray(data))throw Error('wallet_source_response_invalid')
  if(data.length>100)throw Error('wallet_history_limit')
  const out: Candidate[] = []
  for (const e of data || []) {
    const usd = finite(e.usd_value)
    if(!past(e.observed_at,now)||!past(e.fetched_at,now))throw Error('wallet_source_clock_unavailable')
    if (usd==null || !walletActivityQualifies(usd, minUsd)) continue
    out.push({
      sourceSystem: 'onchain', sourceTable: 'large_transfer_events', sourceRef: `ltx:${e.event_key || e.id}`,
      metric: 'transfer_usd', value: usd,
      payload: { symbol: e.symbol, direction: e.direction, tx_hash: e.tx_hash, chain, ref:e.canonical_asset_key, amount:e.amount, source:e.provider, source_ref:e.source_ref, source_observed_at:e.observed_at, known_at:e.fetched_at },
    })
  }
  return out
}

// The current retained score schema has no comparable population ID or original
// source clock. Preserve the rule, but never infer a shift between unlike samples.
// deno-lint-ignore no-explicit-any
async function holderShiftCandidates(db: DB, ent: any, cfg: any): Promise<Candidate[]> {
  throw Error('holder_comparable_population_and_observation_clock_unavailable')
}

// deno-lint-ignore no-explicit-any
async function metadataMigrationCandidates(db: DB, ent: any, now:number): Promise<Candidate[]> {
  const ref = (ent.canonical_ref_key || '').toString()
  const addr = (ent.contract_address || '').toString()
  if (!ref) throw Error('canonical_identity_unavailable')
  let q = db.from('metadata_drift_events')
    .select('id,drift_type,severity,occurred_at,created_at,source_provider,old_value,new_value')
    .gte('occurred_at', new Date(now - 7 * DAY_MS).toISOString()).lte('occurred_at',new Date(now).toISOString()).lte('created_at',new Date(now).toISOString())
    .order('occurred_at', { ascending: false }).order('id').limit(101)
  q=q.eq('canonical_ref_key',ref)
  const { data, error } = await q
  if(error)throw Error('metadata_source_read_failed')
  if(!Array.isArray(data))throw Error('metadata_source_response_invalid')
  if(data.length>100)throw Error('metadata_history_limit')
  const out: Candidate[] = []
  for (const d of data || []) {
    if(!past(d.occurred_at,now)||!past(d.created_at,now))throw Error('metadata_clock_unavailable')
    out.push({
      sourceSystem: 'metadata', sourceTable: 'metadata_drift_events', sourceRef: `drift:${d.id}`,
      metric: 'drift_severity', value: d.severity != null ? Number(d.severity) : null,
      payload: {ref,drift_type:d.drift_type,source:d.source_provider,source_observed_at:d.occurred_at,known_at:d.created_at,before:d.old_value,after:d.new_value},
    })
  }
  return out
}
const past=(value:unknown,now:number)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now
const future=(value:unknown,now:number)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)>now
const threshold=(value:unknown,fallback:number)=>{const n=value==null?fallback:finite(value);if(n==null||n<0||n>1e18)throw Error('invalid_alert_threshold');return n}

export function alertCandidateFailure(error:unknown){
 const reasons:Record<string,string>={
  holder_comparable_population_and_observation_clock_unavailable:'Holder shift unavailable: retained scores have no comparable population identifier or original observation clock.',
  supply_verified_identity_unavailable:'Supply coverage requires a verified provider asset ID and the exact network. A ticker cannot establish this match.',
  supply_history_incomplete:'Two compatible retained supply snapshots are not available.',
  supply_history_incompatible_or_stale:'Supply snapshots are stale or cannot be compared on the same provider asset and chain.',
  supply_percent_baseline_unavailable:'Supply percentage change needs a known positive baseline; missing values and a zero baseline are not zero change.',
  wallet_chain_unavailable:'The recorded wallet network is not supported by this alert source.',
  wallet_source_clock_unavailable:'A wallet source occurrence or recording time is missing or in the future.',
  wallet_history_limit:'More than 100 matching wallet events fall in this window; evaluation is incomplete.',
  unlock_history_limit:'More than 100 unlocks fall in this window; evaluation is incomplete.',
  metadata_history_limit:'More than 100 metadata changes fall in this window; evaluation is incomplete.',
 }
 const message=error instanceof Error?error.message:''
 return {status:reasons[message]?'evidence_unavailable':'evaluation_failed',reason:reasons[message]||'Source read or event commit failed; this is not a no-match result.'}
}
