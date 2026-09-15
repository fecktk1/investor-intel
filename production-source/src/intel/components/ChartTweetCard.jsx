import React from 'react'
import {useTranslation} from 'react-i18next'

// A post from X anchored to a time and a price. The card is plain HTML over the
// chart: the address is all the drawing stores, so the handle it already contains
// is shown even before anything is read from the network.
export default function ChartTweetCard({drawing,point,width,selected,readOnly,onSelect}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const handle=drawing.url?drawing.url.split('/')[3]:''
 const left=Math.max(0,Math.min((width||0)-232,point.x+8))
 return <article className="intel-draw-tweet" data-selected={!!selected} style={{left,top:Math.max(0,point.y-16),borderColor:drawing.color}}
  onPointerDown={readOnly?undefined:onSelect}>
  <span className="intel-draw-tweet-author">{handle?`@${handle}`:t('chart.draw.tweet_unknown',{defaultValue:'Post address missing'})}</span>
  {drawing.text&&<p className="intel-draw-tweet-note">{drawing.text}</p>}
  {drawing.url&&<a href={drawing.url} target="_blank" rel="noreferrer noopener">{t('chart.draw.tweet_open',{defaultValue:'Open the post on X'})}</a>}
 </article>
}
