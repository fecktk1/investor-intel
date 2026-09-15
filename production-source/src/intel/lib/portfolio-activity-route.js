const DAY=86400000
const periods=[['7D',7],['1M',30],['3M',90],['6M',180],['1Y',365]]

export function portfolioActivityRoute(portfolioId,canonicalAssetKey,item) {
 const path=`/intel/portfolio/${encodeURIComponent(portfolioId)}/asset/${encodeURIComponent(canonicalAssetKey)}`
 const at=Date.parse(item?.timestamp),event=item?.manualGroupId?`pair:${item.manualGroupId}`:item?.eventKey||`${item?.kind}:${item?.id}`
 if(!Number.isFinite(at)||at<=0||!validEventKey(event))return path
 return path+'?'+new URLSearchParams({at:String(at),event})
}

export function validEventKey(key) {return typeof key==='string'&&/^(manual|grouped|pair):[a-zA-Z0-9-]{1,80}$/.test(key)}

export function activityChartWindow(search,now) {
 const params=new URLSearchParams(search),value=params.get('at'),at=value&&/^\d{1,16}$/.test(value)?Number(value):NaN,key=params.get('event')
 if(!Number.isSafeInteger(at)||at<=0||at>now||!validEventKey(key))return {range:'7D',year:0,at:null,event:null}
 const age=(now-at)/DAY,year=Math.floor(age/365)
 return {range:year>0?'1Y':(periods.find(([,days])=>age<days-1/24)?.[0]||'1Y'),year,at,event:key}
}

export function activityMarkerFor(markers,event) {
 if(!validEventKey(event))return null
 return (markers||[]).find(marker=>marker.group==='portfolio'&&(marker.event?.eventKey===event||(event.startsWith('pair:')&&marker.event?.manualGroupId===event.slice(5))))||null
}
