-- Replace derived holdings and their summary in one transaction. Existing
-- accounting remains authoritative; this function performs no calculations.
-- Only the authorized service writer can call it. Ownership comes from the
-- locked parent, never from a holding supplied in JSON.
CREATE OR REPLACE FUNCTION public.investor_replace_holdings(
  p_portfolio uuid,p_expected_synced_at timestamptz,p_holdings jsonb,p_summary jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE p investor_portfolios%ROWTYPE; s investor_portfolios%ROWTYPE;
BEGIN
  SELECT * INTO p FROM investor_portfolios WHERE id=p_portfolio FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'portfolio_not_found' USING ERRCODE='P0002'; END IF;
  IF p.last_synced_at IS DISTINCT FROM p_expected_synced_at THEN
    RAISE EXCEPTION 'portfolio_calculation_superseded' USING ERRCODE='40001';
  END IF;
  IF jsonb_typeof(p_holdings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_holdings)>10000
    OR jsonb_typeof(p_summary) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_holdings_snapshot' USING ERRCODE='22023';
  END IF;
  SELECT * INTO s FROM jsonb_populate_record(NULL::investor_portfolios,p_summary);
  DELETE FROM investor_portfolio_holdings WHERE portfolio_id=p.id;
  INSERT INTO investor_portfolio_holdings(org_id,user_id,portfolio_id,asset_symbol,normalized_symbol,contract_address,chain,asset_class,quantity,average_cost,cost_basis_usd,current_price,current_value,price_source,price_status,last_priced_at,unrealized_pnl,unrealized_pnl_pct,realized_pnl,day_pnl,day_pnl_pct,allocation_pct,pnl_state,reconciliation_status,market_context,is_dust,canonical_asset_key,name,logo_url,verified,decimals,mint_or_contract,support_level,provider,provider_network,cost_basis_status,last_synced_at,is_closed,updated_at)
  SELECT p.org_id,p.user_id,p.id,h.asset_symbol,h.normalized_symbol,h.contract_address,h.chain,h.asset_class,h.quantity,h.average_cost,h.cost_basis_usd,h.current_price,h.current_value,h.price_source,h.price_status,h.last_priced_at,h.unrealized_pnl,h.unrealized_pnl_pct,h.realized_pnl,h.day_pnl,h.day_pnl_pct,h.allocation_pct,h.pnl_state,h.reconciliation_status,h.market_context,h.is_dust,h.canonical_asset_key,h.name,h.logo_url,h.verified,h.decimals,h.mint_or_contract,h.support_level,h.provider,h.provider_network,h.cost_basis_status,h.last_synced_at,h.is_closed,h.updated_at
  FROM jsonb_populate_recordset(NULL::investor_portfolio_holdings,p_holdings) h;
  UPDATE investor_portfolios SET total_value_usd=s.total_value_usd,total_cost_usd=s.total_cost_usd,unrealized_pnl_usd=s.unrealized_pnl_usd,realized_pnl_usd=s.realized_pnl_usd,day_pnl_usd=s.day_pnl_usd,day_pnl_pct=s.day_pnl_pct,stablecoin_pct=s.stablecoin_pct,risk_score=s.risk_score,incomplete_history=s.incomplete_history,market_data_available=s.market_data_available,
    last_synced_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.investor_replace_holdings(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.investor_replace_holdings(uuid,timestamptz,jsonb,jsonb) TO service_role;
GRANT SELECT,INSERT,DELETE ON public.investor_portfolio_holdings TO service_role;
GRANT SELECT,UPDATE ON public.investor_portfolios TO service_role;
