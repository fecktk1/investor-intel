-- ============================================================
-- 191: Investor Intel — data preservation + reset (BACKUP BEFORE DELETE)
-- ============================================================
-- Re-derivable synced data is cleared so the rebuilt pipeline repopulates it with
-- canonical keys + grouped transactions. EVERYTHING is backed up first, in ONE
-- transaction, with survivor asserts before it can commit. Deterministic backup
-- names (_backup_191) — no dynamic SQL in the names, so execution can't break.
--
-- DELETED (re-derivable): synced flat txns (non-manual source AND not
--   user_corrected) + ALL holdings (holdings are a derived cache, rebuilt on the
--   next sync/recompute from preserved transactions + fresh wallet data).
-- PRESERVED (never touched): manual transactions (source_type='manual'),
--   user_corrected rows, investor_portfolio_cost_basis_overrides, AI memory
--   (investor_portfolio_memory), and all alert tables (not referenced here).
--
-- RESTORE (idempotent) — see the final output / deploy doc:
--   INSERT INTO investor_portfolio_holdings (<cols>) SELECT <cols>
--     FROM investor_portfolio_holdings_backup_191
--     ON CONFLICT (portfolio_id, canonical_asset_key) WHERE canonical_asset_key IS NOT NULL DO NOTHING;
--   INSERT INTO investor_portfolio_transactions (<cols>) SELECT <cols>
--     FROM investor_portfolio_transactions_backup_191
--     ON CONFLICT DO NOTHING;
-- (Explicit column lists are generated in the final output; re-running is a no-op.)
-- ============================================================

DO $$
DECLARE
  v_manual_before   bigint; v_manual_after   bigint;
  v_override_before bigint; v_override_after bigint;
  v_memory_before   bigint; v_memory_after   bigint;
BEGIN
  -- Survivor baselines (must be unchanged at COMMIT)
  SELECT count(*) INTO v_manual_before FROM investor_portfolio_transactions t
    JOIN investor_portfolio_sources s ON s.id = t.source_id
    WHERE s.source_type = 'manual' OR t.classification_status = 'user_corrected';
  SELECT count(*) INTO v_override_before FROM investor_portfolio_cost_basis_overrides;
  SELECT count(*) INTO v_memory_before   FROM investor_portfolio_memory;

  -- 1. Backups BEFORE any delete (deterministic names; idempotent on re-run)
  EXECUTE 'CREATE TABLE IF NOT EXISTS investor_portfolio_holdings_backup_191 AS '
       || 'SELECT * FROM investor_portfolio_holdings';
  EXECUTE 'CREATE TABLE IF NOT EXISTS investor_portfolio_transactions_backup_191 AS '
       || 'SELECT t.* FROM investor_portfolio_transactions t '
       || 'JOIN investor_portfolio_sources s ON s.id = t.source_id '
       || 'WHERE s.source_type <> ''manual'' AND t.classification_status <> ''user_corrected''';

  -- 2. Delete only re-derivable synced data
  DELETE FROM investor_portfolio_transactions t
    USING investor_portfolio_sources s
    WHERE t.source_id = s.id
      AND s.source_type <> 'manual'
      AND t.classification_status <> 'user_corrected';
  DELETE FROM investor_portfolio_holdings;   -- derived cache; rebuilt on next sync/recompute

  -- 3. Backfill canonical keys on preserved (manual / user-corrected) rows
  UPDATE investor_portfolio_transactions
    SET canonical_asset_key = public.canonical_asset_key(chain, asset_symbol, contract_address)
    WHERE canonical_asset_key IS NULL AND chain IS NOT NULL;

  -- 4. Reset cursors + source sync status so the next sync re-derives cleanly
  TRUNCATE investor_portfolio_sync_cursors;
  UPDATE investor_portfolio_sources
    SET holdings_sync_status = NULL, transaction_sync_status = NULL,
        last_holdings_sync_at = NULL, last_transaction_sync_at = NULL
    WHERE source_type <> 'manual';

  -- 5. Survivor asserts — abort (roll back everything) if anything protected changed
  SELECT count(*) INTO v_manual_after FROM investor_portfolio_transactions t
    JOIN investor_portfolio_sources s ON s.id = t.source_id
    WHERE s.source_type = 'manual' OR t.classification_status = 'user_corrected';
  SELECT count(*) INTO v_override_after FROM investor_portfolio_cost_basis_overrides;
  SELECT count(*) INTO v_memory_after   FROM investor_portfolio_memory;

  IF v_manual_after <> v_manual_before THEN
    RAISE EXCEPTION '191 survivor check failed: manual/user_corrected txns % -> %', v_manual_before, v_manual_after;
  END IF;
  IF v_override_after <> v_override_before THEN
    RAISE EXCEPTION '191 survivor check failed: cost-basis overrides % -> %', v_override_before, v_override_after;
  END IF;
  IF v_memory_after <> v_memory_before THEN
    RAISE EXCEPTION '191 survivor check failed: portfolio memory % -> %', v_memory_before, v_memory_after;
  END IF;
END $$;

-- Backup tables hold all users' synced data → service-role only (RLS on, no policy).
ALTER TABLE investor_portfolio_holdings_backup_191     ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_portfolio_transactions_backup_191 ENABLE ROW LEVEL SECURITY;
