import {finite} from './investigation-evidence.ts'
/** Descriptive engagement/noise scoring, never trading performance. A partial
 * or failed history read cannot improve a rule's previous score. */
export async function scoreRuleQuality(admin:any,rules:any[],now=Date.now()){
 const staleBefore=new Date(now-86400000).toISOString(),due=rules.filter(r=>!r.last_quality_at||r.last_quality_at<staleBefore).slice(0,100)
 const result={tuned:0,failed:0,incomplete:0}
 if(!due.length)return result
 try{
  const {data:events,error}=await admin.from('intel_alert_events').select('rule_id,fired_at,read_at,payload').in('rule_id',due.map(r=>r.id)).gte('fired_at',new Date(now-14*86400000).toISOString()).lte('fired_at',new Date(now).toISOString()).order('fired_at',{ascending:true}).order('id').limit(2001)
  if(error||!Array.isArray(events)){result.failed=due.length;return result}
  if(events.length>2000){result.incomplete=due.length;return result}
  const byRule=new Map<string,any[]>()
  for(const event of events){const list=byRule.get(event.rule_id)||[];list.push(event);byRule.set(event.rule_id,list)}
  for(const rule of due){
   const rows=byRule.get(rule.id)||[],fires=rows.length,opened=rows.filter(e=>e.read_at).length,openRate=fires?opened/fires:1
   let nearDuplicates=0
   for(let i=1;i<rows.length;i++){const a=finite(rows[i-1].payload?.value),b=finite(rows[i].payload?.value);if(a!=null&&b!=null&&Math.abs(a-b)<=Math.abs(a)*.1)nearDuplicates++}
   const score=Math.max(0,Math.min(100,100-Math.min(50,fires*3.5)-Math.min(25,nearDuplicates*5)-Math.round((1-openRate)*20))),noisy=score<40
   let suggested:any={}
   if(noisy&&['price_move','volume_spike'].includes(rule.trigger_type)&&fires>=3){
    const values=rows.map(e=>finite(e.payload?.value)).filter((v):v is number=>v!=null).map(Math.abs).sort((a,b)=>a-b)
    if(values.length>=3){const percentile=values[Math.min(values.length-1,Math.floor(values.length*.75))],threshold=finite(rule.config?.threshold_pct);if(threshold!=null&&Math.ceil(percentile)>threshold)suggested={threshold_pct:Math.ceil(percentile),reason:'Recent firings often meet a similar level. Review this higher threshold before applying it.'}}
   }
   let query=admin.from('intel_alert_rules').update({quality_score:score,noisy,suggested_config:suggested,last_quality_at:new Date(now).toISOString()}).eq('id',rule.id).eq('org_id',rule.org_id)
   if(rule.chart_revision!=null)query=query.eq('chart_revision',rule.chart_revision)
   const saved=await query.select('id').maybeSingle()
   if(saved.error)result.failed++;else if(saved.data)result.tuned++
  }
 }catch{result.failed=Math.max(1,due.length-result.tuned)}
 return result
}
