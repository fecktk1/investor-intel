export const CHART_OUTCOME_VERSION='outcome-1'
export type OutcomeSpec={direction:'long'|'short';trigger:'close_above'|'close_below'|'touch';entry:number;stop:number;target:number|null;quantity:number;feeBps:number;slippageBps:number;start:number}
export type SavedOutcomeAssumptions={version:'outcome-1';spec:OutcomeSpec;at:number;intervalMs:number;knownOnly:boolean;source:string}
const positive=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>0
export function validateOutcomeSpec(spec:OutcomeSpec){
 if(!spec||!['long','short'].includes(spec.direction)||!['close_above','close_below','touch'].includes(spec.trigger)
  ||!positive(spec.entry)||spec.entry>1e18||!positive(spec.stop)||spec.stop>1e18||!positive(spec.quantity)||!Number.isSafeInteger(spec.start)||spec.start<0||spec.start>4102444800000
  ||spec.target!=null&&(!positive(spec.target)||spec.target>1e18)
  ||![spec.feeBps,spec.slippageBps].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1000))throw Error('Enter positive prices and quantity, a valid start time, and costs from 0 to 1000 basis points.')
 const sign=spec.direction==='long'?1:-1
 if((spec.entry-spec.stop)*sign<=0||spec.target!=null&&(spec.target-spec.entry)*sign<=0)throw Error('Place the stop beyond the entry in the loss direction and the optional target in the gain direction.')
 if(!Number.isFinite(spec.entry*spec.quantity)||!Number.isFinite(spec.stop*spec.quantity)||spec.target!=null&&!Number.isFinite(spec.target*spec.quantity))throw Error('The price and quantity exceed the supported calculation range.')
 return {direction:spec.direction,trigger:spec.trigger,entry:spec.entry,stop:spec.stop,target:spec.target??null,quantity:spec.quantity,feeBps:spec.feeBps,slippageBps:spec.slippageBps,start:spec.start}
}
export function validateSavedOutcome(value:any):SavedOutcomeAssumptions{
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==CHART_OUTCOME_VERSION||!Number.isSafeInteger(value.at)||value.at<0||value.at>4102444800000||!Number.isSafeInteger(value.intervalMs)||value.intervalMs<1000||value.intervalMs>366*86400000||typeof value.knownOnly!=='boolean'||typeof value.source!=='string'||!value.source.trim()||value.source.length>120||/[\u0000-\u001f]/.test(value.source))throw Error('invalid_chart_outcome_assumptions')
 const spec=validateOutcomeSpec(value.spec);if(spec.start>value.at)throw Error('invalid_chart_outcome_assumptions')
 return {version:CHART_OUTCOME_VERSION,spec,at:value.at,intervalMs:value.intervalMs,knownOnly:value.knownOnly,source:value.source}
}
