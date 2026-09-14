-- Historical sector and global-listing cohorts use the original membership and
-- the latest permitted price known at the selected cursor. No provider request,
-- new table, changed records, private positions or broader access grants.
CREATE FUNCTION public.intel_global_cohort_quotes(p_cohort uuid,p_at timestamptz)
RETURNS TABLE(subject text,observation jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF p_at IS NULL OR p_at>statement_timestamp() OR p_at<'1970-01-01'::timestamptz THEN
  RAISE EXCEPTION 'invalid_cohort_time';
 END IF;
 IF EXISTS(
  SELECT 1 FROM public.intel_market_cohorts c
  CROSS JOIN LATERAL jsonb_array_elements(c.members) m
  WHERE c.id=p_cohort AND c.kind IN ('sector','new_listings')
   AND (m->>'subject' IS NULL OR m->>'subject' !~ '^market:coinmarketcap:[1-9][0-9]{0,11}$')
 ) THEN RAISE EXCEPTION 'invalid_cohort_identity'; END IF;
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
 WHERE c.id=p_cohort AND c.kind IN ('sector','new_listings') AND c.provider='coinmarketcap'
  AND c.created_at<=p_at AND c.retain_until>statement_timestamp()
 ORDER BY m.ordinality LIMIT 100;
END $$;
REVOKE ALL ON FUNCTION public.intel_global_cohort_quotes(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_global_cohort_quotes(uuid,timestamptz) TO service_role;
