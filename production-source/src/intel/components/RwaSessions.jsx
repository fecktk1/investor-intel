import React,{useMemo,useState} from 'react'
import {Link} from 'react-router'
import {useTranslation} from 'react-i18next'
import {evidenceAt,safeSourceUrl,observationState} from '../../../supabase/functions/_shared/intel/investigation-evidence.ts'
import {issuerReviewAt} from '../../../supabase/functions/_shared/intel/rwa-issuer-evidence.ts'
import {equitySession,ondoConventionalSession} from '../../../supabase/functions/_shared/intel/investigation-sessions.ts'
import {InvestigationTable} from './InvestigationTable'
import RwaTerms from './RwaTerms'

const time=value=>new Date(value).toLocaleString(undefined,{timeZoneName:'short'})
const interval=window=>`${new Date(window.open).toLocaleDateString(undefined,{month:'short',day:'numeric'})} · ${new Date(window.open).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}–${new Date(window.close).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit',timeZoneName:'short'})}`
export default function RwaSessions({subject,records=[],observations=[],at,selectedToken,onTokenChange,onPrepareReceipt}) {
 const {t}=useTranslation('intel',{useSuspense:false}),[localToken,setLocalToken]=useState('')
 const tokens=useMemo(()=>{
  const known=new Map()
  for(const o of evidenceAt(observations.filter(o=>o.subject===subject&&o.provider==='investor-intel-editorial'),at))if(o.metadata?.cryptoId)known.set(String(o.metadata.cryptoId),{id:String(o.metadata.cryptoId),name:o.metadata.tokenName,previous:true})
  for(const r of records.filter(r=>`rwa:coinmarketcap:${r.rwa_id}`===subject))for(const token of (r.tokens||[]).slice(0,500))if(/^[1-9][0-9]{0,11}$/.test(String(token.crypto_id)))known.set(String(token.crypto_id),{id:String(token.crypto_id),name:token.name||`Token ${token.crypto_id}`,previous:false})
  return [...known.values()]
 },[subject,records,observations,at])
 const requested=selectedToken??localToken,token=requested?tokens.find(r=>r.id===requested):tokens[0]
 const review=issuerReviewAt(observations,subject,token?.id||'',at),underlying=review.market?equitySession(at,review.market):null
 const conventional=review.schedule==='ondo_conventional_1'?ondoConventionalSession(at):null
 const choose=value=>{setLocalToken(value);onTokenChange?.(value)}
 return <section aria-label={t('investigation.rwa_clocks',{defaultValue:'Token, underlying and issuer clocks'})} className="intel-rwa-clocks">
  <div className="flex flex-wrap items-end justify-between gap-3"><label className="intel-inline-field">{t('investigation.token_representation',{defaultValue:'Token representation'})}<select className="select" value={token?.id||''} onChange={e=>choose(e.target.value)}>{!token&&<option value="">{requested?'Selected token unavailable; choose a token':'Select an RWA with linked tokens'}</option>}{tokens.map(r=><option key={r.id} value={r.id}>{r.name}{r.previous?' · previously recorded':''}</option>)}</select></label>
   {token&&<Link className="intel-text-link" to={`/intel/markets/${encodeURIComponent(token.name)}?provider=coinmarketcap&id=${token.id}`}>{t('investigation.token_position',{defaultValue:'Open token, holdings and thesis'})}</Link>}
  </div>
  <p className="intel-analysis-caption">{t('investigation.rwa_clock_explanation',{defaultValue:'A token can trade while its underlying market is closed. Issuer quotes and redemption have their own conditions.'})}</p>
  {review.state==='unavailable'?<p role="status">{t('investigation.issuer_missing',{defaultValue:'No reviewed issuer evidence was recorded for this token at the selected time. Select another token or inspect its issuer documentation.'})}</p>:<>
   {review.state==='review_expired'&&<p role="status">{t('investigation.issuer_expired',{defaultValue:'This source review was withdrawn by a later review. The recorded summary remains visible; current hours and terms require re-verification.'})}</p>}
   {review.state==='partially_reviewed'&&<p role="status">{t('investigation.issuer_partially_reviewed',{defaultValue:'Some facts were withdrawn by a later review. Only the facts still in force are used for calculations and market clocks.'})}</p>}
   <div className="intel-rwa-clock-comparison">
    <div><h3>{t('investigation.underlying_clock',{defaultValue:'Underlying market'})}</h3><p>{underlying?`${review.market==='XNAS'?'Nasdaq':'NYSE'} · ${underlying.state.replaceAll('_',' ')}`:t('investigation.underlying_no_clock',{defaultValue:'No verified underlying calendar for this selection.'})}</p>
     {underlying?.current&&<p className="intel-analysis-caption">{interval(underlying.current)}</p>}{underlying&&<a className="intel-text-link" href={underlying.sourceUrl} target="_blank" rel="noreferrer">Core calendar</a>}
    </div>
    <div><h3>{t('investigation.token_clock',{defaultValue:'Token / issuer platform'})}</h3><p>{conventional?conventional.state.replaceAll('_',' '):t('investigation.token_no_clock',{defaultValue:'See the separately sourced hours below.'})}</p>{conventional?.current&&<p className="intel-analysis-caption">{conventional.current.name} · {interval(conventional.current)}</p>}
     {conventional&&<p className="intel-analysis-caption">{conventional.actualAvailability}</p>}
    </div>
    <div><h3>{t('investigation.redemption_clock',{defaultValue:'Issuer redemption'})}</h3><p>{t('investigation.redemption_unconfirmed',{defaultValue:'Terms recorded; executable availability unconfirmed.'})}</p><p className="intel-analysis-caption">{t('investigation.no_false_premium',{defaultValue:'No premium or discount is calculated without a dated per-token reference, aligned prices and matching units.'})}</p></div>
   </div>
   <p className="intel-analysis-caption">{t('investigation.independent_reviews',{defaultValue:'Each fact has its own source review date below and stays current until it is re-read or withdrawn. A newer review does not refresh the other documents.'})}</p>
   <RwaTerms key={`${subject}:${token.id}`} subject={subject} token={token} observations={review.facts} at={at} onPrepareReceipt={onPrepareReceipt}/>
   {onPrepareReceipt&&<button className="btn" onClick={()=>onPrepareReceipt(review.facts,token)}>Keep evidence in a research receipt</button>}
   <InvestigationTable rows={review.facts} pageSize={6} columns={[[t('investigation.issuer_fact',{defaultValue:'Issuer evidence'}),o=>o.metadata?.label],
    [t('investigation.recorded_summary',{defaultValue:'Recorded summary'}),o=><>{String(o.value??'')}{observationState(o,at)!=='known'&&<p>{t('investigation.fact_review_expired',{defaultValue:'Withdrawn by a later review'})}</p>}</>],
    [t('investigation.source_review',{defaultValue:'Source / review'}),o=><><a className="intel-text-link" href={safeSourceUrl(o.sourceUrl)||undefined} target="_blank" rel="noreferrer">Issuer source</a><details><summary className="cursor-pointer text-xs">Review history</summary><small className="block">Reviewed {time(o.observedAt)}<br/>Recorded {time(o.recordedAt)}<br/>{o.metadata?.withdrawnAt?<>Withdrawn {time(o.metadata.withdrawnAt)}</>:t('investigation.review_stays_current',{defaultValue:'Current until re-read or withdrawn'})}</small></details></>]]}/>
  </>}
 </section>
}
