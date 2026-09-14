-- Keep the existing membership, RLS, response, filters and limits. Select the
-- latest row identities before reading/sorting wide provider fields.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $migration$
DECLARE
 signature regprocedure := 'public.intel_defi_browse_page(uuid,text,text,text,text,text,text,integer,integer)'::regprocedure;
 definition text;
 old_selector text := $old$WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON (%1$s) %2$s FROM public.%3$I
      WHERE org_id IS NULL AND snapshot_at >= now()-interval '7 days' %4$s
      ORDER BY %1$s, snapshot_at DESC, id DESC
    ), shaped AS ($old$;
 new_selector text := $new$WITH latest_ids AS MATERIALIZED (
      SELECT DISTINCT ON (%1$s) id FROM public.%3$I
      WHERE org_id IS NULL AND snapshot_at >= now()-interval '7 days' %4$s
      ORDER BY %1$s, snapshot_at DESC, id DESC
    ), latest AS MATERIALIZED (
      SELECT %2$s FROM public.%3$I WHERE id IN (SELECT id FROM latest_ids)
    ), shaped AS ($new$;
BEGIN
 SELECT replace(pg_get_functiondef(signature),chr(13),'') INTO definition;
 IF (SELECT prosecdef FROM pg_proc WHERE oid=signature) OR
    cardinality(string_to_array(definition,old_selector))<>2 THEN
   RAISE EXCEPTION 'Unexpected DeFi browse definition; review before replacing';
 END IF;
 EXECUTE replace(definition,old_selector,new_selector);
END;
$migration$;
