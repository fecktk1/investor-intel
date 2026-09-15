// Investor Intel — reusable signal feed client (Phase 1 signal backbone).
// Reads the global intel_signal_state via the personalized signal_feed_v2 RPC
// (relevance + reasons computed at read time; no extra fetch, no AI).

export async function loadSignalFeed(supabase, orgId, { subjectType = null, chains = null, limit = 24, portfolioId = null } = {}) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc(portfolioId?'intel_selected_portfolio_signals':'signal_feed_v2', {
    ...(portfolioId?{p_portfolio_id:portfolioId}:{}),
    p_org_id: orgId,
    p_subject_type: subjectType,
    p_chains: chains,
    p_limit: Math.max(1,Math.min(200,Math.trunc(Number(limit)||24))),
  })
  if (error) throw error
  return data || []
}
