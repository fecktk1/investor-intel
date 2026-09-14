-- Page logical events before reading legs. This never creates accounting rows.
CREATE INDEX IF NOT EXISTS ipt_activity_time ON public.investor_portfolio_tx(portfolio_id,block_time DESC NULLS LAST,id) WHERE NOT is_display_mirror;
CREATE INDEX IF NOT EXISTS iptransactions_activity_pair ON public.investor_portfolio_transactions(portfolio_id,(raw_metadata->>'manual_group_id'),timestamp DESC NULLS LAST,id);
CREATE INDEX IF NOT EXISTS iptli_activity_page ON public.investor_portfolio_tx_line_items(tx_id,leg_index,id);

CREATE FUNCTION public.intel_portfolio_activity_revision(p_org_id uuid,p_portfolio_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_revision text;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids())) THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 SELECT md5(coalesce(string_agg(x.hash,'' ORDER BY x.key),'')) INTO v_revision FROM (
  SELECT 'g:'||g.id key,md5((to_jsonb(g)-'raw')::text) hash FROM public.investor_portfolio_tx g WHERE g.portfolio_id=p_portfolio_id AND g.org_id=p_org_id AND g.user_id=auth.uid() AND NOT g.is_display_mirror
  UNION ALL SELECT 'l:'||l.id,md5(to_jsonb(l)::text) FROM public.investor_portfolio_tx_line_items l JOIN public.investor_portfolio_tx g ON g.id=l.tx_id WHERE g.portfolio_id=p_portfolio_id AND g.org_id=p_org_id AND g.user_id=auth.uid() AND NOT g.is_display_mirror AND l.portfolio_id=p_portfolio_id AND l.org_id=p_org_id AND l.user_id=auth.uid()
  UNION ALL SELECT 'm:'||m.id,md5(to_jsonb(m)::text) FROM public.investor_portfolio_transactions m JOIN public.investor_portfolio_sources s ON s.id=m.source_id WHERE m.portfolio_id=p_portfolio_id AND m.org_id=p_org_id AND m.user_id=auth.uid() AND s.source_type='manual' AND s.portfolio_id=p_portfolio_id AND s.org_id=p_org_id AND s.user_id=auth.uid()
  UNION ALL SELECT 's:'||s.id,md5(jsonb_build_array(s.id,s.provider,s.source_type,s.label)::text) FROM public.investor_portfolio_sources s WHERE s.portfolio_id=p_portfolio_id AND s.org_id=p_org_id AND s.user_id=auth.uid()
 ) x;
 RETURN v_revision;
END;$$;

CREATE FUNCTION public.intel_portfolio_activity_page(p_org_id uuid,p_portfolio_id uuid,p_limit integer DEFAULT 25,p_cursor jsonb DEFAULT NULL,p_direction text DEFAULT 'older',p_search text DEFAULT '',p_type text DEFAULT NULL,p_status text DEFAULT NULL,p_export boolean DEFAULT false,p_revision text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_limit integer:=greatest(1,least(100,coalesce(p_limit,25)));v_search text:=coalesce(p_search,'');v_time timestamptz;v_key text;v_revision text;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids())) THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 IF p_direction IS NULL OR p_direction NOT IN('older','newer') OR length(v_search)>160 OR length(coalesce(p_type,''))>40 OR length(coalesce(p_status,''))>40 THEN RAISE EXCEPTION 'Invalid activity page' USING ERRCODE='22023';END IF;
 IF p_cursor IS NOT NULL THEN
  IF jsonb_typeof(p_cursor)<>'object' OR jsonb_typeof(p_cursor->'key') IS DISTINCT FROM 'string' OR length(p_cursor->>'key')>100 OR p_cursor->>'key' !~ '^(grouped|manual|pair):[a-zA-Z0-9-]+$' OR NOT(p_cursor ? 'time') THEN RAISE EXCEPTION 'Invalid activity cursor' USING ERRCODE='22023';END IF;
  v_time:=coalesce((p_cursor->>'time')::timestamptz,'-infinity'::timestamptz);v_key:=p_cursor->>'key';
 END IF;
 IF p_export THEN
  v_revision:=public.intel_portfolio_activity_revision(p_org_id,p_portfolio_id);
  IF p_revision IS NOT NULL AND p_revision IS DISTINCT FROM v_revision THEN RAISE EXCEPTION 'Activity changed during export. Start the export again.' USING ERRCODE='40001';END IF;
 END IF;
 WITH manual_base AS MATERIALIZED (
  SELECT m.*,s.provider,CASE WHEN nullif(m.raw_metadata->>'manual_group_id','') IS NOT NULL THEN 'pair:'||(m.raw_metadata->>'manual_group_id') ELSE 'manual:'||m.id END event_key
  FROM public.investor_portfolio_transactions m JOIN public.investor_portfolio_sources s ON s.id=m.source_id
  WHERE m.portfolio_id=p_portfolio_id AND m.org_id=p_org_id AND m.user_id=auth.uid() AND s.source_type='manual' AND s.portfolio_id=p_portfolio_id AND s.org_id=p_org_id AND s.user_id=auth.uid()
 ), refs AS MATERIALIZED (
  SELECT 'grouped:'||g.id key,g.block_time occurred_at FROM public.investor_portfolio_tx g
  WHERE g.portfolio_id=p_portfolio_id AND g.org_id=p_org_id AND g.user_id=auth.uid() AND NOT g.is_display_mirror
   AND (p_type IS NULL OR g.type=p_type) AND (p_status IS NULL OR g.status=p_status OR (p_status='unclassified' AND g.classification_status='unclassified'))
   AND (v_search='' OR strpos(lower(concat_ws(' ',g.title,g.notes,g.tx_hash,g.signature,g.chain,g.protocol)),lower(v_search))>0 OR EXISTS(SELECT 1 FROM public.investor_portfolio_tx_line_items l WHERE l.tx_id=g.id AND l.portfolio_id=p_portfolio_id AND l.org_id=p_org_id AND l.user_id=auth.uid() AND strpos(lower(concat_ws(' ',l.symbol,l.name,l.canonical_asset_key)),lower(v_search))>0))
  UNION ALL
  SELECT m.event_key,min(m.timestamp) FROM manual_base m GROUP BY m.event_key
  HAVING bool_or(p_type IS NULL OR coalesce(nullif(m.raw_metadata->>'manual_pair_classification',''),m.transaction_type)=p_type)
   AND bool_or(p_status IS NULL OR p_status='success' OR (p_status='unclassified' AND m.classification_status='unclassified'))
   AND bool_or(v_search='' OR strpos(lower(concat_ws(' ',m.asset_symbol,m.canonical_asset_key,m.notes,m.chain,m.external_tx_hash,m.external_tx_signature)),lower(v_search))>0)
 ), chosen AS MATERIALIZED (
  SELECT r.* FROM refs r WHERE p_cursor IS NULL OR (p_direction='older' AND (coalesce(r.occurred_at,'-infinity'::timestamptz),r.key)<(v_time,v_key)) OR (p_direction='newer' AND (coalesce(r.occurred_at,'-infinity'::timestamptz),r.key)>(v_time,v_key))
  ORDER BY CASE WHEN p_direction='older' THEN coalesce(r.occurred_at,'-infinity'::timestamptz) END DESC,CASE WHEN p_direction='older' THEN r.key END DESC,CASE WHEN p_direction='newer' THEN coalesce(r.occurred_at,'-infinity'::timestamptz) END ASC,CASE WHEN p_direction='newer' THEN r.key END ASC LIMIT v_limit
 ), edges AS (
  SELECT (SELECT jsonb_build_object('key',key,'time',occurred_at) FROM chosen ORDER BY occurred_at DESC NULLS LAST,key DESC LIMIT 1) first,
   (SELECT jsonb_build_object('key',key,'time',occurred_at) FROM chosen ORDER BY occurred_at ASC NULLS FIRST,key ASC LIMIT 1) last
 ) SELECT jsonb_build_object(
  'total',(SELECT count(*) FROM refs),'limit',v_limit,'revision',v_revision,
  'order',coalesce((SELECT jsonb_agg(key ORDER BY occurred_at DESC NULLS LAST,key DESC) FROM chosen),'[]'),
  'newerCursor',e.first,'olderCursor',e.last,
  'hasOlder',EXISTS(SELECT 1 FROM refs r WHERE (coalesce(r.occurred_at,'-infinity'::timestamptz),r.key)<(coalesce((e.last->>'time')::timestamptz,'-infinity'::timestamptz),e.last->>'key')),
  'hasNewer',EXISTS(SELECT 1 FROM refs r WHERE (coalesce(r.occurred_at,'-infinity'::timestamptz),r.key)>(coalesce((e.first->>'time')::timestamptz,'-infinity'::timestamptz),e.first->>'key')),
  'grouped',coalesce((SELECT jsonb_agg((to_jsonb(g)-'raw')||jsonb_build_object('line_item_count',(SELECT count(*) FROM public.investor_portfolio_tx_line_items l WHERE l.tx_id=g.id AND l.org_id=p_org_id AND l.user_id=auth.uid() AND l.portfolio_id=p_portfolio_id),'line_items',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.leg_index,l.id) FROM (SELECT * FROM public.investor_portfolio_tx_line_items l WHERE l.tx_id=g.id AND l.org_id=p_org_id AND l.user_id=auth.uid() AND l.portfolio_id=p_portfolio_id ORDER BY l.leg_index,l.id LIMIT 8) l),'[]'))) FROM public.investor_portfolio_tx g JOIN chosen c ON c.key='grouped:'||g.id),'[]'),
  'manual',coalesce((SELECT jsonb_agg((to_jsonb(m)-'provider'-'raw_metadata')||jsonb_build_object('raw_metadata',jsonb_build_object('manual_group_id',m.raw_metadata->>'manual_group_id','manual_pair_classification',m.raw_metadata->>'manual_pair_classification','source',m.raw_metadata->>'source'),'source',jsonb_build_object('provider',m.provider,'source_type','manual'))) FROM manual_base m JOIN chosen c ON c.key=m.event_key),'[]')
 ) INTO v_result FROM edges e;
 RETURN v_result;
END;$$;

CREATE FUNCTION public.intel_portfolio_activity_legs(p_org_id uuid,p_portfolio_id uuid,p_tx_id uuid,p_page integer DEFAULT 0,p_limit integer DEFAULT 50,p_revision text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_revision text;v_count bigint;v_rows jsonb;v_limit integer:=greatest(1,least(100,coalesce(p_limit,50)));
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.investor_portfolio_tx g JOIN public.investor_portfolios p ON p.id=g.portfolio_id WHERE g.id=p_tx_id AND g.portfolio_id=p_portfolio_id AND g.org_id=p_org_id AND g.user_id=auth.uid() AND NOT g.is_display_mirror AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids())) THEN RAISE EXCEPTION 'Activity unavailable' USING ERRCODE='42501';END IF;
 IF p_page IS NULL OR p_page<0 OR p_page>1000000 THEN RAISE EXCEPTION 'Invalid activity leg page' USING ERRCODE='22023';END IF;
 SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(l)::text),'' ORDER BY l.leg_index,l.id),'')) INTO v_count,v_revision FROM public.investor_portfolio_tx_line_items l WHERE l.tx_id=p_tx_id AND l.org_id=p_org_id AND l.user_id=auth.uid() AND l.portfolio_id=p_portfolio_id;
 IF p_revision IS NOT NULL AND p_revision IS DISTINCT FROM v_revision THEN RAISE EXCEPTION 'Transaction legs changed. Reload this activity.' USING ERRCODE='40001';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.leg_index,l.id),'[]') INTO v_rows FROM (SELECT * FROM public.investor_portfolio_tx_line_items l WHERE l.tx_id=p_tx_id AND l.org_id=p_org_id AND l.user_id=auth.uid() AND l.portfolio_id=p_portfolio_id ORDER BY l.leg_index,l.id LIMIT v_limit OFFSET p_page::bigint*v_limit) l;
 RETURN jsonb_build_object('rows',v_rows,'total',v_count,'page',p_page,'limit',v_limit,'hasMore',(p_page::bigint+1)*v_limit<v_count,'revision',v_revision);
END;$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_activity_revision(uuid,uuid),public.intel_portfolio_activity_page(uuid,uuid,integer,jsonb,text,text,text,text,boolean,text),public.intel_portfolio_activity_legs(uuid,uuid,uuid,integer,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_activity_revision(uuid,uuid),public.intel_portfolio_activity_page(uuid,uuid,integer,jsonb,text,text,text,text,boolean,text),public.intel_portfolio_activity_legs(uuid,uuid,uuid,integer,integer,text) TO authenticated;
