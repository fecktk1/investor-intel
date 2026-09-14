BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- One authorized snapshot for the bounded calculation. No new accounting
-- tables, privileged browser grants, provider calls or fabricated transactions.
CREATE FUNCTION public.intel_portfolio_performance_inputs(p_org_id uuid,p_portfolio_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''
AS $$
DECLARE v_snapshots jsonb;v_groups jsonb;v_manual jsonb;v_from timestamptz;v_to timestamptz;
BEGIN
 IF public.can_access_intel(auth.uid(),p_org_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids())) THEN
  RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.as_of),'[]'),min(s.as_of),max(s.as_of) INTO v_snapshots,v_from,v_to FROM (
  SELECT id,snapshot_date,as_of,total_value_usd,CASE WHEN jsonb_typeof(holdings_summary)='array' AND jsonb_array_length(holdings_summary)<=200 THEN holdings_summary ELSE NULL END holdings_summary,risk_summary FROM public.investor_portfolio_snapshots
  WHERE portfolio_id=p_portfolio_id AND org_id=p_org_id AND user_id=auth.uid() AND snapshot_date>=current_date-90
  ORDER BY snapshot_date DESC LIMIT 92
 )s;
 IF jsonb_array_length(v_snapshots)<2 THEN RETURN jsonb_build_object('snapshots',v_snapshots,'groups','[]'::jsonb,'manual','[]'::jsonb,'truncated',false);END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(g)),'[]') INTO v_groups FROM (
  SELECT t.id,t.chain,t.type,t.status,t.classification_status,t.block_time,t.tx_hash,t.signature,t.fee_asset,t.fee_amount,t.fee_usd,
   (SELECT coalesce(jsonb_agg(to_jsonb(li)),'[]') FROM (
     SELECT l.id,l.canonical_asset_key,l.direction,l.amount,l.price_usd_at_tx,l.price_source_at_tx FROM public.investor_portfolio_tx_line_items l
     WHERE l.tx_id=t.id AND l.portfolio_id=p_portfolio_id AND l.org_id=p_org_id AND l.user_id=auth.uid() ORDER BY l.leg_index,l.id LIMIT 201
   )li) line_items
  FROM public.investor_portfolio_tx t WHERE t.portfolio_id=p_portfolio_id AND t.org_id=p_org_id AND t.user_id=auth.uid() AND NOT t.is_display_mirror AND t.status='success'
   AND (t.block_time>v_from AND t.block_time<=v_to OR t.block_time IS NULL)
  ORDER BY t.block_time,t.id LIMIT 1001
 )g;
 SELECT coalesce(jsonb_agg(to_jsonb(m)),'[]') INTO v_manual FROM (
  SELECT t.id,t.transaction_type,t.classification_status,t.direction,t.canonical_asset_key,t.quantity,t.price_per_unit,t.quote_currency,t.fee_amount,t.fee_currency,t.timestamp,
   jsonb_build_object('manual_group_id',t.raw_metadata->'manual_group_id','basisEstimated',t.raw_metadata->'basisEstimated') raw_metadata
  FROM public.investor_portfolio_transactions t JOIN public.investor_portfolio_sources s ON s.id=t.source_id AND s.portfolio_id=t.portfolio_id AND s.org_id=t.org_id AND s.user_id=t.user_id
  WHERE t.portfolio_id=p_portfolio_id AND t.org_id=p_org_id AND t.user_id=auth.uid() AND s.source_type='manual'
   AND (t.timestamp>v_from AND t.timestamp<=v_to OR t.timestamp IS NULL)
  ORDER BY t.timestamp,t.id LIMIT 1001
 )m;
 RETURN jsonb_build_object('snapshots',v_snapshots,'groups',v_groups,'manual',v_manual,
  'truncated',jsonb_array_length(v_snapshots)>91 OR jsonb_array_length(v_groups)>1000 OR jsonb_array_length(v_manual)>1000);
END $$;
REVOKE ALL ON FUNCTION public.intel_portfolio_performance_inputs(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_performance_inputs(uuid,uuid) TO authenticated;
COMMIT;
