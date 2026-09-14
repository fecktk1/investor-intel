-- Retain the nine existing insights, using the current thesis identity index.
-- This read neither aggregates overlapping portfolios nor syncs any wallet.
CREATE OR REPLACE FUNCTION public.intel_portfolio_thesis_conflicts(p_portfolio_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE owner uuid:=auth.uid();scope uuid;result jsonb;BEGIN
 SELECT p.org_id INTO scope FROM public.investor_portfolios p JOIN public.org_members m ON m.org_id=p.org_id AND m.user_id=owner WHERE p.id=p_portfolio_id AND p.user_id=owner;
 IF owner IS NULL OR scope IS NULL THEN RAISE EXCEPTION 'portfolio_insights_forbidden' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM public.investor_portfolio_holdings WHERE portfolio_id=p_portfolio_id AND org_id=scope AND user_id=owner LIMIT 2001)x)>2000
 OR (SELECT count(*) FROM (SELECT 1 FROM public.intel_theses WHERE org_id=scope AND user_id=owner LIMIT 2001)x)>2000
 OR (SELECT count(*) FROM (SELECT 1 FROM public.intel_trades WHERE portfolio_id=p_portfolio_id AND org_id=scope AND user_id=owner LIMIT 1001)x)>1000 THEN RAISE EXCEPTION 'portfolio_insights_context_limit';END IF;
 WITH h AS MATERIALIZED (
  SELECT x.canonical_asset_key key,coalesce(x.normalized_symbol,x.asset_symbol,x.canonical_asset_key,'Unresolved asset') sym,x.allocation_pct alloc,x.current_value val
  FROM public.investor_portfolio_holdings x WHERE x.portfolio_id=p_portfolio_id AND x.org_id=scope AND x.user_id=owner AND x.quantity>0 AND NOT coalesce(x.is_closed,false)
 ),th AS MATERIALIZED (
  SELECT t.*,i.identity_keys keys FROM public.intel_theses t JOIN app_private.intel_thesis_asset_identity i ON i.thesis_id=t.id
  WHERE t.org_id=scope AND t.user_id=owner AND t.status NOT IN('archived','closed')
 ),hm AS MATERIALIZED (
  SELECT h.*,th.id thesis_id,th.conviction,th.time_horizon,th.status,th.engine_suggested_status,th.next_review_at,th.last_reviewed_at,th.last_status_at,th.keys
  FROM h LEFT JOIN th ON h.key=ANY(th.keys)
 ),tr AS MATERIALIZED (
  SELECT * FROM public.intel_trades WHERE portfolio_id=p_portfolio_id AND org_id=scope AND user_id=owner
 ) SELECT jsonb_build_object(
  'holdings_without_thesis',coalesce((SELECT jsonb_agg(sym ORDER BY sym,key) FROM h WHERE NOT EXISTS(SELECT 1 FROM th WHERE h.key=ANY(th.keys))),'[]'),
  'holdings_stale_thesis',coalesce((SELECT jsonb_agg(jsonb_build_object('symbol',sym,'canonical_asset_key',key,'thesis_id',thesis_id,'next_review_at',next_review_at)) FROM hm WHERE thesis_id IS NOT NULL AND(next_review_at<now() OR last_reviewed_at<now()-interval '30 days')),'[]'),
  'large_holding_weakening',coalesce((SELECT jsonb_agg(jsonb_build_object('symbol',sym,'canonical_asset_key',key,'allocation_pct',alloc,'thesis_id',thesis_id)) FROM hm WHERE alloc>=15 AND(engine_suggested_status='weakening' OR status='weakening')),'[]'),
  'large_holding_invalidation_triggered',coalesce((SELECT jsonb_agg(jsonb_build_object('symbol',sym,'canonical_asset_key',key,'allocation_pct',alloc,'thesis_id',thesis_id)) FROM hm WHERE alloc>=15 AND EXISTS(SELECT 1 FROM public.intel_thesis_rules r WHERE r.thesis_id=hm.thesis_id AND r.org_id=scope AND r.user_id=owner AND r.rule_kind='invalidation' AND r.status='triggered')),'[]'),
  'high_conviction_low_allocation',coalesce((SELECT jsonb_agg(jsonb_build_object('symbol',sym,'canonical_asset_key',key,'conviction',conviction,'allocation_pct',alloc,'thesis_id',thesis_id)) FROM hm WHERE conviction>=0.7 AND alloc<5),'[]'),
  'low_conviction_high_allocation',coalesce((SELECT jsonb_agg(jsonb_build_object('symbol',sym,'canonical_asset_key',key,'conviction',conviction,'allocation_pct',alloc,'thesis_id',thesis_id)) FROM hm WHERE conviction<=0.4 AND alloc>=15),'[]'),
  'trades_without_thesis',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'symbol',symbol,'canonical_asset_key',subject_canonical_key)) FROM tr WHERE thesis_id IS NULL),'[]'),
  'exposure_increased_after_weakened',coalesce((SELECT jsonb_agg(jsonb_build_object('symbol',hm.sym,'canonical_asset_key',hm.key,'thesis_id',hm.thesis_id,'basis','recorded_journal_activity_not_verified_portfolio_balance_change')) FROM hm WHERE(engine_suggested_status='weakening' OR status='weakening') AND last_status_at IS NOT NULL AND EXISTS(SELECT 1 FROM tr x WHERE x.subject_canonical_key=ANY(hm.keys) AND x.status IN('open','partially_closed','closed') AND x.direction IN('long','spot_accumulate') AND x.entry_price IS NOT NULL AND x.size_usd>0 AND x.opened_at>hm.last_status_at AND x.opened_at<=now())),'[]'),
  'allocation_conflicts_time_horizon',coalesce((SELECT jsonb_agg(jsonb_build_object('symbol',sym,'canonical_asset_key',key,'allocation_pct',alloc,'time_horizon',time_horizon,'thesis_id',thesis_id)) FROM hm WHERE alloc>=15 AND time_horizon IN('intraday','swing')),'[]'),
  'coverage',jsonb_build_object('matching','canonical_identity','holdings', (SELECT count(*) FROM h),'unresolved_identity',(SELECT count(*) FROM h WHERE key IS NULL),'missing_value',(SELECT count(*) FROM h WHERE val IS NULL),'missing_allocation',(SELECT count(*) FROM h WHERE alloc IS NULL),'journal_activity_is_portfolio_balance_history',false),
  'framing','Current holdings matched to your owned theses by canonical identity. Missing values remain unknown. Journal additions do not prove changes in portfolio balances.'
 ) INTO result;RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_portfolio_thesis_conflicts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_thesis_conflicts(uuid) TO authenticated;
