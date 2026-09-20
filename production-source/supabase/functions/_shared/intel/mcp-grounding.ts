// What every tool result says about where its numbers came from.
//
// A model cannot see a page footer, a tooltip or a provenance chip. If a result
// is a bare number it will be quoted as a bare number, undated and unsourced,
// and the person reading the agent's answer has no way back to the capture. So
// the envelope is not decoration here, it is the whole difference between an
// agent that can ground a claim and one that guesses: every result carries
//
//   as_of         the capture time of the newest row the answer rests on
//   source        the provider, the endpoint family, and our own store
//   calculated_by 'provider' when the figure is theirs, 'investor_intel' when
//                 it is ours, in which case inputs names what it was made from
//   tier          the member's tier and the surface this tool sits on, so a
//                 refusal is legible and a served answer is attributable
//
// as_of is ALLOWED TO BE NULL and is null when the store is empty. A null with a
// reason beside it is honest; inventing now() as the capture time of data that
// was never captured is the one failure this envelope exists to prevent.
//
// RELATION TO THE PAGES. The app renders the same idea through FigureProvenance
// and SourceCallReceipt. This is the machine-readable form of it, taken from the
// same `asOf` and `coverage` fields the read modules already return, so a figure
// an agent quotes and a figure a member sees date themselves identically.

import type {IntelSurface} from './intel-surface-access.ts'

export type CalculatedBy='provider'|'investor_intel'

export interface SourceRef {
 /** 'coinmarketcap', 'coingecko', 'chainlink', 'sec', 'gleif', or
  * 'investor_intel' for something only we hold. */
 provider:string
 /** The endpoint family, not a single URL: '/v1/cryptocurrency/listings/latest'.
  * A family is stable enough to be worth telling an agent, where a URL with a
  * key in it never is. */
 endpoint_family?:string|null
 /** Our table, so a figure can be traced without guessing which capture it came
  * from. */
 store?:string|null
 /** Required by licence for some providers, and carried on the payload rather
  * than left to the client to remember. */
 attribution?:{provider:string;text:string;url:string}|null
}

export interface TierContext {
 tier:string
 surface:IntelSurface
 /** False only on a withheld result. */
 open:boolean
 /** Named on a refusal so an agent can tell the member which plan opens it. */
 opens_at?:string|null
}

export interface GroundedEnvelope {
 tool:string
 as_of:string|null
 source:SourceRef|SourceRef[]
 calculated_by:CalculatedBy
 /** Only when calculated_by is 'investor_intel'. What the figure was made from,
  * named the way the app names it, so our arithmetic is never mistaken for a
  * provider's published number. */
 inputs?:string[]
 tier:TierContext
 /** Rows behind the answer and whether the store was truncated. Straight from
  * the read module's own coverage, never recomputed. */
 coverage?:{from:string|null;to:string|null;count:number;truncated?:boolean}|null
 /** Why an answer is thin or empty, in words. Never a blank result with no
  * explanation. */
 note?:string|null
}

/** Human sentences for the read modules' machine reasons, so an agent never
 * repeats a bare code like 'no_asset_selected' to a person. Anything not listed
 * is passed through unchanged rather than swallowed. */
const REASON_TEXT:Record<string,string>={
 unsupported_view:'This reading is not one the capture layer offers.',
 invalid_date:'That date could not be read.',
 no_asset_selected:'No asset was named, so there was nothing to read.',
 invalid_query:'That search text could not be used.',
 catalogue_unavailable:'The asset catalogue could not be read. Retry when the service is ready.',
 subject_not_a_coinmarketcap_listing:'Metric agreement is only recorded for CoinMarketCap listings.',
}

export function reasonSentence(reason:unknown):string|null {
 if(typeof reason!=='string'||!reason)return null
 return REASON_TEXT[reason]??reason
}

/** An empty reading, explained. The house rule is that an empty state always
 * says why in words, and a tool result is a state a model reads. */
export function emptyNote(rows:number,asOf:string|null,reason:unknown,what:string):string|null {
 const sentence=reasonSentence(reason)
 if(sentence)return sentence
 if(rows>0)return null
 if(!asOf)return `Nothing has been captured for ${what} yet, so there is no reading to report.`
 return `The newest capture for ${what} holds no rows, so there is nothing to report for this request.`
}

/** Wrap a payload in its provenance. The payload goes under `data` rather than
 * being spread, so a field named `source` or `as_of` inside a reading can never
 * overwrite the envelope's own account of where the reading came from. */
export function grounded(
 envelope:GroundedEnvelope,
 data:Record<string,unknown>,
):Record<string,unknown> {
 return {
  tool:envelope.tool,
  as_of:envelope.as_of,
  source:envelope.source,
  calculated_by:envelope.calculated_by,
  ...(envelope.inputs?.length?{inputs:envelope.inputs}:{}),
  tier:envelope.tier,
  ...(envelope.coverage?{coverage:envelope.coverage}:{}),
  ...(envelope.note?{note:envelope.note}:{}),
  data,
 }
}

/**
 * The refusal body for a tool the member's tier does not reach.
 *
 * It carries the surface, the plan that opens it and nothing else. There is no
 * sample row, no count and no truncated form of the withheld reading, because
 * the point of a server-side gate is that the data was never produced. See the
 * note at the top of intel-surface-access.ts.
 */
export function withheld(tool:string,surface:IntelSurface,tier:string,opensAt:string,label:string):Record<string,unknown> {
 return {
  tool,
  withheld:true,
  error:'intel_surface_locked',
  surface,
  tier:{tier,surface,open:false,opens_at:opensAt} satisfies TierContext,
  message:`${label} is part of the ${opensAt} plan. This workspace is on ${tier}, so the reading was not produced. Nothing is hidden in this response: ask the member to upgrade in Investor Intel if they want it.`,
 }
}

/** Newest of a set of timestamps, ignoring nulls. Used where an answer joins two
 * stores and the honest as_of is the older of the two clocks, not the newer:
 * pass the limiting clock, not every clock. */
export function newestOf(...values:Array<string|null|undefined>):string|null {
 let best:string|null=null,bestMs=-Infinity
 for(const value of values){
  if(typeof value!=='string'||!value)continue
  const ms=Date.parse(value)
  if(!Number.isFinite(ms)||ms<=bestMs)continue
  best=value;bestMs=ms
 }
 return best
}

/** Oldest of a set of timestamps. An answer built from two captures is only as
 * fresh as its staler half, so a joined reading dates itself with this. */
export function oldestOf(...values:Array<string|null|undefined>):string|null {
 let best:string|null=null,bestMs=Infinity
 for(const value of values){
  if(typeof value!=='string'||!value)continue
  const ms=Date.parse(value)
  if(!Number.isFinite(ms)||ms>=bestMs)continue
  best=value;bestMs=ms
 }
 return best
}
