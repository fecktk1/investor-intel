import React from 'react'

// Standalone replacement for the product's anchored post card.
//
// The card's layout is pure and is carried faithfully: the same class names, the
// same clamping of the card to the plot as it is measured right now, the author
// taken from the address, the member's own note under the post in the drawing's
// colour. What cannot be carried is the post itself. Reading one goes through
// tweet-embed-api, which invokes the 'intel-tweet-embed' edge function with a
// Supabase client and an org id; the browser never calls X directly, and this
// package has no server side to read through. So the card renders and says so,
// rather than sitting on 'Reading the post…' forever or, worse, borrowing one of
// the product's real refusal reasons and claiming X declined to release it.
//
// Resizing is left out because the size is a stored property of the drawing, and
// there is nothing here to store it in.
const REASON='Reading posts from X needs the Investor Intel workspace, which this standalone package does not carry.'
const DEFAULT_WIDTH=300
export default function ChartTweetCard({drawing,point,width,height,selected,readOnly,onSelect,options=null}) {
 const url=drawing.url||''
 const handle=url.split('/')[3]||''
 const author=handle?`@${handle}`:'Post address missing'
 const initial=(handle||'X').trim().charAt(0).toUpperCase()
 const cardWidth=drawing.box?.width||DEFAULT_WIDTH
 const left=Math.max(0,Math.min(Math.max(0,(width||0)-cardWidth-8),point.x+8))
 const top=Math.max(0,Math.min(Math.max(0,(height||0)-48),point.y-16))
 return <article className="intel-draw-tweet" data-selected={!!selected}
  style={{left,top,width:cardWidth,...(drawing.box?.height?{height:drawing.box.height}:{}),'--intel-draw-tweet-note':drawing.color}}
  onPointerDown={readOnly?undefined:onSelect}>
  <header className="intel-draw-tweet-head">
   <span className="intel-draw-tweet-avatar" aria-hidden="true">{initial}</span>
   <span className="intel-draw-tweet-who"><span className="intel-draw-tweet-author">{author}</span></span>
  </header>
  <div className="intel-draw-tweet-body">
   <p className="intel-draw-tweet-text" role="status">{REASON}</p>
   {drawing.text&&<p className="intel-draw-tweet-note">{drawing.text}</p>}
  </div>
  <footer className="intel-draw-tweet-foot">{url&&<a href={url} target="_blank" rel="noreferrer noopener">Open the post on X</a>}</footer>
  {options||null}
 </article>
}
