// Standalone replacement for the product's chart working-state module.
//
// The product version autosaves a member's workspace through Supabase and needs a
// client plus user, org and asset identity (see usableChartContext there), none of
// which this package carries. TokenChart imports exactly one symbol from it, and
// that symbol is pure: the draft store holds no identity, reaches no network and
// persists nothing. So this adapter carries a faithful copy rather than a refusal,
// and the chart behaves here exactly as it does in the product, minus the saving.
//
// If TokenChart ever imports more of that module, the extraction guard in
// scripts/package-investor-intel-demo.mjs will fail on the new symbol rather than
// letting backend coupling reach this package quietly. That failure is the point.
export function workingDraftStore() {
 let value=null
 const listeners=new Set()
 return {get:()=>value,set:next=>{value=next;for(const listener of listeners)listener(next)},subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)}}
}
