import React,{useEffect,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {readTweetEmbed} from '../lib/tweet-embed-api'

const UNAVAILABLE=['chart.draw.tweet_unavailable','This post could not be read.']
const REASONS={
 tweet_not_found:['chart.draw.tweet_missing','This post no longer exists.'],
 tweet_refused:['chart.draw.tweet_refused','X did not release this post.'],
 invalid_tweet_url:['chart.draw.tweet_unknown','Post address missing'],
}

// A post from X anchored to a time and a price. The address is all the drawing
// stores; the author and the text are read server side. A post that could not be
// read says so, so the card is never blank.
export default function ChartTweetCard({drawing,point,width,height,context,selected,readOnly,onSelect}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [post,setPost]=useState(null)
 const url=drawing.url||''
 useEffect(()=>{
  if(!url){setPost(null);return}
  let alive=true
  const controller=new AbortController()
  setPost({state:'loading'})
  readTweetEmbed(context,url,{signal:controller.signal}).then(result=>{if(alive)setPost(result)}).catch(()=>{})
  return()=>{alive=false;controller.abort()}
 },[url,context?.orgId]) // eslint-disable-line react-hooks/exhaustive-deps
 const handle=post?.handle||url.split('/')[3]||''
 // Anchored from the chart's coordinate conversion, clamped to the plot as it is
 // measured now, so an expanded or fullscreen chart keeps the card on screen.
 const left=Math.max(0,Math.min(Math.max(0,(width||0)-232),point.x+8))
 const top=Math.max(0,Math.min(Math.max(0,(height||0)-48),point.y-16))
 const [failureKey,failureText]=REASONS[post?.reason]||UNAVAILABLE
 const failure=post?.state==='unavailable'?t(failureKey,{defaultValue:failureText}):null
 return <article className="intel-draw-tweet" data-selected={!!selected} style={{left,top,borderLeftColor:drawing.color}}
  onPointerDown={readOnly?undefined:onSelect}>
  <span className="intel-draw-tweet-author">{post?.author||(handle?`@${handle}`:t('chart.draw.tweet_unknown',{defaultValue:'Post address missing'}))}</span>
  {post?.author&&handle&&<span className="intel-draw-tweet-handle">@{handle}</span>}
  {post?.state==='loading'&&<p className="intel-draw-tweet-text" role="status">{t('chart.draw.tweet_loading',{defaultValue:'Reading the post…'})}</p>}
  {post?.state==='ready'&&post.text&&<p className="intel-draw-tweet-text">{post.text}</p>}
  {failure&&<p className="intel-draw-tweet-text">{failure}</p>}
  {post?.postedAt&&<time dateTime={post.postedAt}>{new Date(post.postedAt).toLocaleDateString(undefined,{dateStyle:'medium'})}</time>}
  {drawing.text&&<p className="intel-draw-tweet-note">{drawing.text}</p>}
  {url&&<a href={url} target="_blank" rel="noreferrer noopener">{t('chart.draw.tweet_open',{defaultValue:'Open the post on X'})}</a>}
 </article>
}
