-- Rank all categories, then hydrate full rows for the same eight winners.
-- No stored cache, clock change, contract change or authorization relaxation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $migration$
DECLARE current_definition text; previous_part constant text := $previous$ category_leaders AS (SELECT c.category,jsonb_agg(to_jsonb(b)||jsonb_build_object('category',c.category,'position',c.position,'members',c.members) ORDER BY c.position) AS leaders,max(c.mover_score) AS score
   FROM category_rows c JOIN base b ON b.source_provider=c.source_provider AND b.provider_id=c.provider_id
   WHERE c.members>=3 AND c.position<=3 GROUP BY c.category ORDER BY max(c.mover_score) DESC,c.category LIMIT 8),
$previous$;
next_part constant text := $next$ category_top AS MATERIALIZED (SELECT category,max(mover_score) AS score FROM category_rows
   WHERE members>=3 AND position<=3 GROUP BY category ORDER BY max(mover_score) DESC,category LIMIT 8),
 category_leaders AS (SELECT c.category,jsonb_agg(to_jsonb(b)||jsonb_build_object('category',c.category,'position',c.position,'members',c.members) ORDER BY c.position) AS leaders,t.score
   FROM category_top t JOIN category_rows c ON c.category=t.category
   JOIN base b ON b.source_provider=c.source_provider AND b.provider_id=c.provider_id
   WHERE c.members>=3 AND c.position<=3 GROUP BY c.category,t.score),
$next$;
BEGIN
  current_definition := pg_catalog.pg_get_functiondef('public.intel_markets_screen_for_user(uuid,uuid,jsonb)'::regprocedure);
  IF pg_catalog.md5(pg_catalog.replace(current_definition,next_part,previous_part)) <> 'f5e3b59644e59b43848ca50289daf570' THEN
    RAISE EXCEPTION 'Markets screener differs from reviewed definition; review before applying';
  END IF;
  IF (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid='public.intel_markets_screen_for_user(uuid,uuid,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'Markets screener must remain SECURITY INVOKER';
  END IF;
  IF pg_catalog.strpos(current_definition,previous_part)>0 THEN
    EXECUTE pg_catalog.replace(current_definition,previous_part,next_part);
  END IF;
END $migration$;
