// How big one MCP tool result is allowed to be, and the helpers that keep it there.
//
// Every tool ARGUMENT is bounded by its schema (mcp-schema.ts). A result is not an
// argument, which is how a series once escaped: rwa_universe returned 1,400 points
// and 520 KB in one call, roughly 130 thousand tokens of a member's context window.
// The rules below are the whole of the result-size contract, and the test in
// mcp-tools.test.ts (`a single tool result must stay readable`) pins the ceiling:
// JSON.stringify of the whole tool result under 120,000 bytes. The payload travels
// twice in that result (as structuredContent and as the text block), so a payload
// has to stay under about half of it; RESULT_BYTE_BUDGET is that half with room.

/** How many points of a series one tool result may carry.
 *
 * WHY THIS EXISTS. The read modules cap themselves at what a chart on the web page
 * needs (400 regime points, 200 per RWA asset type across seven types), which is
 * right for a canvas and far too much for a conversation. Measured against
 * production: rwa_universe at days=30 returned 1400 points, 520 KB on the wire.
 * The trim is an even-stride downsample that keeps the first and last observation,
 * so the WINDOW the caller asked for is still the window they get, and the note
 * says how many points the series really had. */
export const SERIES_POINT_CAP=60

/** How many points an answer carrying SEVERAL series may add up to.
 *
 * A per-series cap alone does not bound an ANSWER. rwa_universe returns one series
 * per asset type, so a 60-point cap became 7 x 60 = 420 points: measured against
 * production after the first fix, 180 KB. A shared budget is what actually bounds
 * it: an eighth type makes each series shorter rather than making the answer
 * bigger. The floor keeps a small number of series readable. */
export const SERIES_TOTAL_CAP=180
export const SERIES_MIN_PER_GROUP=12

/** Serialised bytes one tool PAYLOAD may reach before the last-resort trim in
 * fitToBudget runs. Half the tested 120,000-byte result ceiling less headroom,
 * because the payload is carried twice in one result. */
export const RESULT_BYTE_BUDGET=50_000

/** The per-series allowance when an answer carries `groups` of them. */
export function perGroupCap(groups:number,total=SERIES_TOTAL_CAP):number {
 if(groups<=1)return SERIES_POINT_CAP
 return Math.max(SERIES_MIN_PER_GROUP,Math.min(SERIES_POINT_CAP,Math.floor(total/groups)))
}

/** Even-stride downsample, first and last observation always kept.
 *
 * Deliberately a copy of the shape capture-read.ts uses rather than a call into
 * it: this cap is about what a model should read, not about what a chart needs,
 * and the two should be free to differ without one changing the other. */
export function trimSeries<T>(rows:readonly T[],max=SERIES_POINT_CAP):T[] {
 if(rows.length<=max||max<2)return rows.slice(0,Math.max(0,max))
 const step=rows.length/max,out:T[]=[]
 for(let index=0;index<max;index++)out.push(rows[Math.min(rows.length-1,Math.floor(index*step))])
 out[out.length-1]=rows[rows.length-1]
 return out
}

/** Said in words, never left as a silently short series. */
export function trimNote(kept:number,total:number,what:string):string|null {
 return total>kept
  ? `The ${what} had ${total} points over the window asked for; ${kept} evenly spaced points are returned, including the first and the last, so the window is unchanged and the answer stays readable.`
  : null
}

/** A ranked list cut to its head, said in words. */
export function listNote(kept:number,total:number,what:string,how='Ask for fewer or narrower rows, or raise the row argument up to its ceiling, to see others.'):string|null {
 return total>kept?`${total} ${what} matched; the first ${kept} in the stated order are returned. ${how}`:null
}

/** Join notes without leaving a stray separator when one of them is absent. */
export const notes=(...parts:Array<string|null|undefined>):string|null => {
 const kept=parts.filter((part):part is string=>typeof part==='string'&&part.length>0)
 return kept.length?kept.join(' '):null
}

/** Keys whose arrays are time series, trimmed by even stride rather than cut at
 * the head. Everything else is a ranked list, and the head is what matters. */
const SERIES_KEYS=new Set(['points','series','oiSeries','anchor','captures'])

function trimArraysDeep(value:unknown,cap:number,key:string|null,counter:{trimmed:number}):unknown {
 if(Array.isArray(value)){
  const kept=value.length>cap
   ?(key&&SERIES_KEYS.has(key)?trimSeries(value,Math.max(2,cap)):value.slice(0,cap))
   :value
  if(kept.length<value.length)counter.trimmed+=1
  return kept.map(item=>trimArraysDeep(item,cap,null,counter))
 }
 if(value&&typeof value==='object'){
  const out:Record<string,unknown>={}
  for(const [name,inner] of Object.entries(value as Record<string,unknown>))out[name]=trimArraysDeep(inner,cap,name,counter)
  return out
 }
 return value
}

/**
 * The last resort, after each tool's own shaping.
 *
 * Every handler shapes its payload deliberately first (named caps, shared series
 * budgets, notes that say what was cut). This only runs when that was not enough
 * for some combination nobody measured, and it halves every array in the payload
 * until the payload fits, series by even stride and lists by head. It says that it
 * ran. It never drops a key and never touches a scalar, so a figure that is
 * returned is never altered, only fewer of them are returned.
 */
export function fitToBudget<T extends Record<string,unknown>>(data:T,budget=RESULT_BYTE_BUDGET):{data:T;note:string|null;bytes:number} {
 let bytes=JSON.stringify(data).length
 if(bytes<=budget)return {data,note:null,bytes}
 const original=bytes
 let out:T=data
 for(const cap of [40,25,15,10,6,3,1]){
  const counter={trimmed:0}
  out=trimArraysDeep(data,cap,null,counter) as T
  bytes=JSON.stringify(out).length
  if(bytes<=budget){
   return {data:out,bytes,note:`This answer was ${original} bytes, more than one reply should carry, so every list in it was cut to at most ${cap} entries (time series by even stride, keeping the first and the last). Narrow the request to see more.`}
  }
 }
 return {data:out,bytes,note:`This answer was ${original} bytes; every list was cut to one entry and it is still ${bytes} bytes. Narrow the request.`}
}
