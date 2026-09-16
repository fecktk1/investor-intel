import React,{useState} from 'react'
import {useTranslation} from 'react-i18next'
import {rwaTermsProjection} from '../../../supabase/functions/_shared/intel/rwa-terms.ts'
const number=v=>Number(v).toLocaleString(undefined,{maximumFractionDigits:8})
const units={fine_troy_ounce:'fine troy ounces',gram_gold_minimum_999_purity:'grams of gold (minimum 999 purity)',share:'shares'}
/** Explicit research quantity; never reads or changes a holding. Saved arithmetic
 * is an append-only draft note, with the source observations in its receipt. */
export default function RwaTerms({subject,token,observations,at,onPrepareReceipt}){
 const {t}=useTranslation('intel',{useSuspense:false}),[quantity,setQuantity]=useState('')
 const result=rwaTermsProjection(observations,subject,token.id,at,quantity),unit=units[result.denomination?.underlyingUnit]||result.denomination?.underlyingUnit
 // No structured terms recorded for this token: a stated state with the review
 // cadence rather than a missing panel. Issuer terms come from editorial source
 // reviews, not from a capture job, so the cadence is the review cycle.
 if(!result.facts.length)return <p role="status" className="intel-analysis-caption my-3">{t('investigation.terms_not_recorded',{defaultValue:'No unit or redemption terms have been recorded for this token yet. Issuer sources are re-read on a five-day review cycle, and the evidence table below lists what is recorded.'})}</p>
 const notes=[`Research quantity: ${result.quantity} ${token.name} (CMC ${token.id}).`,result.underlyingUnits==null?'Underlying units unavailable: a dated per-token multiplier is required.':`Documented denomination: ${result.underlyingUnits} ${unit}.`,result.redemption?.threshold?`Recorded redemption minimum: ${result.redemption.minimum} tokens; quantity shortfall ${result.redemption.threshold.shortfall}. Fees and issuer eligibility are separate.`:result.redemption?`Recorded redemption minimum: ${result.redemption.minimum} ${result.redemption.minimumUnit}; no executable quote or eligibility is established.`:'No reviewed redemption threshold is available.',`Calculated from source evidence known by ${new Date(at).toISOString()}. This is unit arithmetic, not valuation or an execution quote.`].join('\n')
 return <section aria-label={t('investigation.terms_calculation',{defaultValue:'Token units and redemption conditions'})} className="py-3 border-y border-[var(--border-default)] my-3">
  <div className="flex flex-wrap items-end gap-4"><label className="intel-inline-field">{t('investigation.research_quantity',{defaultValue:'Research quantity (tokens)'})}<input type="number" min="0" step="any" inputMode="decimal" className="input" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><p className="text-sm">{t('investigation.quantity_scope',{defaultValue:'A quantity to investigate. Your holdings are unchanged.'})}</p></div>
  {result.state!=='reviewed'?<p role="status">{t('investigation.terms_expired',{defaultValue:'These terms need a new source review before calculating.'})}</p>:<>
   <p className="my-2">{result.underlyingUnits!=null?<><strong className="font-mono">{number(result.underlyingUnits)}</strong> {unit}</>:result.denomination?.variable?t('investigation.multiplier_missing',{defaultValue:'Underlying shares unavailable: this token needs a dated share multiplier.'}):t('investigation.quantity_prompt',{defaultValue:'Enter a quantity to calculate its documented underlying units.'})}</p>
   {result.redemption&&<p className="text-sm">{t('investigation.redemption_minimum',{defaultValue:'Recorded redemption minimum'})}: {number(result.redemption.minimum)} {result.redemption.minimumUnit}.{result.redemption.threshold&&<> {result.redemption.threshold.meetsQuantity?t('investigation.threshold_met',{defaultValue:'The quantity threshold is met; fees, delivery and eligibility still apply.'}):`${t('investigation.threshold_shortfall',{defaultValue:'Quantity below the threshold'})}: ${number(result.redemption.threshold.shortfall)}.`}</>}</p>}
   <p className="intel-analysis-caption">{t('investigation.terms_scope',{defaultValue:'Source terms describe units and conditions. They do not establish current reserves, value, executable redemption or your eligibility.'})}</p>
   {onPrepareReceipt&&<button type="button" className="btn" disabled={result.quantity==null} onClick={()=>onPrepareReceipt(observations,token,notes)}>{t('investigation.keep_calculation',{defaultValue:'Keep calculation and sources in a receipt'})}</button>}
  </>}
 </section>
}
