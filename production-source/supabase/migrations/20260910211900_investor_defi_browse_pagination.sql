-- Shared permitted snapshots, latest per instrument. Bound response and last-good
-- age; filters, ordering, counts, and aggregates execute in Postgres.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Solana mint references verified against issuer documentation on 2026-09-10:
-- https://developers.circle.com/stablecoins/usdc-contract-addresses
-- https://tether.to/en/supported-protocols/
-- The old unqualified profile subquery compared the snapshot's org to itself.
-- Shared provider facts remain readable; only service writers can mutate them.
DROP POLICY IF EXISTS dps_org ON public.defi_pool_snapshots;
CREATE POLICY dps_shared_read ON public.defi_pool_snapshots FOR SELECT TO authenticated
 USING (org_id IS NULL);
CREATE POLICY dps_member_private ON public.defi_pool_snapshots FOR ALL TO authenticated
 USING (org_id IN (SELECT public.intel_portfolio_org_ids()))
 WITH CHECK (org_id IN (SELECT public.intel_portfolio_org_ids()));
CREATE INDEX IF NOT EXISTS dps_browse_latest ON public.defi_pool_snapshots
  (chain, (coalesce(pool_id,pool_address)), (coalesce(product_type,'')), snapshot_at DESC, id DESC) WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS kvs_browse_latest ON public.kamino_vault_snapshots
  (vault_address, snapshot_at DESC, id DESC) WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS kms_browse_latest ON public.kamino_market_snapshots
  (market_address, reserve_address, snapshot_at DESC, id DESC) WHERE org_id IS NULL;

CREATE OR REPLACE FUNCTION public.intel_defi_browse_page(
  p_org_id uuid, p_chain text DEFAULT 'solana', p_view text DEFAULT 'vaults',
  p_product text DEFAULT 'all', p_search text DEFAULT '', p_sort text DEFAULT 'tvl_usd',
  p_direction text DEFAULT 'desc', p_page integer DEFAULT 0, p_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_table text; v_identity text; v_columns text; v_sort text; v_tvl text;
  v_apy text; v_result jsonb; v_chain_filter text := '';
  v_limit integer := greatest(1,least(coalesce(p_limit,50),100));
BEGIN
  IF auth.uid() IS NULL OR p_org_id IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids()) THEN
    RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE='42501';
  END IF;
  IF p_chain IS NULL OR p_chain NOT IN ('solana','ethereum','base','arbitrum','bnb','polygon','avalanche','sui','sei','optimism','linea','scroll','zksync','mantle','blast','fantom','gnosis','sonic')
    OR p_view IS NULL OR p_product IS NULL OR p_direction IS NULL OR p_sort IS NULL
    OR p_view NOT IN ('vaults','lending') OR p_product NOT IN ('all','lp','single','stable','multiply')
    OR p_direction NOT IN ('asc','desc') OR p_sort NOT IN ('name','symbol','tvl_usd','apy','apyReward','supplyApy','borrowApy','utilization')
    OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 2000 OR length(coalesce(p_search,'')) > 120 THEN
    RAISE EXCEPTION 'Invalid explorer query' USING ERRCODE='22023';
  END IF;
  IF p_chain = 'solana' AND p_view = 'vaults' THEN
    v_table := 'kamino_vault_snapshots'; v_identity := 'vault_address'; v_tvl := 'tvl_usd'; v_apy := 'apy';
    v_columns := 'vault_address,vault_name,product_type,tvl_usd,apy,apy_base,apy_reward,apy_mean_30d,token_a,token_b,confidence,fetched_at,stale_after,snapshot_at,
      (raw->>''stable''=''true'' OR (token_a_mint IN (''EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'',''Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'')
        AND (token_b_mint IN (''EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'',''Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'') OR (product_type=''single'' AND token_b_mint IS NULL)))) AS stable';
  ELSIF p_chain = 'solana' THEN
    v_table := 'kamino_market_snapshots'; v_identity := 'market_address,reserve_address'; v_tvl := 'total_supply_usd'; v_apy := 'supply_apy';
    v_columns := 'market_address,reserve_address,mint,asset_symbol,market_name,market_is_primary,total_supply_usd,total_borrow_usd,supply_apy,borrow_apy,utilization,ltv,confidence,fetched_at,stale_after,snapshot_at';
  ELSE
    v_table := 'defi_pool_snapshots'; v_identity := 'coalesce(pool_id,pool_address),coalesce(product_type,'''')'; v_tvl := 'tvl_usd'; v_apy := CASE WHEN p_view='lending' THEN 'supply_apy' ELSE 'apy' END;
    v_chain_filter := ' AND chain=$1';
    v_columns := 'pool_id,pool_address,chain,name,symbol,product_type,tvl_usd,apy,apy_base,apy_reward,apy_mean_30d,il_7d,prediction,protocol,token_a,token_b,stable,url,supply_apy,borrow_apy,total_borrow_usd,utilization,ltv,market_name,confidence,fetched_at,stale_after,snapshot_at';
  END IF;
  v_sort := CASE p_sort WHEN 'tvl_usd' THEN v_tvl WHEN 'apy' THEN v_apy WHEN 'apyReward' THEN 'apy_reward'
    WHEN 'supplyApy' THEN 'supply_apy' WHEN 'borrowApy' THEN 'borrow_apy'
    WHEN 'name' THEN CASE WHEN p_chain='solana' AND p_view='vaults' THEN 'vault_name' WHEN p_chain='solana' THEN 'market_name' ELSE 'name' END
    WHEN 'symbol' THEN CASE WHEN p_chain='solana' AND p_view='vaults' THEN 'token_a' WHEN p_chain='solana' THEN 'asset_symbol' ELSE 'symbol' END ELSE p_sort END;
  -- All interpolated identifiers/clauses above are constants selected from a
  -- closed vocabulary. Search, chain, product, and limits remain bound values.
  EXECUTE format($q$
    WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON (%1$s) %2$s FROM public.%3$I
      WHERE org_id IS NULL AND snapshot_at >= now()-interval '7 days' %4$s
      ORDER BY %1$s, snapshot_at DESC, id DESC
    ), shaped AS (
      SELECT to_jsonb(l) AS r FROM latest l
    ), filtered AS MATERIALIZED (
      SELECT r FROM shaped
      WHERE ($1='solana' OR CASE WHEN $2='lending' THEN r->>'product_type'='lending' ELSE coalesce(r->>'product_type','')<>'lending' END)
        AND ($2='lending' OR $3='all' OR ($3='stable' AND coalesce((r->>'stable')::boolean,false)) OR r->>'product_type'=$3)
        AND ($4='' OR strpos(lower(concat_ws(' ',r->>'name',r->>'symbol',r->>'vault_name',r->>'asset_symbol',r->>'protocol',r->>'market_name',r->>'vault_address',r->>'pool_address',r->>'mint',r->>'token_a',r->>'token_b')),lower($4))>0)
    ), ordered AS (
      SELECT r FROM filtered ORDER BY %5$s %6$s NULLS LAST,
        concat_ws(':',r->>'pool_id',r->>'pool_address',r->>'product_type',r->>'vault_address',r->>'market_address',r->>'reserve_address') ASC
      LIMIT $5 OFFSET $6
    ) SELECT jsonb_build_object(
      'records',coalesce((SELECT jsonb_agg(r) FROM ordered),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),
      'summary',(SELECT jsonb_build_object('count',count(*),'tvl',sum((r->>%7$L)::numeric),
        'topApy',max((r->>%8$L)::numeric),'averageUtilization',avg((r->>'utilization')::numeric),
        'weightedApy',sum((r->>%8$L)::numeric*(r->>%7$L)::numeric) / nullif(sum((r->>%7$L)::numeric) FILTER (WHERE r->>%8$L IS NOT NULL),0)) FROM filtered),
      'coverage',jsonb_build_object('source','cache','maxSnapshotAgeDays',7,'latestPerInstrument',true,
        'stableClassification',CASE WHEN $1='solana' AND $2='vaults' THEN 'Provider flag or verified USDC/USDT mint identities; other stable assets may be unclassified.' ELSE 'Provider stable classification' END))
  $q$, v_identity, v_columns, v_table, v_chain_filter,
    CASE WHEN p_sort IN ('name','symbol') THEN format('lower(r->>%L)',v_sort) ELSE format('(r->>%L)::numeric',v_sort) END,
    p_direction, v_tvl, v_apy)
    INTO v_result USING p_chain,p_view,p_product,trim(coalesce(p_search,'')),v_limit,p_page*v_limit;
  RETURN v_result || jsonb_build_object('page',p_page,'limit',v_limit);
END;
$$;
REVOKE ALL ON FUNCTION public.intel_defi_browse_page(uuid,text,text,text,text,text,text,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_defi_browse_page(uuid,text,text,text,text,text,text,integer,integer) TO authenticated;
