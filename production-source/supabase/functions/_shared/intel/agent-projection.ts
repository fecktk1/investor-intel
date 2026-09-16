// What an agent is allowed to see, stated as closed lists.
//
// The reads underneath these projections return large internal shapes. The
// CoinMarketCap detail response alone carries 46 keys, and a portfolio row
// carries cost basis, reconciliation state and a market_context blob that exists
// for the app's own rendering. Forwarding a raw row to an agent would mean that
// every column added later is silently published to every agent that ever held
// a token.
//
// So nothing here copies a row. Each projector builds a NEW object from a named
// key list, and a field that is not on the list cannot appear in the output even
// if it appears in the row. The key lists are exported so a test can assert the
// contract rather than trusting the implementation.

// deno-lint-ignore no-explicit-any
type Row=Record<string,any>

/** Build exactly these keys. A key the row does not carry becomes null, so the
 * shape an agent parses is the same whether or not the column was populated. */
function pick(row:Row|null|undefined,keys:readonly string[]):Record<string,unknown>|null {
 if(!row)return null
 const out:Record<string,unknown>={}
 for(const key of keys)out[key]=row[key]??null
 return out
}
const list=(rows:Row[]|null|undefined,keys:readonly string[])=>(Array.isArray(rows)?rows:[]).map(row=>pick(row,keys)!)

// ── Portfolio ───────────────────────────────────────────────────────────────
// Cost basis and unrealized P&L ARE included: this is the member's own book,
// read by software the member chose, under a scope they granted by name, and a
// portfolio agent that cannot see cost basis cannot say anything useful about a
// position. market_context, reconciliation_status and every internal id are not
// included, because nothing an agent does needs them.
export const PORTFOLIO_KEYS=['id','name','base_currency','total_value_usd','total_cost_usd','unrealized_pnl_usd','realized_pnl_usd','day_pnl_pct','stablecoin_pct','incomplete_history','market_data_available','last_synced_at'] as const
export const HOLDING_KEYS=['asset_symbol','chain','asset_class','quantity','average_cost','cost_basis_usd','current_price','current_value','unrealized_pnl','unrealized_pnl_pct','allocation_pct','price_status','pnl_state','is_dust','last_priced_at'] as const
export const projectPortfolio=(row:Row)=>pick(row,PORTFOLIO_KEYS)
export const projectHoldings=(rows:Row[])=>list(rows,HOLDING_KEYS)

// ── Thesis ──────────────────────────────────────────────────────────────────
// The member's own written argument. Included in full, because summarising it
// for them is the job. The engine's internal evaluation bookkeeping
// (evaluation_error_count, last_evaluation_failed_at) is not an agent's concern.
export const THESIS_KEYS=['id','title','subject_kind','stance','bull_thesis','bear_thesis','neutral_thesis','what_would_confirm','what_would_invalidate','confidence','thesis_date','engine_suggested_status','needs_user_review','status_reason','quality_score','last_reviewed_at','next_review_at','created_at','updated_at'] as const
export const projectThesis=(row:Row)=>pick(row,THESIS_KEYS)
export const projectTheses=(rows:Row[])=>list(rows,THESIS_KEYS)

// ── Alerts ──────────────────────────────────────────────────────────────────
// config is the member's own alert condition and is passed through whole; it is
// the thing an agent is being asked to reason about. evaluation_state is engine
// bookkeeping and is not.
export const ALERT_KEYS=['id','trigger_type','is_active','config','cooldown_minutes','quality_score','noisy','chart_revision','created_at'] as const
export const ALERT_EVENT_KEYS=['id','rule_id','fired_at','read_at','payload'] as const
export const projectAlerts=(rows:Row[])=>list(rows,ALERT_KEYS)
export const projectAlertEvents=(rows:Row[])=>list(rows,ALERT_EVENT_KEYS)

// ── Charts ──────────────────────────────────────────────────────────────────
// A layout listing deliberately omits `state`: the full saved layout can be
// 200KB of drawings and studies, and an agent listing charts wants to know which
// charts exist. The detail projection carries the state for the one it opens.
export const CHART_KEYS=['id','asset','title','revision','created_at','updated_at'] as const
export const CHART_DETAIL_KEYS=['id','asset','title','revision','state','created_at','updated_at'] as const
export const projectCharts=(rows:Row[])=>list(rows,CHART_KEYS)
export const projectChartDetail=(row:Row)=>pick(row,CHART_DETAIL_KEYS)

// ── Watchlists ──────────────────────────────────────────────────────────────
export const WATCHLIST_KEYS=['id','name','is_default','sort_order','created_at'] as const
export const WATCHLIST_ITEM_KEYS=['id','watchlist_id','item_type','label','notes','sort_order','created_at'] as const
export const projectWatchlists=(rows:Row[])=>list(rows,WATCHLIST_KEYS)
export const projectWatchlistItems=(rows:Row[])=>list(rows,WATCHLIST_ITEM_KEYS)

// ── Evidence and receipts ───────────────────────────────────────────────────
// event_snapshot is the frozen normalized card the engine wrote, and is what an
// agent reads to know what the evidence actually said.
export const EVIDENCE_KEYS=['id','thesis_id','source_table','source_ref','event_type','event_at','impact','impact_source','user_label','is_baseline','event_snapshot','created_at'] as const
export const RECEIPT_KEYS=['id','title','created_at','investigation_receipt'] as const
export const projectEvidence=(rows:Row[])=>list(rows,EVIDENCE_KEYS)
export const projectReceipts=(rows:Row[])=>list(rows,RECEIPT_KEYS)

// ── Plans ───────────────────────────────────────────────────────────────────
// What a proposal looks like to the agent that made it and to the person being
// asked to approve it. The actor block is included on purpose: a person reading
// an approval request should be able to see that a token asked for it, and
// which one.
export const PLAN_KEYS=['id','tool_key','target','payload','plan_hash','risk_level','summary','status','actor','failure_reason','expires_at','created_at','executed_at'] as const
export const projectPlan=(row:Row)=>pick(row,PLAN_KEYS)
export const projectPlans=(rows:Row[])=>list(rows,PLAN_KEYS)

// ── Tokens ──────────────────────────────────────────────────────────────────
// Never the hash. The hint is the last six characters of the plaintext, which
// is what lets a member tell two tokens apart without the secret being
// recoverable from anything stored.
export const TOKEN_KEYS=['id','name','org_id','token_hint','scopes','expires_at','revoked_at','revoked_reason','last_used_at','created_at'] as const
export const projectToken=(row:Row)=>pick(row,TOKEN_KEYS)
export const projectTokens=(rows:Row[])=>list(rows,TOKEN_KEYS)
