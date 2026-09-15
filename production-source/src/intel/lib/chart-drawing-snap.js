// Anchor precision helpers for chart drawings. Both work in time/price space and
// return `null` when nothing is close enough, so a caller keeps the raw pointer
// anchor rather than inventing a bar that was never observed.

// Index of the observed bar closest in time to `t`. Bars are ascending by time.
export function nearestBarIndex(bars,t) {
 if(!Array.isArray(bars)||!bars.length||!Number.isFinite(t))return -1
 let low=0,high=bars.length-1
 while(low<high){const mid=(low+high)>>1;if(bars[mid].t<t)low=mid+1;else high=mid}
 const before=low>0?low-1:0
 return Math.abs(bars[before].t-t)<=Math.abs(bars[low].t-t)?before:low
}

// Snap a time to the candle it falls on. `limit` keeps a pointer far outside the
// observed history (a drawing in the future, say) on its own exact timestamp.
export function snapAnchorTime(anchor,bars,intervalMs=null) {
 const index=nearestBarIndex(bars,anchor?.t)
 if(index<0)return anchor
 const limit=Number.isFinite(intervalMs)&&intervalMs>0?intervalMs:Infinity
 return Math.abs(bars[index].t-anchor.t)<=limit?{...anchor,t:bars[index].t}:anchor
}

const FIELDS=['o','h','l','c']
// Pull an anchor onto the open, high, low or close it is already hovering, but
// only while the pointer is within `tolerance` screen pixels of that exact value.
export function magnetAnchor(anchor,point,bars,project,tolerance=8) {
 const index=nearestBarIndex(bars,anchor?.t)
 if(index<0||typeof project!=='function'||!point)return null
 let best=null
 for(let i=Math.max(0,index-2);i<=Math.min(bars.length-1,index+2);i++){
  for(const field of FIELDS){
   const price=bars[i][field]
   if(!Number.isFinite(price)||price<=0)continue
   const screen=project({t:bars[i].t,price})
   if(!screen||!Number.isFinite(screen.x)||!Number.isFinite(screen.y))continue
   const distance=Math.hypot(screen.x-point.x,screen.y-point.y)
   if(distance<=tolerance&&(!best||distance<best.distance))best={distance,anchor:{t:bars[i].t,price}}
  }
 }
 return best?.anchor||null
}

// One entry point for the pointer path: magnet first, then candle-time snapping.
export function resolveAnchor(anchor,point,{bars=[],intervalMs=null,magnet=false,snap=true,project=null}={}) {
 if(!anchor)return anchor
 if(magnet){const pulled=magnetAnchor(anchor,point,bars,project);if(pulled)return pulled}
 return snap?snapAnchorTime(anchor,bars,intervalMs):anchor
}
