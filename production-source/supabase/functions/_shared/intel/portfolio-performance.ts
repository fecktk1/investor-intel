import {finite,instant,digest,stableJson} from './investigation-evidence.ts'
import {canonicalAssetKey} from '../investor-portfolio/canonical.ts'

type Row=Record<string,any>
const amount=(v:unknown)=>{const n=finite(v);return n!=null&&Math.abs(n)<=Number.MAX_SAFE_INTEGER/100?n:null}
const close=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-8,Math.abs(a)*1e-8,Math.abs(b)*1e-8)
export const PERFORMANCE_METHOD='recorded-book-modified-dietz-2'
export const PERFORMANCE_NOTE='Estimated return on the recorded asset book, using Modified Dietz and actual recorded flow times. Single-leg manual purchases add capital; sales remove proceeds. Paired swaps and matched transfers within this portfolio are internal. Fees reduce the result. This is not an exact time-weighted return or a return on assets held outside this portfolio. No annualization or missing-history reconstruction.'

/** Private projection of existing snapshots and ledger. Does not change holdings,
 * prices, basis or classification. Missing/ambiguous inputs invalidate a period. */
export function portfolioPerformance(inputs:Row,now=Date.now()){
 const snapshots:Row[]=Array.isArray(inputs.snapshots)?[...inputs.snapshots].sort((a,b)=>(instant(a.as_of)??Infinity)-(instant(b.as_of)??Infinity)):[]
 const groups:Row[]=Array.isArray(inputs.groups)?inputs.groups:[],manual:Row[]=Array.isArray(inputs.manual)?inputs.manual:[]
 const base={method:PERFORMANCE_METHOD,note:PERFORMANCE_NOTE,computedAt:new Date(now).toISOString(),periods:[] as Row[],returnPercent:null as number|null,netFlowsUsd:null as number|null,changeAfterFlowsUsd:null as number|null}
 if(inputs.truncated)return {...base,status:'unavailable',reason:'input_limit_exceeded'}
 if(snapshots.length<2)return {...base,status:'unavailable',reason:'two_dated_snapshots_required'}
 if(snapshots.some(s=>instant(s.as_of)==null||instant(s.as_of)!>now))return {...base,status:'unavailable',reason:'invalid_snapshot_clock'}
 const periods:Row[]=[]
 for(let i=1;i<snapshots.length;i++){
  const first=snapshots[i-1],last=snapshots[i],from=instant(first.as_of)!,to=instant(last.as_of)!
  const issues=new Set<string>(),quantities=new Map<string,number>(),flows:Row[]=[],refs=new Set<string>()
  const snapshot=(s:Row)=>{
   const holdings:Row[]=Array.isArray(s.holdings_summary)?s.holdings_summary:[],quality=s.risk_summary?.performance
   if(quality?.version!==1||quality.incompleteHistory!==false)issues.add('snapshot_history_not_verified')
   const entries=new Map<string,Row>();let total=0
   for(const h of holdings){
    const q=amount(h.quantity),v=amount(h.value),key=h.canonicalAssetKey
    if(v!=null&&v>=0)total+=v
    if(typeof key!=='string'||!key||entries.has(key)||q==null||q<0||v==null||v<0||(q===0&&v!==0)||(q>0&&h.priceStatus!=='priced'))issues.add('incomplete_snapshot_valuation')
    else entries.set(key,h)
   }
   const value=amount(s.total_value_usd)
   if(value==null||value<0||!close(total,value))issues.add('snapshot_total_mismatch')
   return {entries,value}
  }
  const start=snapshot(first),end=snapshot(last)
  if(to<=from)issues.add('non_increasing_snapshot_clock')
  const inWindow=(v:unknown)=>{const t=instant(v);return t!=null&&t>from&&t<=to}
  const move=(key:unknown,qty:unknown,direction:unknown)=>{
   const n=amount(qty)
   if(typeof key!=='string'||!key||n==null||n<0||!['in','out'].includes(String(direction))){issues.add('incomplete_transaction_leg');return}
   quantities.set(key,(quantities.get(key)||0)+(direction==='out'?-n:n))
  }
  const flow=(id:string,t:number,value:number|null)=>{if(value==null){issues.add('flow_value_not_recorded');return}flows.push({id,at:new Date(t).toISOString(),valueUsd:value,weight:to>from?(to-t)/(to-from):null})}
  const unitValue=(r:Row,manual=false)=>{
   if(manual&&String(r.quote_currency||'').toUpperCase()!=='USD')return null
   if(['current_price_estimate','zero_value_unpriced'].includes(r.price_source_at_tx)||r.raw_metadata?.basisEstimated)return null
   const qty=amount(manual?r.quantity:r.amount),price=amount(manual?r.price_per_unit:r.price_usd_at_tx)
   const value=qty!=null&&qty>=0&&price!=null&&price>=0?amount(qty*price):null
   return value
  }
  const includedGroups=groups.filter(g=>!g.is_display_mirror&&g.status==='success'&&inWindow(g.block_time))
  // A single transaction can be seen from multiple included wallets. Opposite
  // exact-asset transfer legs are netted only within its chain/hash identity.
  const transfers=new Map<string,{t:number;legs:Row[];ids:string[]}>()
  const seen=new Set<string>()
  for(const g of includedGroups){
   if(seen.has(g.id))continue;seen.add(g.id);refs.add(`grouped:${g.id}`)
   const t=instant(g.block_time)!,legs:Row[]=Array.isArray(g.line_items)?g.line_items:[]
   if((!legs.length&&!['fee','approval'].includes(g.type))||legs.length>200||g.classification_status==='unclassified')issues.add('unclassified_or_incomplete_transaction')
   if(g.fee_asset&&amount(g.fee_amount)==null)issues.add('fee_value_not_recorded')
   for(const leg of legs)move(leg.canonical_asset_key,leg.amount,leg.direction)
   if(amount(g.fee_amount)!==0&&g.fee_amount!=null){
    // The snapshot quantity test needs the exact native fee identity supplied
    // by the existing canonical mapper, never a ticker-derived guess here.
    if(!g.fee_canonical_key)issues.add('fee_identity_unavailable')
    else move(g.fee_canonical_key,g.fee_amount,'out')
   }
   if(['transfer_in','transfer_out'].includes(g.type)){
    const key=`${g.chain}:${g.tx_hash||g.signature||g.id}`,group=transfers.get(key)||{t,legs:[],ids:[]}
    if(group.t!==t)issues.add('conflicting_transfer_times')
    group.legs.push(...legs);group.ids.push(g.id);transfers.set(key,group)
   }else if(['swap','buy','sell'].includes(g.type)){
    if(!legs.some(l=>l.direction==='in')||!legs.some(l=>l.direction==='out'))issues.add('trade_counterleg_missing')
   }else if(!['airdrop','reward','fee','approval'].includes(g.type))issues.add('unsupported_transaction_type')
  }
  for(const transfer of transfers.values()){
   const byAsset=new Map<string,Row[]>()
   for(const leg of transfer.legs){const list=byAsset.get(leg.canonical_asset_key)||[];list.push(leg);byAsset.set(leg.canonical_asset_key,list)}
   for(const legs of byAsset.values()){
    const net=legs.reduce((n,l)=>n+(l.direction==='out'?-1:1)*(amount(l.amount)??0),0)
    if(close(net,0))continue
    // Mixed unmatched legs cannot be valued from whichever quote arrived first.
    const prices=new Set(legs.map(l=>amount(l.price_usd_at_tx)))
    const priced=legs.every(l=>unitValue(l)!=null)
    flow(`grouped:${transfer.ids.join(',')}`,transfer.t,priced&&prices.size===1?amount(net*Number(legs[0].price_usd_at_tx)):null)
   }
  }
  const pairs=new Map<string,Row[]>()
  const seenManual=new Set<string>()
  for(const m of manual.filter(m=>inWindow(m.timestamp))){
   if(seenManual.has(m.id))continue;seenManual.add(m.id);refs.add(`manual:${m.id}`)
   const ty=m.transaction_type,t=instant(m.timestamp)!,pair=m.raw_metadata?.manual_group_id
   if(m.classification_status==='unclassified')issues.add('unclassified_or_incomplete_transaction')
   const direction=['buy','transfer_in','deposit','airdrop','staking_reward'].includes(ty)?'in':['sell','transfer_out','withdrawal'].includes(ty)?'out':m.direction
   if(ty!=='fee')move(m.canonical_asset_key,m.quantity,direction)
   const fee=m.fee_amount==null?0:amount(m.fee_amount)
   if(fee==null||fee<0||(fee>0&&String(m.fee_currency||'').toUpperCase()!=='USD'))issues.add('fee_value_not_recorded')
   if(ty==='swap'&&pair){const rows=pairs.get(pair)||[];rows.push(m);pairs.set(pair,rows)}
   else if(['buy','sell','transfer_in','transfer_out','deposit','withdrawal'].includes(ty)){
    const value=unitValue(m,true)
    flow(`manual:${m.id}`,t,value==null?null:(direction==='out'?-value:value)+(fee??0))
   }else if(!['fee','airdrop','staking_reward'].includes(ty))issues.add('unsupported_transaction_type')
   // Manual fees are a recorded external cash expense, not native units.
   if(['swap','fee','airdrop','staking_reward'].includes(ty)&&fee)flow(`fee:${m.id}`,t,fee)
  }
  for(const rows of pairs.values())if(rows.length!==2||!rows.some(r=>r.direction==='in')||!rows.some(r=>r.direction==='out')||instant(rows[0].timestamp)!==instant(rows[1].timestamp))issues.add('incomplete_manual_swap')
  if(groups.some(g=>!g.is_display_mirror&&g.status==='success'&&instant(g.block_time)==null)||manual.some(m=>instant(m.timestamp)==null))issues.add('transaction_time_missing')
  const keys=new Set([...start.entries.keys(),...end.entries.keys(),...quantities.keys()])
  for(const key of keys)if(!close((amount(start.entries.get(key)?.quantity)??0)+(quantities.get(key)||0),amount(end.entries.get(key)?.quantity)??0))issues.add('quantity_reconciliation_failed')
  const net=flows.reduce((n,f)=>n+f.valueUsd,0),weighted=flows.reduce((n,f)=>n+f.valueUsd*f.weight,0),gain=(end.value??0)-(start.value??0)-net,capital=(start.value??0)+weighted
  if(![net,weighted,gain,capital].every(v=>amount(v)!=null)||capital<=0)issues.add('non_positive_or_invalid_capital')
  const ret=issues.size?null:gain/capital*100
  if(ret!=null&&(!Number.isFinite(ret)||ret < -100))issues.add('invalid_return_range')
  periods.push({from:first.as_of,to:last.as_of,snapshotIds:[first.id,last.id],status:issues.size?'unavailable':'estimate',issues:[...issues],startValueUsd:start.value,endValueUsd:end.value,netFlowsUsd:net,weightedCapitalUsd:capital,changeAfterFlowsUsd:issues.size?null:gain,returnPercent:issues.size?null:ret,flows,transactionRefs:[...refs]})
 }
 const linked=(periods.reduce((n,p)=>n*(1+(p.returnPercent??0)/100),1)-1)*100
 const complete=periods.every(p=>p.status==='estimate')&&amount(linked)!=null
 return {...base,status:complete?'estimate':'incomplete',reason:complete?null:'one_or_more_periods_unavailable',periods,
  returnPercent:complete?linked:null,
  netFlowsUsd:complete?periods.reduce((n,p)=>n+p.netFlowsUsd,0):null,changeAfterFlowsUsd:complete?periods.reduce((n,p)=>n+p.changeAfterFlowsUsd,0):null}
}

export async function readPortfolioPerformance(db:any,orgId:string,portfolioId:string,now=Date.now()){
 const {data,error}=await db.rpc('intel_portfolio_performance_inputs',{p_org_id:orgId,p_portfolio_id:portfolioId})
 if(error||!data||!Array.isArray(data.snapshots)||!Array.isArray(data.groups)||!Array.isArray(data.manual))return {method:PERFORMANCE_METHOD,status:'error',reason:'performance_history_read_failed',version:null,periods:[],returnPercent:null}
 const inputs={...data,groups:(data.groups||[]).map((g:Row)=>({...g,fee_canonical_key:g.fee_asset?canonicalAssetKey(g.chain,null,g.fee_asset):null}))}
 const projection=portfolioPerformance(inputs,now)
 return {...projection,version:await digest(stableJson({method:PERFORMANCE_METHOD,inputs:data}))}
}
