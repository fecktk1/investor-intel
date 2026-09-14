import type {Observation} from './investigation-evidence.ts'
/** Coalesce an old aggregate identity only when an equivalent, declared
 * interval/event was already known. Never mutate stored records or receipts. */
export function projectDexEvidence<T extends Observation>(rows:T[],at=Date.now()):T[]{
 const preferred=new Set<string>()
 const key=(o:T)=>JSON.stringify([o.subject,o.metric,o.unit,o.value,o.observedAt,o.metadata?.intervalStart,o.metadata?.intervalEnd,o.metadata?.transaction,o.metadata?.logIndex])
 const supported=(o:T)=>o.provider==='coinmarketcap'&&/^coinmarketcap:\/v1\/dex\/(holders\/trend\/list|liquidity-change\/list|tokens\/transactions):/.test(o.sourceRef||'')
 const declared=(o:T)=>/:interval:|:event:/.test(o.universe||'')
 for(const o of rows)if(supported(o)&&declared(o)&&Date.parse(o.recordedAt)<=at)preferred.add(key(o))
 return rows.filter(o=>!supported(o)||declared(o)||!preferred.has(key(o)))
}
/** Round-robin whole records: a longer history cannot erase another metric's
 * citation from a compact Compare or portfolio research projection. */
export function contractEvidencePreview(rows:Observation[],limit=6):Observation[]{
 const groups=new Map<string,Observation[]>()
 for(const o of rows){const group=groups.get(o.metric)||[];group.push(o);groups.set(o.metric,group)}
 const out:Observation[]=[]
 for(let index=0;out.length<limit;index++){
  let added=false
  for(const group of groups.values())if(group[index]&&out.length<limit){out.push(group[index]);added=true}
  if(!added)break
 }
 return out
}
