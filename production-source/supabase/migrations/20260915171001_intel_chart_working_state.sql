-- ============================================================
-- Investor Intel — the chart WORKING STATE, one per member per asset
-- ============================================================
-- A saved layout (`intel_chart_layouts`, 20260910145255) is an explicit, NAMED act: the member presses Save layout and
-- gives it a title. This table is the other thing entirely, and the two never replace each other:
--
--   intel_chart_working_states   ONE row per organization, member and asset, holding the chart exactly as that member
--                                last left it: their drawings and the time/price anchors under them, their indicators
--                                and the parameters on each, the view mode, price scale, layout preset, time zone,
--                                chart size, marker visibility, the visible window and the candle width. It is written
--                                automatically a couple of seconds after the last change, and read once when the chart
--                                is opened again. Nothing here is named, listed or shared.
--
-- RULES the schema enforces, not only the client:
--   * ONE working state per member per asset. The primary key (org_id, user_id, asset) makes a second, contradictory
--     state for the same chart impossible, so "come back in a day" can only ever find one answer.
--   * The state is the SAME shape a saved layout carries, validated by the same contract
--     (`chart-workspace-contract.ts`, `validateChartLayout`). The CHECK repeats only what SQL can see: an object, the
--     schema version, the asset agreeing with the column it is filed under, and a size bound.
--   * Service role only. RLS is enabled and NO policy is written, exactly like the capture tables: every read and write
--     goes through the `intel-chart-workspace` Edge Function, which checks organization membership and Intel access
--     first. `authenticated` and `anon` hold no privilege at all, so a browser cannot reach a coworker's drawings even
--     with a forged org id.
--   * The revision is a MONOTONIC counter, not a lock. A working state is a draft: the last write wins and the caller
--     is told the revision its write produced. What the revision buys is idempotence, below.
--
-- IDEMPOTENT BY REVISION. The autosave debounces, retries a refused save on the next change, and flushes when the tab
-- is hidden, so the same state can genuinely arrive twice. `intel_save_chart_working_state` therefore writes NOTHING
-- when the caller's revision is no newer than the stored one AND the stored state is already byte-for-byte the state
-- being written; it returns the stored revision with `applied` false. Every other call applies and returns
-- `old.revision + 1`. That is last-write-wins with the revision returned, and a duplicate never bumps the counter.
--
-- RETENTION PATCH, NOT A RESTATEMENT. A working state nobody has opened for 400 days is removed. 400 days is one year
-- plus a season: a chart returned to annually survives, a chart abandoned does not. Like 20260915034403 (and the alert
-- bridge patches before it) the DELETE block is INSERTED INTO THE LIVE DEFINITION of
-- `app_private.intel_capture_retention` immediately before its single `RETURN removed;`. A full restatement here would
-- silently drop whichever lane's block landed between that restatement's author and today. If the anchor has moved the
-- patch RAISES rather than guessing, and it refuses a second run rather than adding the block twice.
--
-- Safe to apply anytime, once. The table is a plain CREATE TABLE and the retention patch refuses a second run, so a
-- re-application is rejected loudly rather than silently doubling the retention block.
--
-- ROLLBACK
--   DROP FUNCTION public.intel_save_chart_working_state(uuid,uuid,text,integer,jsonb);
--   DROP TABLE public.intel_chart_working_states;
--   -- and remove the block this migration inserted into app_private.intel_capture_retention (otherwise the nightly
--   -- job errors on its next run against the dropped table):
--   DO $undo$ DECLARE original text; changed text; BEGIN
--     original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
--     changed  := regexp_replace(original,
--       '\n  -- Added by 20260916030000.*?jsonb_build_object\(''intel_chart_working_states'', n\);\n', E'\n', 'n');
--     IF changed = original THEN RAISE EXCEPTION 'chart_working_state_retention_block_not_found'; END IF;
--     EXECUTE changed;
--   END $undo$;
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: chart working state table

CREATE TABLE public.intel_chart_working_states (
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- The canonical asset key the chart was opened under, exactly as `chartAsset()` validated it.
  asset text NOT NULL CHECK (length(asset) BETWEEN 1 AND 240),
  -- The same object a saved layout stores, validated by the same contract before it ever reaches this column.
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object' AND state->>'schemaVersion' = '1' AND state->>'asset' = asset AND octet_length(state::text) <= 200000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One working state per member per asset. This IS the uniqueness rule; no second index repeats it.
  PRIMARY KEY (org_id, user_id, asset)
);
-- Retention scans by staleness, and nothing else reads this table by time.
CREATE INDEX intel_chart_working_state_stale ON public.intel_chart_working_states (updated_at);

ALTER TABLE public.intel_chart_working_states ENABLE ROW LEVEL SECURITY;
-- No policy, deliberately: the Edge Function is the only reader and the only writer.
REVOKE ALL ON TABLE public.intel_chart_working_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_chart_working_states TO service_role;

-- SECTION: chart working state save

CREATE OR REPLACE FUNCTION public.intel_save_chart_working_state(p_org uuid, p_user uuid, p_asset text, p_revision integer, p_state jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE old public.intel_chart_working_states; saved public.intel_chart_working_states;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_org AND user_id = p_user) OR public.can_access_intel(p_user, p_org) IS NOT TRUE THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_asset IS NULL OR length(p_asset) NOT BETWEEN 1 AND 240 OR p_revision IS NULL OR p_revision < 0
    OR p_state IS NULL OR jsonb_typeof(p_state) <> 'object' OR p_state->>'schemaVersion' IS DISTINCT FROM '1'
    OR p_state->>'asset' IS DISTINCT FROM p_asset OR octet_length(p_state::text) > 200000
    OR jsonb_typeof(p_state->'drawings') IS DISTINCT FROM 'array' OR jsonb_typeof(p_state->'studies') IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'invalid_chart_working_state'; END IF;
  IF jsonb_array_length(p_state->'drawings') > 200 OR jsonb_array_length(p_state->'studies') > 20 THEN RAISE EXCEPTION 'chart_layout_limit'; END IF;

  SELECT * INTO old FROM public.intel_chart_working_states WHERE org_id = p_org AND user_id = p_user AND asset = p_asset FOR UPDATE;
  -- A retry carrying a revision no newer than the stored one, for a state already stored, is the SAME write arriving
  -- twice. It changes nothing and does not bump the counter.
  IF FOUND AND p_revision <= old.revision AND old.state = p_state THEN
    RETURN jsonb_build_object('revision', old.revision, 'updatedAt', old.updated_at, 'applied', false);
  END IF;

  -- Otherwise the newest write wins. ON CONFLICT rather than a branch on FOUND, so two tabs inserting the first state
  -- for one chart at the same moment produce one row rather than a primary-key error.
  INSERT INTO public.intel_chart_working_states (org_id, user_id, asset, state)
  VALUES (p_org, p_user, p_asset, p_state)
  ON CONFLICT (org_id, user_id, asset) DO UPDATE
    SET state = excluded.state, revision = intel_chart_working_states.revision + 1, updated_at = clock_timestamp()
  RETURNING * INTO saved;
  RETURN jsonb_build_object('revision', saved.revision, 'updatedAt', saved.updated_at, 'applied', true);
END $$;
REVOKE ALL ON FUNCTION public.intel_save_chart_working_state(uuid,uuid,text,integer,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_save_chart_working_state(uuid,uuid,text,integer,jsonb) TO service_role;

-- SECTION: chart working state retention

-- 400 days of untouched working states, PATCHED into the live definition (see the header).
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  -- Refuse a second application rather than adding the same DELETE block twice.
  IF position('intel_chart_working_states' in original) > 0 THEN
    RAISE EXCEPTION 'chart_working_state_retention_block_already_present';
  END IF;
  -- Exactly one `RETURN removed;` is what makes the insertion point unambiguous. Any other count means the function is
  -- not the one this migration was written against, and guessing at a second anchor is how a lane's horizon gets lost.
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by 20260916030000 (chart working state). A chart nobody has opened for 400 days is forgotten.\n'
    || E'  DELETE FROM public.intel_chart_working_states WHERE updated_at < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_chart_working_states'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
