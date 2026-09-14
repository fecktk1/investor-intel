-- Source facts only. Personal book/list membership is joined after authorization.
ALTER TABLE public.token_unlocks ADD COLUMN IF NOT EXISTS canonical_asset_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.token_unlocks ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE public.token_unlocks ADD COLUMN IF NOT EXISTS event_status text NOT NULL DEFAULT 'scheduled' CHECK(event_status IN('scheduled','cancelled','postponed','completed','unknown'));
CREATE TABLE public.intel_calendar_versions(
 version bigint GENERATED ALWAYS AS IDENTITY UNIQUE, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_kind text NOT NULL CHECK(source_kind IN('macro','unlock')),source_id uuid NOT NULL,
 asset_keys text[] NOT NULL DEFAULT '{}',title text NOT NULL,scheduled_at timestamptz,event_date date,
 time_precision text NOT NULL CHECK(time_precision IN('instant','date','unknown')),event_status text NOT NULL,
 source text,source_ref text,source_url text,observed_at timestamptz,expires_at timestamptz,
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),backfilled boolean NOT NULL DEFAULT false,detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX intel_calendar_version_lookup ON public.intel_calendar_versions(source_kind,source_id,recorded_at DESC,version DESC);
CREATE INDEX intel_calendar_asset_lookup ON public.intel_calendar_versions USING gin(asset_keys);
ALTER TABLE public.intel_calendar_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY calendar_member_read ON public.intel_calendar_versions FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.org_members WHERE user_id=(SELECT auth.uid())));
GRANT SELECT ON public.intel_calendar_versions TO authenticated;
GRANT ALL ON public.intel_calendar_versions TO service_role;
CREATE FUNCTION app_private.intel_record_calendar_version() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE rowdata jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END; kind text:=CASE WHEN TG_TABLE_NAME='token_unlocks' THEN 'unlock' ELSE 'macro' END; fact jsonb; latest public.intel_calendar_versions; keys text[]:='{}'; stamp timestamptz; day date; status text;
BEGIN
 IF kind='unlock' THEN
  SELECT coalesce(array_agg(value),'{}') INTO keys FROM jsonb_array_elements_text(coalesce(rowdata->'canonical_asset_keys','[]')) value;
  stamp:=(rowdata->>'scheduled_at')::timestamptz;day:=(rowdata->>'unlock_date')::date;
  status:=coalesce(rowdata->>'event_status','unknown');
  fact:=jsonb_build_object('title',upper(rowdata->>'token_symbol')||' token unlock','source',rowdata->>'provider','source_ref',rowdata->>'source_ref','source_url',NULL,'observed_at',rowdata->>'fetched_at','expires_at',rowdata->>'stale_after','detail',jsonb_build_object('amount',rowdata->'amount','pct_supply',rowdata->'pct_supply','supply_unit','provider unspecified'));
 ELSE
  stamp:=(rowdata->>'scheduled_at')::timestamptz;
  status:=lower(coalesce(rowdata->'raw'->>'status','scheduled'));
  IF status NOT IN('scheduled','cancelled','postponed','completed','unknown') THEN status:='unknown'; END IF;
  fact:=jsonb_build_object('title',rowdata->>'title','source',rowdata->'raw'->>'source','source_ref',rowdata->>'event_key','source_url',rowdata->>'source_url','observed_at',rowdata->>'updated_at','expires_at',NULL,'detail',jsonb_build_object('country',rowdata->'country','importance',rowdata->'importance','forecast',rowdata->'forecast','previous',rowdata->'previous','actual',rowdata->'actual'));
 END IF;
 IF TG_OP='DELETE' THEN status:='cancelled'; END IF;
 -- Refreshes remain distinct observation versions; never back-date what was known.
 SELECT * INTO latest FROM public.intel_calendar_versions WHERE source_kind=kind AND source_id=(rowdata->>'id')::uuid ORDER BY recorded_at DESC,version DESC LIMIT 1;
 IF FOUND AND ROW(latest.asset_keys,latest.title,latest.scheduled_at,latest.event_date,latest.event_status,latest.observed_at,latest.detail) IS NOT DISTINCT FROM ROW(keys,fact->>'title',stamp,day,status,(fact->>'observed_at')::timestamptz,fact->'detail') THEN RETURN NULL; END IF;
 INSERT INTO public.intel_calendar_versions(source_kind,source_id,asset_keys,title,scheduled_at,event_date,time_precision,event_status,source,source_ref,source_url,observed_at,expires_at,detail)
 VALUES(kind,(rowdata->>'id')::uuid,keys,fact->>'title',stamp,day,CASE WHEN stamp IS NOT NULL THEN 'instant' WHEN day IS NOT NULL THEN 'date' ELSE 'unknown' END,status,fact->>'source',fact->>'source_ref',fact->>'source_url',(fact->>'observed_at')::timestamptz,(fact->>'expires_at')::timestamptz,fact->'detail');
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_record_calendar_version() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_macro_calendar_versions AFTER INSERT OR UPDATE OR DELETE ON public.intel_macro_calendar FOR EACH ROW EXECUTE FUNCTION app_private.intel_record_calendar_version();
CREATE TRIGGER intel_unlock_calendar_versions AFTER INSERT OR UPDATE OR DELETE ON public.token_unlocks FOR EACH ROW EXECUTE FUNCTION app_private.intel_record_calendar_version();
-- Supported current observations only. The mutable past is not reconstructed.
INSERT INTO public.intel_calendar_versions(source_kind,source_id,title,scheduled_at,time_precision,event_status,source,source_ref,source_url,observed_at,backfilled,detail)
SELECT 'macro',id,title,scheduled_at,'instant',CASE WHEN lower(raw->>'status') IN('cancelled','postponed','completed','unknown') THEN lower(raw->>'status') ELSE 'scheduled' END,raw->>'source',event_key,source_url,updated_at,true,jsonb_build_object('country',country,'importance',importance,'forecast',forecast,'previous',previous,'actual',actual) FROM public.intel_macro_calendar;
INSERT INTO public.intel_calendar_versions(source_kind,source_id,asset_keys,title,scheduled_at,event_date,time_precision,event_status,source,source_ref,observed_at,expires_at,backfilled,detail)
SELECT 'unlock',id,canonical_asset_keys,upper(token_symbol)||' token unlock',scheduled_at,unlock_date,CASE WHEN scheduled_at IS NULL THEN 'date' ELSE 'instant' END,event_status,provider,source_ref,fetched_at,stale_after,true,jsonb_build_object('amount',amount,'pct_supply',pct_supply,'supply_unit','provider unspecified') FROM public.token_unlocks;

CREATE FUNCTION public.intel_book_calendar(p_org_id uuid,p_portfolio_id uuid DEFAULT NULL,p_watchlist_id uuid DEFAULT NULL,p_asset text DEFAULT NULL,p_from timestamptz DEFAULT now(),p_to timestamptz DEFAULT now()+interval '72 hours',p_known_at timestamptz DEFAULT now(),p_page integer DEFAULT 0,p_include_inactive boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE keys text[]:='{}'; result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=auth.uid()) THEN RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE='42501'; END IF;
 IF p_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.investor_portfolios WHERE id=p_portfolio_id AND org_id=p_org_id AND user_id=auth.uid()) THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501'; END IF;
 IF p_watchlist_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.watchlists WHERE id=p_watchlist_id AND org_id=p_org_id) THEN RAISE EXCEPTION 'Watchlist unavailable' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>interval '366 days' OR p_known_at IS NULL OR p_known_at>now()+interval '30 seconds' OR p_page IS NULL OR p_page<0 OR p_page>10000 OR length(p_asset)>240 THEN RAISE EXCEPTION 'Invalid calendar window' USING ERRCODE='22023'; END IF;
 IF p_asset IS NOT NULL THEN keys:=ARRAY[p_asset]; ELSE
  SELECT coalesce(array_agg(DISTINCT key) FILTER(WHERE key IS NOT NULL),'{}') INTO keys FROM (
   SELECT canonical_asset_key key FROM public.investor_portfolio_holdings WHERE portfolio_id=p_portfolio_id AND org_id=p_org_id AND user_id=auth.uid() AND NOT coalesce(is_closed,false)
   UNION ALL SELECT e.canonical_ref_key FROM public.watchlist_items i JOIN public.entities e ON e.id=i.entity_id AND e.org_id=i.org_id WHERE i.org_id=p_org_id AND i.watchlist_id=p_watchlist_id
   UNION ALL SELECT CASE WHEN e.chain_namespace='eip155' THEN 'eip155:'||e.chain_id||':'||CASE WHEN e.asset_type='native' THEN 'native' ELSE lower(e.contract_address) END WHEN e.asset_type='native' THEN e.chain_namespace||':native:'||upper(e.native_symbol) ELSE e.chain_namespace||':'||e.contract_address END
    FROM public.watchlist_items i JOIN public.entities e ON e.id=i.entity_id AND e.org_id=i.org_id WHERE i.org_id=p_org_id AND i.watchlist_id=p_watchlist_id AND e.entity_kind='asset'
  ) subjects;
 END IF;
 WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON(source_kind,source_id) * FROM public.intel_calendar_versions WHERE recorded_at<=p_known_at ORDER BY source_kind,source_id,recorded_at DESC,version DESC
 ), windowed AS MATERIALIZED (
  SELECT *,CASE WHEN source_kind='macro' THEN 'Market-wide' ELSE 'Selected assets' END relevance FROM latest
  WHERE (scheduled_at BETWEEN p_from AND p_to OR (scheduled_at IS NULL AND event_date BETWEEN (p_from AT TIME ZONE 'UTC')::date AND (p_to AT TIME ZONE 'UTC')::date))
 ), selected AS MATERIALIZED (
  SELECT * FROM windowed WHERE (source_kind='macro' OR asset_keys && keys) AND (p_include_inactive OR event_status='scheduled')
 ), page AS (
  SELECT * FROM selected ORDER BY coalesce(scheduled_at,event_date::timestamp AT TIME ZONE 'UTC'),source_kind,source_id LIMIT 30 OFFSET p_page*30
 ) SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'),'hasMore',(SELECT count(*) FROM selected)>(p_page+1)*30,'page',p_page,'unmatchedUnlocks',(SELECT count(*) FROM windowed WHERE source_kind='unlock' AND cardinality(asset_keys)=0),'knownAt',p_known_at,'from',p_from,'to',p_to,'scope',CASE WHEN p_asset IS NOT NULL THEN 'asset' ELSE 'book' END) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_book_calendar(uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,integer,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_book_calendar(uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,integer,boolean) TO authenticated;
