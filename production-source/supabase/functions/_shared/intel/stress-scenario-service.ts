import {scenarioRules,scenarioInputs,validateStressScenario} from './stress-scenario-contract.ts'
import {stableJson} from './investigation-evidence.ts'
const uuid=(v:any)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
/** Read only the owner's numeric conditions. Personal prose and other users'
 * shared thesis content are not copied into this scenario artifact. */
export async function captureStressScenario(db:any,input:any,actor:{orgId:string;userId:string},subject:string,canonicalize:(value:string)=>string,now:number){
 if(!input||!uuid(input.thesisId))throw new Error('invalid_scenario_thesis')
 const {data:thesis,error}=await db.from('intel_theses').select('id,subject_canonical_key').eq('id',input.thesisId).eq('org_id',actor.orgId).eq('user_id',actor.userId).maybeSingle()
 if(error||!thesis)throw new Error('scenario_thesis_unavailable')
 if(canonicalize(thesis.subject_canonical_key)!==subject)throw new Error('scenario_asset_mismatch')
 const response=await db.from('intel_thesis_rules').select('id,metric,comparator,threshold,rule_kind,threshold_unit,time_window,source_metric').eq('thesis_id',thesis.id).eq('org_id',actor.orgId).eq('user_id',actor.userId).order('id').limit(51)
 if(response.error)throw new Error('scenario_rules_unavailable')
 const rules=scenarioRules(response.data||[])
 if(stableJson(rules)!==stableJson(scenarioRules(input.expectedRules)))throw new Error('scenario_conditions_changed_refresh_thesis')
 return validateStressScenario({schemaVersion:1,methodVersion:'stress-1',thesisId:thesis.id,subject,capturedAt:new Date(now).toISOString(),rules,...scenarioInputs(input,rules.map(r=>r.id))})
}
