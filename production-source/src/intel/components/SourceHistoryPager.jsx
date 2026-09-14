import React,{useState} from 'react'
import {useMarketResearch} from '../lib/useMarketResearch'
import {useSupabase} from '../../lib/useSupabase'
import {useProfile} from '../../lib/profile-context'

export default function SourceHistoryPager({history,children}){
 const {user}=useSupabase(),{org}=useProfile()
 return <Pages key={`${user?.id}:${org?.id}:${history.subject}:${history.family}:${history.knownAt}:${history.versions?.[0]?.id}`} history={history}>{children}</Pages>
}
function Pages({history,children}){
 const [cursors,setCursors]=useState([]),cursor=cursors.at(-1)
 const q=useMarketResearch('sourceHistory',{subject:history.subject,family:history.family,cursor:cursor||null,limit:25},!!cursor)
 const page=cursor?q.result:history
 return <>
  {q.loading?<p role="status">Loading earlier retained source responses…</p>:q.error?<p role="alert">Source history could not be read. <button className="intel-text-link" onClick={q.refresh}>Retry source history</button></p>:page&&children(page)}
  <div className="intel-investigation-pagination" aria-label="Source history pages">
   <button className="btn" disabled={!cursors.length||q.loading} onClick={()=>setCursors(rows=>rows.slice(0,-1))}>Previous source page</button>
   <span>Source page {cursors.length+1} · up to 25 responses per additional page</span>
   <button className="btn" disabled={q.loading||!page?.nextCursor||cursors.includes(page.nextCursor)} onClick={()=>setCursors(rows=>[...rows,page.nextCursor])}>Earlier source responses</button>
  </div>
 </>
}
