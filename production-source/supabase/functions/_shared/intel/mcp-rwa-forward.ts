// Three RWA readings whose tables are being built by other agents right now.
//
// The tools are published today and answer honestly today. Each one reads through
// a small adapter that can tell three states apart, which is the entire reason
// this file exists as its own module:
//
//   not_available_yet  the table is not in the database at all. The reading is
//                      being built; nothing is wrong and nothing is missing from
//                      what we do hold.
//   empty              the table is there and holds no row for this request. The
//                      lane exists and has not captured this subject yet.
//   served             rows.
//
// Collapsing the first two would be the quiet failure: an agent told "no pools
// found" for a token whose depth lane does not exist yet will report that the
// token has no liquidity, which is a false claim about the market rather than a
// true claim about our coverage. So the absent-table case is named.
//
// WHAT I ASSUMED. Every table and column below is a GUESS at what the sibling
// lanes will create, recorded here in one place so the merge is a rename in this
// file and nothing else. The assumed names are listed in
// docs/investor-intel/hosted-mcp.md under "Forward-compatible RWA tools" and in
// FORWARD_TABLE_CONTRACT, which the tests read so a rename cannot be made
// silently. Nothing else in the MCP server references these names.

// deno-lint-ignore no-explicit-any
type Db=any

/** PostgREST and Postgres both have a way of saying "no such relation", and they
 * say it differently depending on whether the schema cache or the planner got
 * there first. Both are the same fact to us. */
const MISSING_RELATION=/PGRST205|PGRST202|42P01|could not find the table|does not exist|schema cache/i

function relationMissing(error:unknown):boolean {
 if(!error||typeof error!=='object')return false
 const e=error as {code?:unknown;message?:unknown;details?:unknown;hint?:unknown}
 const code=String(e.code??'')
 if(code==='42P01'||code==='PGRST205'||code==='PGRST202')return true
 return MISSING_RELATION.test(`${String(e.message??'')} ${String(e.details??'')} ${String(e.hint??'')}`)
}

export type ForwardState='not_available_yet'|'empty'|'served'|'unavailable'

export interface ForwardResult {
 state:ForwardState
 rows:Record<string,unknown>[]
 as_of:string|null
 /** In words, always. An agent repeating this to a person must not have to
  * translate a code. */
 note:string
 /** The table the reading would come from, named on every state so the owner can
  * wire it without reading this file. */
 expected_table:string
}

/**
 * The contract each sibling lane has to satisfy for these tools to light up.
 *
 * `capturedAtColumn` is the column the adapter orders by and reports as `as_of`.
 * `columns` is the exact select list; a column that does not exist makes the
 * select fail, which the adapter reports as `unavailable` with the provider's own
 * message rather than pretending the table is absent.
 */
export const FORWARD_TABLE_CONTRACT={
 wrapper_premiums:{
  table:'intel_rwa_wrapper_premiums',
  capturedAtColumn:'captured_at',
  subjectColumn:'wrapper_key',
  columns:['wrapper_key','wrapper_symbol','wrapper_name','anchor_key','anchor_symbol','chain','contract_address','wrapper_price_usd','anchor_price_usd','premium_pct','observed_at','captured_at','source_provider','source_url'],
 },
 liquidity_depth:{
  table:'intel_rwa_liquidity_pools',
  capturedAtColumn:'captured_at',
  subjectColumn:'token_key',
  columns:['token_key','token_symbol','chain','contract_address','pool_address','venue','quote_symbol','liquidity_usd','volume_24h_usd','depth_2pct_usd','depth_5pct_usd','exit_size_usd','slippage_bps_at_exit','captured_at','source_provider','source_url'],
 },
 underlying_registrant:{
  table:'intel_rwa_underlying_registrants',
  capturedAtColumn:'fetched_at',
  subjectColumn:'subject',
  columns:['subject','cik','registrant_name','filer_status','sic','sic_description','state_of_incorporation','fiscal_year_end','latest_filing_type','latest_filing_date','latest_accession_number','filings_count','source_url','fetched_at'],
 },
} as const

export type ForwardReading=keyof typeof FORWARD_TABLE_CONTRACT

/**
 * Read one forward table, bounded, and report which of the three states it is in.
 *
 * The subject filter is applied with `eq` on the contract's own subject column
 * when a subject is given. It is never interpolated into a filter string, so a
 * subject that happens to contain PostgREST punctuation cannot widen the query.
 */
export async function readForwardTable(
 db:Db,
 reading:ForwardReading,
 options:{subject?:string|null;limit:number;what:string},
):Promise<ForwardResult> {
 const contract=FORWARD_TABLE_CONTRACT[reading]
 const expected_table=contract.table
 try{
  let query=db.from(contract.table).select(contract.columns.join(','))
   .order(contract.capturedAtColumn,{ascending:false}).limit(options.limit)
  if(options.subject)query=query.eq(contract.subjectColumn,options.subject)
  const {data,error}=await query
  if(error){
   if(relationMissing(error)){
    return {
     state:'not_available_yet',rows:[],as_of:null,expected_table,
     note:`This reading is not built yet: the store ${expected_table} does not exist in this database. Treat it as missing coverage on our side, not as an absence of ${options.what} in the market.`,
    }
   }
   return {
    state:'unavailable',rows:[],as_of:null,expected_table,
    note:`The ${options.what} store could not be read: ${String((error as {message?:unknown}).message??'reason not reported')}. Retry when the service is ready.`,
   }
  }
  const rows=Array.isArray(data)?data as Record<string,unknown>[]:[]
  if(!rows.length){
   return {
    state:'empty',rows:[],as_of:null,expected_table,
    note:options.subject
     ? `${expected_table} exists but holds no row for ${options.subject} yet. The lane runs on a schedule, so this subject may simply not have been captured.`
     : `${expected_table} exists but is empty, so there is no ${options.what} reading to report yet.`,
   }
  }
  const as_of=typeof rows[0][contract.capturedAtColumn]==='string'?rows[0][contract.capturedAtColumn] as string:null
  return {
   state:'served',rows,as_of,expected_table,
   note:rows.length===options.limit?`Showing the ${options.limit} most recent rows, which is this tool's ceiling. There may be more.`:'',
  }
 }catch(error){
  // A throw rather than a returned error still has to be classified, because a
  // client that cannot see the relation at all throws here on some versions.
  if(relationMissing(error)){
   return {
    state:'not_available_yet',rows:[],as_of:null,expected_table,
    note:`This reading is not built yet: the store ${expected_table} does not exist in this database. Treat it as missing coverage on our side, not as an absence of ${options.what} in the market.`,
   }
  }
  return {
   state:'unavailable',rows:[],as_of:null,expected_table,
   note:`The ${options.what} store could not be read. Retry when the service is ready.`,
  }
 }
}
