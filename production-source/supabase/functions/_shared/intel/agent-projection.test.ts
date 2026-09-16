import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
 PORTFOLIO_KEYS,HOLDING_KEYS,THESIS_KEYS,ALERT_KEYS,CHART_KEYS,CHART_DETAIL_KEYS,
 WATCHLIST_KEYS,EVIDENCE_KEYS,TOKEN_KEYS,PLAN_KEYS,
 projectPortfolio,projectHoldings,projectTheses,projectAlerts,projectCharts,
 projectChartDetail,projectWatchlists,projectEvidence,projectToken,projectPlan,
} from './agent-projection.ts'

// Everything an internal row might carry that an agent has no business seeing.
const AMBIENT={
 token_hash:'f'.repeat(64),service_role_note:'internal',market_context:{signal:'private'},
 reconciliation_status:'wallet_higher',private_owner_id:'someone',evaluation_state:{cursor:9},
 user_id:'10000000-0000-4000-8000-000000000001',org_id:'00000000-0000-4000-8000-000000000001',
}

Deno.test('a projection copies only its named keys, so a column added later cannot reach an agent',()=>{
 for(const [project,keys] of [
  [projectPortfolio,PORTFOLIO_KEYS],
  [projectThesisRow,THESIS_KEYS],
  [projectChartDetail,CHART_DETAIL_KEYS],
  [projectToken,TOKEN_KEYS],
  [projectPlan,PLAN_KEYS],
 ] as const){
  const projected=project({id:'x',...AMBIENT} as any)!
  eq(Object.keys(projected).sort(),[...keys].sort())
  for(const ambient of Object.keys(AMBIENT)){
   if((keys as readonly string[]).includes(ambient))continue
   eq(ambient in projected,false)
  }
 }
})
function projectThesisRow(row:Record<string,unknown>){return projectTheses([row])[0] as Record<string,unknown>}

Deno.test('a token projection never carries the hash, only the six-character hint',()=>{
 const projected=projectToken({id:'t',name:'Laptop',token_hint:'abc123',scopes:['read:charts'],...AMBIENT})!
 eq('token_hash' in projected,false)
 eq(projected.token_hint,'abc123')
 eq(JSON.stringify(projected).includes('f'.repeat(64)),false)
})

Deno.test('a chart listing omits the saved layout state and only the detail carries it',()=>{
 const row={id:'c',asset:'native:bitcoin',title:'BTC',revision:2,state:{schemaVersion:1,drawings:[{id:'d'}]},...AMBIENT}
 const listed=projectCharts([row])[0] as Record<string,unknown>
 eq('state' in listed,false)
 eq(Object.keys(listed).sort(),[...CHART_KEYS].sort())
 const detail=projectChartDetail(row)!
 eq((detail.state as any).drawings.length,1)
})

Deno.test('a column the row does not carry becomes null, so the shape an agent parses is stable',()=>{
 const sparse=projectPortfolio({id:'p'})!
 eq(Object.keys(sparse).sort(),[...PORTFOLIO_KEYS].sort())
 eq(sparse.total_value_usd,null)
 eq(sparse.last_synced_at,null)
})

Deno.test('holdings carry cost basis and profit but never the internal market context',()=>{
 const projected=projectHoldings([{asset_symbol:'BTC',quantity:1.5,cost_basis_usd:40000,unrealized_pnl:1000,...AMBIENT}])[0] as Record<string,unknown>
 eq(Object.keys(projected).sort(),[...HOLDING_KEYS].sort())
 eq(projected.cost_basis_usd,40000)
 eq('market_context' in projected,false)
 eq('reconciliation_status' in projected,false)
})

Deno.test('alerts and evidence keep the member-authored content and drop engine bookkeeping',()=>{
 const alert=projectAlerts([{id:'a',trigger_type:'chart_price',is_active:true,config:{title:'Original words'},...AMBIENT}])[0] as Record<string,unknown>
 eq(Object.keys(alert).sort(),[...ALERT_KEYS].sort())
 eq((alert.config as any).title,'Original words')
 eq('evaluation_state' in alert,false)

 const evidence=projectEvidence([{id:'e',thesis_id:'t',source_table:'manual',event_snapshot:{title:'Filing'},...AMBIENT}])[0] as Record<string,unknown>
 eq(Object.keys(evidence).sort(),[...EVIDENCE_KEYS].sort())
 eq((evidence.event_snapshot as any).title,'Filing')
})

Deno.test('an empty list stays an empty list rather than becoming null',()=>{
 eq(projectWatchlists([]),[])
 eq(projectWatchlists(null as any),[])
 eq(projectHoldings(undefined as any),[])
 eq(Object.keys(projectWatchlists([{id:'w',...AMBIENT}])[0] as object).sort(),[...WATCHLIST_KEYS].sort())
})
