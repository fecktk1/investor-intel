import React,{useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {readTweetEmbed} from '../lib/tweet-embed-api'
import {DRAWING_BOX_LIMITS} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'

const UNAVAILABLE=['chart.draw.tweet_unavailable','This post could not be read.']
const REASONS={
 tweet_not_found:['chart.draw.tweet_missing','This post no longer exists.'],
 tweet_refused:['chart.draw.tweet_refused','X did not release this post.'],
 invalid_tweet_url:['chart.draw.tweet_unknown','Post address missing'],
}
const DEFAULT_WIDTH=300
const clampBox=box=>({
 width:Math.round(Math.max(DRAWING_BOX_LIMITS.minWidth,Math.min(DRAWING_BOX_LIMITS.maxWidth,box.width))),
 height:Math.round(Math.max(DRAWING_BOX_LIMITS.minHeight,Math.min(DRAWING_BOX_LIMITS.maxHeight,box.height))),
})

/** The X mark, drawn here so the card never loads anything from X. */
const XMark=()=><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>

// A post from X anchored to a time and a price, laid out the way a post reads
// on X: the author's name over the handle beside a round avatar, the words at
// reading size, the posting time as the link to the post, the X mark in the
// corner. The address is all the drawing stores; the author and the text are
// read server side, and X provides no profile image through that reading, so
// the avatar carries the author's initial. A post that could not be read says
// so, so the card is never blank. The member's own note sits under the post in
// the drawing's colour. The card can be resized from its corner; the size is
// part of the drawing, so it survives a reload and travels with a share.
export default function ChartTweetCard({drawing,point,width,height,context,selected,readOnly,onSelect,onResize}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [post,setPost]=useState(null)
 const [draft,setDraft]=useState(null)
 const card=useRef(null),resizing=useRef(null)
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
 const author=post?.author||(handle?`@${handle}`:t('chart.draw.tweet_unknown',{defaultValue:'Post address missing'}))
 const initial=(post?.author||handle||'X').trim().charAt(0).toUpperCase()
 const box=draft||drawing.box||null
 const cardWidth=box?.width||DEFAULT_WIDTH
 // Anchored from the chart's coordinate conversion, clamped to the plot as it is
 // measured now, so an expanded or fullscreen chart keeps the card on screen.
 const left=Math.max(0,Math.min(Math.max(0,(width||0)-cardWidth-8),point.x+8))
 const top=Math.max(0,Math.min(Math.max(0,(height||0)-48),point.y-16))
 const [failureKey,failureText]=REASONS[post?.reason]||UNAVAILABLE
 const failure=post?.state==='unavailable'?t(failureKey,{defaultValue:failureText}):null
 const posted=post?.postedAt?new Date(post.postedAt):null
 // The corner handle: the pointer is captured by the handle itself, so the
 // surface never mistakes a resize for a drag of the anchor, and the size is
 // committed once, on release, as one undoable change.
 const startResize=event=>{
  if(readOnly||event.button!==0)return
  event.preventDefault();event.stopPropagation()
  const rect=card.current?.getBoundingClientRect()
  resizing.current={x:event.clientX,y:event.clientY,width:rect?.width||cardWidth,height:rect?.height||DRAWING_BOX_LIMITS.minHeight}
  event.currentTarget.setPointerCapture?.(event.pointerId)
 }
 const moveResize=event=>{
  const origin=resizing.current;if(!origin)return
  setDraft(clampBox({width:origin.width+event.clientX-origin.x,height:origin.height+event.clientY-origin.y}))
 }
 const endResize=event=>{
  const origin=resizing.current;if(!origin)return
  resizing.current=null
  event.currentTarget.releasePointerCapture?.(event.pointerId)
  const next=clampBox({width:origin.width+event.clientX-origin.x,height:origin.height+event.clientY-origin.y})
  setDraft(null)
  onResize?.(next)
 }
 return <article ref={card} className="intel-draw-tweet" data-selected={!!selected} style={{left,top,width:cardWidth,...(box?.height?{height:box.height}:{}),'--intel-draw-tweet-note':drawing.color}}
  onPointerDown={readOnly?undefined:onSelect}>
  <header className="intel-draw-tweet-head">
   <span className="intel-draw-tweet-avatar" aria-hidden="true">{initial}</span>
   <span className="intel-draw-tweet-who">
    <span className="intel-draw-tweet-author">{author}</span>
    {post?.author&&handle&&<span className="intel-draw-tweet-handle">@{handle}</span>}
   </span>
   <span className="intel-draw-tweet-mark"><XMark/></span>
  </header>
  <div className="intel-draw-tweet-body">
   {post?.state==='loading'&&<p className="intel-draw-tweet-text" role="status">{t('chart.draw.tweet_loading',{defaultValue:'Reading the post…'})}</p>}
   {post?.state==='ready'&&post.text&&<p className="intel-draw-tweet-text">{post.text}</p>}
   {failure&&<p className="intel-draw-tweet-text">{failure}</p>}
   {drawing.text&&<p className="intel-draw-tweet-note">{drawing.text}</p>}
  </div>
  <footer className="intel-draw-tweet-foot">
   {url&&<a href={url} target="_blank" rel="noreferrer noopener">{posted
    ?<time dateTime={post.postedAt}>{posted.toLocaleTimeString(undefined,{timeStyle:'short'})} · {posted.toLocaleDateString(undefined,{dateStyle:'medium'})}</time>
    :t('chart.draw.tweet_open',{defaultValue:'Open the post on X'})}</a>}
  </footer>
  {!readOnly&&selected&&<button type="button" className="intel-draw-tweet-resize" aria-label={t('chart.draw.tweet_resize',{defaultValue:'Resize the post card'})}
   onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}/>}
 </article>
}
