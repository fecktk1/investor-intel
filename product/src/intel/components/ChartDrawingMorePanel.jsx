import React from 'react'

// The body of the drawing toolbar's More disclosure: the tools that did not fit
// in two rows, each by name and icon. Deferred, so a chart that never runs out
// of room never pays for it. The button that opens it stays in the strip.
export default function ChartDrawingMorePanel({id,items,onPress}) {
 return <div id={id} className="intel-draw-more-panel">
  {items.map(entry=><button key={entry.id} type="button" className="intel-draw-more-item" aria-pressed={entry.pressed} disabled={entry.disabled} onClick={()=>onPress(entry)}>
   <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d={entry.icon} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
   <span>{entry.label}</span>
  </button>)}
 </div>
}
