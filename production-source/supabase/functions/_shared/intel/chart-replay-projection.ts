/** Apply the saved knowledge boundary at capture, read and export boundaries. */
export function replayBars<T extends {t:number;o?:number|null;closedAt?:number|null;recordedAt?:number|null}>(bars:T[],replay?:{at:number;knownOnly:boolean}):T[]{
 if(!replay)return bars
 if(!Number.isFinite(replay.at))return []
 return bars.filter(b=>{
  const close=b.closedAt??(b.o==null?b.t:null)
  return close!=null&&Number.isFinite(close)&&close<=replay.at&&(!replay.knownOnly||b.recordedAt!=null&&Number.isFinite(b.recordedAt)&&b.recordedAt<=replay.at)
 })
}
