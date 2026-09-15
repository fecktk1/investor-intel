// Research-journal arithmetic only. The portfolio ledger remains authoritative.
export function journalExitResult(trade, {entry, exit, fees = 0, fraction = 1} = {}) {
  const size = Number(trade?.size_usd ?? trade?.planned_size_usd)
  const e = Number(entry), x = Number(exit), fee = Number(fees), part = Number(fraction)
  if (![size,e,x,fee,part].every(Number.isFinite) || size<=0 || e<=0 || x<=0 || fee<0 || part<=0 || part>1) return {pnlUsd:null,pnlPct:null,r:null}
  const gain = ((trade.direction==='short' ? e-x : x-e)/e)*size*part-fee
  const stop=Number(trade.planned_stop)
  return {pnlUsd:Math.round(gain*1e8)/1e8,pnlPct:Math.round(gain/(size*part)*100*1e8)/1e8,
    r:stop>0 && stop!==e ? gain/(Math.abs(e-stop)/e*size*part) : null}
}
export function isRecordedJournalExecution(event) {
  return event?.status==='success' && Number.isFinite(event.t) && event.portfolioId && event.sourceRef?.id
    && ['grouped','manual'].includes(event.sourceRef.kind) && ['buy','sell','swap'].includes(event.type)
}
