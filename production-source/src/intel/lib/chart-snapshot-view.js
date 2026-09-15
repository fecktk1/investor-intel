// Do not accept a stale refresh response whose source-price deadline has passed.
// Authored text and original integrity hashes are unaffected by this projection.
export function restrictExpiredSnapshot(snapshot,now=Date.now()){
 const state=snapshot.state,until=snapshot.availability?.retainUntil
 if(!until||until>now)return snapshot
 const comparisonSeries=state.comparisonSeries?.map(s=>({...s,bars:s.availability?.retainUntil>now?s.bars:null}))
 const remaining=comparisonSeries?.filter(s=>s.bars?.length)||[]
 return {...snapshot,state:{...state,bars:null,...(comparisonSeries?{comparisonSeries}: {})},
  availability:{...snapshot.availability,prices:remaining.length>0,availableSources:remaining.length,export:false,retainUntil:remaining.length?Math.min(...remaining.map(s=>s.availability.retainUntil)):null},
  viewRestrictions:['This saved price capture has expired. Your notes and original source fingerprints remain available.']}
}
export function restrictExpiredSharedSnapshot(snapshot,now=Date.now()){
 if(!snapshot.retainUntil||snapshot.retainUntil>now)return snapshot
 const checked=restrictExpiredSnapshot({state:snapshot,availability:{retainUntil:snapshot.retainUntil}},now)
 return {...checked.state,retainUntil:checked.availability.retainUntil,gaps:checked.viewRestrictions}
}
