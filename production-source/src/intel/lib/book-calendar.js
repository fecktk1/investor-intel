export function calendarInstant(event) {
  if (event.time_precision !== 'instant') return null
  const time=Date.parse(event.scheduled_at)
  return Number.isFinite(time)?time:null
}
export function calendarGroups(events,from,to,width=800) {
  const rows=events.map(event=>({event,time:calendarInstant(event)})).filter(row=>row.time!==null&&row.time>=from&&row.time<=to).sort((a,b)=>a.time-b.time||a.event.id.localeCompare(b.event.id))
  const groups=[]
  for(const row of rows) { const x=(row.time-from)/(to-from)*100,last=groups.at(-1);if(last&&(x-last.x)/100*width<24)last.rows.push(row);else groups.push({x,rows:[row]}) }
  return groups
}
export async function loadBookCalendar(supabase,{orgId,portfolioId=null,watchlistId=null,asset=null,from,to,knownAt,page=0,includeInactive=false}) {
  const {data,error}=await supabase.rpc('intel_book_calendar',{p_org_id:orgId,p_portfolio_id:portfolioId,p_watchlist_id:watchlistId,p_asset:asset,p_from:new Date(from).toISOString(),p_to:new Date(to).toISOString(),p_known_at:new Date(knownAt).toISOString(),p_page:page,p_include_inactive:includeInactive})
  if(error)throw error
  if(!Array.isArray(data?.rows))throw Error('Calendar evidence could not be read.')
  return data
}
