-- ============================================================
-- Investor Intel — long chart windows reach the read functions (candle history, goal B follow-up)
-- ============================================================
-- The chart's 'ALL' range is twenty years, which the stored candle archive (market_asset_candles) can genuinely
-- answer. Two read functions still carry a window cap written when one year was the widest chart there was, so every
-- range above 1Y was refused BELOW the chart rather than drawn:
--
--   public.intel_chart_alert_history      'chart_alert_invalid_history' -> no alert markers on 2Y, 5Y or ALL.
--   public.intel_asset_portfolio_context  'invalid_range'               -> "Your position is unavailable" above 1Y.
--
-- Both caps rise from 366 days to 7301 (twenty years and a day of slack, matching MAX_CHART_WINDOW_MS in
-- _shared/intel/chart-alert-service.ts, _shared/intel/chart-workspace-contract.ts and src/intel/lib/portfolio-api.js).
-- Nothing else about either function changes: no new row is readable that was not readable before, the membership and
-- can_access_intel guards are untouched, and both reads stay paged by their own cursor and row limit, so a wider
-- window returns more PAGES rather than one unbounded result.
--
-- The edit is an ANCHORED PATCH against the LIVE definition, the way 20260911213014, 20260915004720 and
-- 20260915034150 patch intel_emit_bridged_alert. It is anchored on the interval literal alone rather than on a line of
-- surrounding text, so a difference in spacing between environments cannot make it miss; it asserts the literal occurs
-- EXACTLY ONCE in the function, so it can never widen some other window that happens to share the number, and it
-- refuses outright if the reviewed text has moved. A second run therefore fails rather than guessing.
--
-- ROLLBACK (restores the one-year caps; the long ranges then lose their markers and position lane again):
--   DO $undo$ DECLARE original text;changed text;BEGIN
--    original:=pg_get_functiondef('public.intel_chart_alert_history(uuid,uuid,text[],timestamptz,timestamptz,jsonb)'::regprocedure);
--    changed:=replace(original,'interval ''7301 days''','interval ''366 days''');
--    IF changed=original THEN RAISE EXCEPTION 'unexpected_history_definition';END IF;EXECUTE changed;
--    original:=pg_get_functiondef('public.intel_asset_portfolio_context(uuid,uuid,text,timestamptz,timestamptz,jsonb,integer)'::regprocedure);
--    changed:=replace(original,'interval ''7301 days''','interval ''366 days''');
--    IF changed=original THEN RAISE EXCEPTION 'unexpected_context_definition';END IF;EXECUTE changed;
--   END $undo$;
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: chart alert history window

DO $history$
DECLARE original text; changed text; occurrences integer;
BEGIN
  original := pg_get_functiondef('public.intel_chart_alert_history(uuid,uuid,text[],timestamptz,timestamptz,jsonb)'::regprocedure);
  occurrences := (length(original) - length(replace(original, 'interval ''366 days''', ''))) / length('interval ''366 days''');
  IF occurrences <> 1 THEN
    RAISE EXCEPTION 'unexpected_history_definition: % occurrences of the one-year window', occurrences;
  END IF;
  changed := replace(original, 'interval ''366 days''', 'interval ''7301 days''');
  EXECUTE changed;
END $history$;

-- SECTION: asset portfolio context window

DO $context$
DECLARE original text; changed text; occurrences integer;
BEGIN
  original := pg_get_functiondef('public.intel_asset_portfolio_context(uuid,uuid,text,timestamptz,timestamptz,jsonb,integer)'::regprocedure);
  occurrences := (length(original) - length(replace(original, 'interval ''366 days''', ''))) / length('interval ''366 days''');
  IF occurrences <> 1 THEN
    RAISE EXCEPTION 'unexpected_context_definition: % occurrences of the one-year window', occurrences;
  END IF;
  changed := replace(original, 'interval ''366 days''', 'interval ''7301 days''');
  EXECUTE changed;
END $context$;
