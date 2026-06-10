-- ============================================================
-- 227: Investor Intel — safe prune / tombstone framework (DRY-RUN by default)
-- ============================================================
-- DESTRUCTIVE PRUNING IS DISABLED BY DEFAULT. This migration adds NO scheduled
-- deletes. It provides:
--   * intel_prune_preview()  — COUNT-ONLY; never deletes. Reports eligible vs
--     protected rows per configured table, respecting retain_forever / evergreen
--     / important / historic / retain_until.
--   * intel_prune_execute()  — guarded delete: requires super-admin AND the
--     table's destructive_enabled=true (intel_retention_config) AND p_confirm.
--     Takes an advisory lock, batches, and UPSERTS hash memory BEFORE deleting
--     (so dedupe never regresses). Returns counts.
-- Tests (prune-map.test.ts) prove retain_forever / evergreen rows are protected.
-- ============================================================

-- column-exists helper (build predicates only for columns a table actually has)
CREATE OR REPLACE FUNCTION _intel_col_exists(p_table text, p_col text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=p_table AND column_name=p_col);
$$;

-- Build the "eligible for prune" WHERE clause for a table from its config + the
-- guard columns it has. Eligible = older than the standard interval AND not
-- protected (retain_forever / evergreen|important|historic tier / retain_until).
CREATE OR REPLACE FUNCTION _intel_prune_predicate(p_table text, p_time_col text, p_interval interval)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE pred text;
BEGIN
  pred := format('%I < now() - interval %L', p_time_col, p_interval::text);
  IF _intel_col_exists(p_table, 'retain_forever') THEN pred := pred || ' AND retain_forever IS NOT TRUE'; END IF;
  IF _intel_col_exists(p_table, 'retain_until')  THEN pred := pred || ' AND (retain_until IS NULL OR retain_until < now())'; END IF;
  IF _intel_col_exists(p_table, 'retention_tier') THEN pred := pred || ' AND retention_tier NOT IN (''evergreen'',''important'',''historic'')'; END IF;
  RETURN pred;
END $$;

-- COUNT-ONLY preview. Safe for anyone super-admin to run anytime. Never deletes.
CREATE OR REPLACE FUNCTION intel_prune_preview(p_table text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE rec record; total bigint; eligible bigint; result jsonb := '[]'::jsonb; pred text;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  FOR rec IN SELECT * FROM intel_retention_config WHERE enabled AND (p_table IS NULL OR table_name = p_table) ORDER BY table_name LOOP
    IF to_regclass(rec.table_name) IS NULL OR NOT _intel_col_exists(rec.table_name, rec.time_column) THEN CONTINUE; END IF;
    pred := _intel_prune_predicate(rec.table_name, rec.time_column, rec.standard_interval);
    EXECUTE format('SELECT count(*) FROM %I', rec.table_name) INTO total;
    EXECUTE format('SELECT count(*) FROM %I WHERE %s', rec.table_name, pred) INTO eligible;
    result := result || jsonb_build_object(
      'table', rec.table_name, 'tier', rec.tier, 'interval', rec.standard_interval::text,
      'total_rows', total, 'eligible_for_prune', eligible, 'protected_rows', total - eligible,
      'destructive_enabled', rec.destructive_enabled, 'would_delete', CASE WHEN rec.destructive_enabled THEN eligible ELSE 0 END,
      'batch_limit', rec.batch_limit);
  END LOOP;
  RETURN jsonb_build_object('dry_run', true, 'generated_at', now(), 'tables', result);
END $$;

-- Guarded delete. No-ops (returns skipped) unless destructive_enabled AND
-- p_confirm. UPSERTS hash memory BEFORE deleting so dedupe never regresses.
CREATE OR REPLACE FUNCTION intel_prune_execute(p_table text, p_confirm boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cfg intel_retention_config; pred text; deleted int := 0; lock_key bigint; doomed_ids uuid[];
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO cfg FROM intel_retention_config WHERE table_name = p_table;
  IF cfg IS NULL THEN RETURN jsonb_build_object('skipped', true, 'reason', 'no_config'); END IF;
  IF NOT cfg.destructive_enabled THEN RETURN jsonb_build_object('skipped', true, 'reason', 'destructive_disabled', 'table', p_table); END IF;
  IF NOT p_confirm THEN RETURN jsonb_build_object('skipped', true, 'reason', 'confirm_required', 'table', p_table); END IF;
  IF to_regclass(p_table) IS NULL OR NOT _intel_col_exists(p_table, cfg.time_column) THEN RETURN jsonb_build_object('skipped', true, 'reason', 'table_or_column_missing'); END IF;

  lock_key := ('x' || substr(md5('intel_prune:' || p_table), 1, 15))::bit(60)::bigint;
  IF NOT pg_try_advisory_xact_lock(lock_key) THEN RETURN jsonb_build_object('skipped', true, 'reason', 'locked'); END IF;

  pred := _intel_prune_predicate(p_table, cfg.time_column, cfg.standard_interval);

  IF p_table = 'signal_raw_items' THEN
    -- Capture the doomed rows FIRST (stable under the advisory lock), memorize
    -- their hashes, THEN delete by id. Explicit ordering — a non-referenced CTE
    -- could be optimized away, so hash memory must NOT live in the delete CTE.
    SELECT array_agg(id) INTO doomed_ids FROM (
      SELECT id FROM signal_raw_items
      WHERE fetched_at < now() - cfg.standard_interval
        AND retain_forever IS NOT TRUE AND (retain_until IS NULL OR retain_until < now())
        AND retention_tier NOT IN ('evergreen','important','historic')
      ORDER BY fetched_at LIMIT cfg.batch_limit
    ) s;
    IF doomed_ids IS NULL THEN RETURN jsonb_build_object('table', p_table, 'deleted', 0, 'more_remaining', false); END IF;
    PERFORM intel_hash_memory_upsert('content', content_hash, canonical_url, title, NULL, NULL, '{}','{}','{}','{}', COALESCE(published_at, fetched_at))
      FROM signal_raw_items WHERE id = ANY(doomed_ids) AND content_hash IS NOT NULL;
    PERFORM intel_hash_memory_upsert('dedup', dedup_key, canonical_url, title, NULL, NULL, '{}','{}','{}','{}', COALESCE(published_at, fetched_at))
      FROM signal_raw_items WHERE id = ANY(doomed_ids) AND dedup_key IS NOT NULL;
    DELETE FROM signal_raw_items WHERE id = ANY(doomed_ids);
    GET DIAGNOSTICS deleted = ROW_COUNT;
  ELSE
    EXECUTE format(
      'WITH doomed AS (SELECT ctid FROM %I WHERE %s LIMIT %s) DELETE FROM %I t USING doomed d WHERE t.ctid = d.ctid',
      p_table, pred, cfg.batch_limit, p_table);
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('table', p_table, 'deleted', deleted, 'batch_limit', cfg.batch_limit, 'more_remaining', deleted >= cfg.batch_limit);
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['_intel_col_exists(text,text)','_intel_prune_predicate(text,text,interval)','intel_prune_preview(text)','intel_prune_execute(text,boolean)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION intel_prune_preview(text) TO authenticated, service_role';   -- self-gated super-admin
  EXECUTE 'GRANT EXECUTE ON FUNCTION intel_prune_execute(text,boolean) TO service_role';           -- service-role only
END $$;
