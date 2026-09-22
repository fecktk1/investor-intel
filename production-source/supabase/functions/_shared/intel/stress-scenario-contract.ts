export const STRESS_BASES:Record<string,{label:string;metric:string;unit:string;periodSeconds?:number}>={
 price:{label:'Price (USD)',metric:'price',unit:'USD'},
 price_1h:{label:'Price change over 1 hour (%)',metric:'price_change',unit:'%',periodSeconds:3600},
 price_24h:{label:'Price change over 24 hours (%)',metric:'price_change',unit:'%',periodSeconds:86400},
 price_7d:{label:'Price change over 7 days (%)',metric:'price_change',unit:'%',periodSeconds:604800},
 volume_24h:{label:'Volume change over 24 hours (%)',metric:'volume_change',unit:'%',periodSeconds:86400},
 tvl_24h:{label:'TVL change over 24 hours (%)',metric:'tvl_change',unit:'%',periodSeconds:86400},
}
const object=(value:any)=>value!=null&&typeof value==='object'&&!Array.isArray(value)
const text=(value:any,max=80)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f]/.test(value)
const number=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e18
export function scenarioRules(value:any[]){
 if(!Array.isArray(value)||value.length>50)throw new Error('scenario_rule_limit')
 const rows=value.map(r=>{
  if(!object(r)||!text(r.id)||!r.id||['__proto__','prototype','constructor'].includes(r.id)||!text(r.metric??'')||!text(r.comparator??'',12)||r.threshold!=null&&(!['number','string'].includes(typeof r.threshold)||String(r.threshold).trim()===''||!number(Number(r.threshold))))throw new Error('invalid_scenario_rule')
  if(r.unit!=null&&!text(r.unit)||r.periodSeconds!=null&&(!Number.isSafeInteger(r.periodSeconds)||r.periodSeconds<=0)||r.threshold_unit!=null&&!text(r.threshold_unit)||r.time_window!=null&&!text(r.time_window)||r.source_metric!=null&&!text(r.source_metric))throw new Error('invalid_scenario_rule')
  return {id:r.id,metric:r.metric??'',comparator:r.comparator??'',threshold:r.threshold==null?null:Number(r.threshold),rule_kind:['confirmation','invalidation'].includes(r.rule_kind)?r.rule_kind:null,
   ...(r.unit!=null?{unit:r.unit}:{}),...(r.periodSeconds!=null?{periodSeconds:r.periodSeconds}:{}),threshold_unit:r.threshold_unit??null,time_window:r.time_window??null,source_metric:r.source_metric??null}
 }).sort((a,b)=>a.id.localeCompare(b.id))
 if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('duplicate_scenario_rule')
 return rows
}
export function scenarioInputs(value:any,ids:string[]){
 if(!object(value)||!object(value.bases??{})||!object(value.overrides??{}))throw new Error('invalid_scenario_parameters')
 const bases:Record<string,string>={},overrides:Record<string,number>={}
 for(const [key,basis]of Object.entries(value.bases??{})){if(!ids.includes(key)||typeof basis!=='string'||!Object.hasOwn(STRESS_BASES,basis))throw new Error('invalid_scenario_basis');bases[key]=basis}
 for(const [key,amount]of Object.entries(value.overrides??{})){if(!ids.includes(key)||!number(amount))throw new Error('invalid_scenario_override');overrides[key]=amount as number}
 const focusRule=value.focusRule??null;if(focusRule!=null&&!ids.includes(focusRule))throw new Error('invalid_scenario_focus')
 return {bases,overrides,focusRule}
}
export function validateStressScenario(value:any){
 if(!object(value)||value.schemaVersion!==1||value.methodVersion!=='stress-1'||!text(value.thesisId)||!value.thesisId||!text(value.subject,240)||!value.subject||!text(value.capturedAt)||!Number.isFinite(Date.parse(value.capturedAt))||JSON.stringify(value).length>50000)throw new Error('invalid_saved_scenario')
 const rules=scenarioRules(value.rules),inputs=scenarioInputs(value,rules.map(r=>r.id))
 return {schemaVersion:1 as const,methodVersion:'stress-1' as const,thesisId:value.thesisId,subject:value.subject,capturedAt:value.capturedAt,rules,...inputs}
}
export type StressScenario=ReturnType<typeof validateStressScenario>
