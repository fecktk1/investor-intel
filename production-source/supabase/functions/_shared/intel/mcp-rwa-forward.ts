// Three RWA readings served from stores built by sibling capture lanes.
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
// The table and column names live here in one place, wired to the real stores on
// 2026-09-20. They are also listed in
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
 // Wired 2026-09-20 to the stores the sibling lanes actually created.
 // One row per wrapper token per six-hourly capture (capture-rwa-wrappers.ts).
 // premium_bps is against the asset's anchor; an accruing wrapper carries
 // accrual_gap_bps instead and never a premium. Subject is the wrapper's
 // CoinMarketCap crypto id.
 wrapper_premiums:{
  table:'intel_rwa_wrapper_tokens',
  capturedAtColumn:'captured_at',
  subjectColumn:'crypto_id',
  // The underlying_ref_* columns (migration 20260923193000) are the wrapper
  // against the listed share's Chainlink price; within_band true means the gap
  // is inside the feed's update band and is not distinguishable from zero.
  // The accrual_* columns (migration 20260923220000), appended and never
  // renamed: on a wrapper that reinvests dividends into its price,
  // accrual_treatment 'adjusted' means premium_bps and underlying_ref_bps are of
  // adjusted_price (price divided by accrual_multiplier, the issuer's own
  // on-chain multiplier, from accrual_multiplier_source, effective
  // accrual_multiplier_as_of), with the unadjusted figures in raw_premium_bps
  // and underlying_ref_raw_bps; 'not_adjusted' means no sourced multiplier
  // applied (accrual_reason), the wrapper carries accrual_gap_bps and
  // underlying_ref_raw_bps includes reinvested dividends.
  columns:['rwa_id','crypto_id','symbol','name','issuer_name','price','normalised_price','market_cap','volume_24h','unit_state','wrapper_state','premium_bps','accrual_gap_bps','in_anchor','state_reason','captured_at','fetched_at','underlying_ref_price','underlying_ref_bps','underlying_ref_within_band','underlying_ref_session','underlying_ref_observed_at','underlying_ref_source','accrual_treatment','accrual_reason','accrual_multiplier','accrual_multiplier_source','accrual_multiplier_as_of','accrual_multiplier_network','accrual_multiplier_address','adjusted_price','raw_premium_bps','underlying_ref_raw_bps'],
 },
 // One row per token per day (capture-rwa-depth.ts). Provider figures only; the
 // exitability sizes are computed on read in the app and are not stored.
 // Subject is the token key, written cmc:<crypto id> or contract:<chain>:<address>.
 //
 // TWO SETS OF LIQUIDITY COLUMNS, and an agent must not mix them up.
 //   total_liquidity_usd / deepest_pool_*     EVERY pool found, as CoinMarketCap
 //     reported it. `liqUsd` values BOTH legs of a pool, so these include pools
 //     whose other side is a token nobody can value. On 2026-09-20 XAUt's
 //     deepest_pool_pair was `XAUt / GOLDGR` at $16.5M on $812 of daily volume.
 //   recognised_* / deepest_recognised_*      only pools whose OTHER leg is a
 //     major quote asset on that chain or another tokenised asset we captured,
 //     matched by contract address. These are the figures about where the token
 //     can actually be sold, and the ones any answer should quote.
 // pool_classification NULL means the capture predates the leg addresses and the
 // recognised_* columns are all NULL: the provider's totals are all there is.
 liquidity_depth:{
  table:'intel_rwa_depth_snapshots',
  capturedAtColumn:'captured_at',
  subjectColumn:'token_key',
  columns:['token_key','crypto_id','symbol','token_name','rwa_name','asset_type','issuer_name','token_market_cap','depth_state','chains_deployed','chains_read','chains_not_covered','pool_count','total_liquidity_usd','total_volume_24h_usd','deepest_pool_dex','deepest_pool_chain','deepest_pool_pair','deepest_liquidity_usd','deepest_volume_24h_usd','pool_classification','recognised_pool_count','recognised_liquidity_pools','recognised_liquidity_usd','recognised_volume_24h_usd','unrecognised_pool_count','unrecognised_liquidity_usd','deepest_recognised_dex','deepest_recognised_chain','deepest_recognised_pair','deepest_recognised_liquidity_usd','deepest_recognised_volume_24h_usd','exit_liquidity_usd','exit_liquidity_pools','holder_count','restriction_state','snapshot_date','captured_at'],
 },
 // One row per tokenised asset whose provider-asserted filer number was read
 // back at EDGAR (capture-rwa-underlyings.ts). This is the UNDERLYING listed
 // company, never the token issuer. Subject is the ten-digit CIK.
 underlying_registrant:{
  table:'intel_rwa_underlying_registrants',
  capturedAtColumn:'fetched_at',
  subjectColumn:'cik',
  columns:['rwa_id','cik','state','reason','registrant_name','asset_name','name_match','sic','sic_description','state_of_incorporation','fiscal_year_end','exchanges','tickers','latest_annual_form','latest_annual_date','latest_annual_accession','latest_quarterly_form','latest_quarterly_date','latest_quarterly_accession','latest_current_form','latest_current_date','filings_read','source_url','fetched_at'],
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
