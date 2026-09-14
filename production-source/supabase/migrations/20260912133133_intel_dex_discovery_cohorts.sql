-- Add public discovery membership to the existing immutable cohort store.
-- No private words, positions, account grants or existing memberships change.
ALTER TABLE public.intel_market_cohorts DROP CONSTRAINT intel_market_cohorts_kind_check;
ALTER TABLE public.intel_market_cohorts ADD CONSTRAINT intel_market_cohorts_kind_check
 CHECK(kind IN ('sector','new_listings','dex_discovery'));
ALTER TABLE public.intel_market_cohorts ADD COLUMN source_reference jsonb;
ALTER TABLE public.intel_market_cohorts ADD CONSTRAINT intel_cohort_source_reference_shape
 CHECK(source_reference IS NULL OR (jsonb_typeof(source_reference)='object' AND octet_length(source_reference::text)<=8192));
ALTER TABLE public.intel_market_cohorts ADD CONSTRAINT intel_dex_cohort_source_required
 CHECK(kind<>'dex_discovery' OR (source_reference IS NOT NULL AND jsonb_array_length(members)<=75));

CREATE OR REPLACE FUNCTION public.intel_dex_cohort_quotes(p_cohort uuid,p_at timestamptz)
RETURNS TABLE(subject text,observation jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF p_at IS NULL OR p_at>statement_timestamp() OR p_at<'1970-01-01'::timestamptz THEN
  RAISE EXCEPTION 'invalid_cohort_time';
 END IF;
 RETURN QUERY
 SELECT m.value->>'subject',o.observation
 FROM public.intel_market_cohorts c
 CROSS JOIN LATERAL jsonb_array_elements(c.members) WITH ORDINALITY AS m(value,ordinality)
 LEFT JOIN LATERAL (
  SELECT h.observation FROM public.intel_market_observations h
  WHERE h.subject=m.value->>'subject' AND h.metric='price' AND h.provider='coinmarketcap'
   AND h.observation->>'unit'='USD' AND h.observed_at<=p_at AND h.recorded_at<=p_at
   AND h.retain_until>statement_timestamp()
  ORDER BY h.observed_at DESC,h.id DESC LIMIT 1
 ) o ON true
 WHERE c.id=p_cohort AND c.kind='dex_discovery' AND c.created_at<=p_at
  AND c.retain_until>statement_timestamp()
 ORDER BY m.ordinality LIMIT 75;
END $$;
REVOKE ALL ON FUNCTION public.intel_dex_cohort_quotes(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_dex_cohort_quotes(uuid,timestamptz) TO service_role;
