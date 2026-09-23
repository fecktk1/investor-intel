-- Investor Intel: chart candles from STORED prices.
--
-- The public demo (/intel/demo) may never ask a provider, and a member's chart
-- has no live candle source for some assets and ranges (a sub-hour range on an
-- asset with no verified exchange listing, a tokenised real-world asset token).
-- Both are answered from prices we already store:
--
--   intel_market_observations  CoinMarketCap quotes (metric 'price'), about every
--                              2 to 5 minutes for assets in use and hourly for the
--                              rest of the top 1,000.
--   market_asset_snapshots     the CoinGecko catalogue, every 30 minutes.
--   intel_rwa_wrapper_tokens   the six-hourly RWA wrapper captures.
--   intel_rwa_coverage_tokens  the daily RWA universe coverage capture.
--   market_asset_candles       the stored daily candle archive.
--   intel_rwa_wrapper_premium_backfill  daily closes from the CoinMarketCap OHLCV backfill.
--
-- Nothing here fabricates a price. A bucket's open, high, low and close are the
-- first, highest, lowest and last STORED price inside it; a bucket with no stored
-- price is not returned, so a gap stays a gap. A backfill day carries its close
-- only, and is returned as a close.
--
-- 1. intel_quote_tape: the CoinMarketCap price observations, one narrow row each.
--    The observation table is 17 GB and a price is one row in eight, so a week of
--    one asset's prices read from it costs thousands of scattered heap pages (ETH,
--    7 days: 19,400 buffers, 7.3 s cold, measured 2026-09-23). The tape holds the
--    same prices in a covering primary key, so a chart read is an index-only range.
--    Each row keeps its observation's retain_until and is deleted when that passes:
--    the tape never outlives the source policy of the row it copies.
--
-- 2. app_private.intel_quote_tape_ingest(), every minute from pg_cron. It reads the
--    observation table ONLY through its retention index, one bounded range per run.
--    Every CoinMarketCap row recorded since 2026-09-10 23:02 UTC keeps 30 days from
--    its recording, so a retention range is a recording range: the index returns
--    freshly written, contiguous pages (a steady run: about 540 pages, 23 ms; a
--    two-hour catch-up range: 7,250 pages, 0.27 s cold). It never scans the table.
--    The rows recorded before that date share one retain_until (2026-09-30 23:59)
--    and expire in a week; they are not copied, which would mean reading the other
--    12 GB of the table for data that is deleted on October 1.
--    ASSUMPTION, stated: a recording lane that switches to a shorter or fixed
--    retention would place its rows below the cursor, and they would not be copied.
--
-- 3. public.intel_stored_price_series(...): the read. Service role only. One jsonb
--    value per call, so PostgREST's row limit never truncates it.
--       'stats'    how many stored prices a window holds, their first and last
--                  time, the median spacing, and where the daily sources begin.
--       'buckets'  intraday OHLC buckets (1, 5, 15 or 30 minutes, 1 or 4 hours).
--       'daily'    one row per UTC day: the archive candle, else the backfill close,
--                  else the day's stored prices.
--
-- No grant to anon or authenticated anywhere (REVOKE FROM PUBLIC alone does not
-- remove Supabase's default grants, so each role is named).

-- ─── 1. The quote tape ───────────────────────────────────────────────────────
CREATE TABLE public.intel_quote_tape (
  subject text NOT NULL,
  observed_at timestamptz NOT NULL,
  price double precision NOT NULL,
  retain_until timestamptz NOT NULL,
  CONSTRAINT intel_quote_tape_pkey PRIMARY KEY (subject, observed_at) INCLUDE (price, retain_until),
  CONSTRAINT intel_quote_tape_subject CHECK (subject ~ '^market:coinmarketcap:[1-9][0-9]{0,11}$'),
  CONSTRAINT intel_quote_tape_price CHECK (price > 0 AND price < 1e15)
);
CREATE INDEX intel_quote_tape_retention ON public.intel_quote_tape (retain_until);
ALTER TABLE public.intel_quote_tape ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_quote_tape FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.intel_quote_tape TO service_role;
COMMENT ON TABLE public.intel_quote_tape IS
  'CoinMarketCap price observations (intel_market_observations metric price), one narrow row each, for chart reads. Filled by app_private.intel_quote_tape_ingest; every row is deleted when its observation''s retain_until passes.';

-- ─── 2. The ingest ───────────────────────────────────────────────────────────
CREATE TABLE app_private.intel_quote_tape_cursor (
  id smallint PRIMARY KEY CHECK (id = 1),
  through timestamptz NOT NULL,
  runs bigint NOT NULL DEFAULT 0,
  last_added integer,
  last_pruned integer,
  last_ms integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE app_private.intel_quote_tape_cursor FROM PUBLIC, anon, authenticated, service_role;

-- Start just below the oldest row of the 30-day retention class (see the header).
-- An empty class starts at the present.
INSERT INTO app_private.intel_quote_tape_cursor (id, through)
SELECT 1, coalesce(
  (SELECT min(o.retain_until) FROM public.intel_market_observations o WHERE o.retain_until >= timestamptz '2026-10-01 00:00:00+00'),
  now() + interval '30 days') - interval '1 minute';

CREATE FUNCTION app_private.intel_quote_tape_ingest(p_span interval DEFAULT interval '6 hours')
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  started timestamptz := clock_timestamp();
  cur timestamptz;
  lo timestamptz;
  hi timestamptz;
  added integer := 0;
  pruned integer := 0;
BEGIN
  IF p_span IS NULL OR p_span <= interval '0' OR p_span > interval '1 day' THEN
    RAISE EXCEPTION 'invalid_tape_span' USING ERRCODE = '22023';
  END IF;
  -- One run at a time: a second caller waits here, then reads the advanced cursor.
  SELECT c.through INTO cur FROM app_private.intel_quote_tape_cursor c WHERE c.id = 1 FOR UPDATE;
  IF cur IS NULL THEN RAISE EXCEPTION 'intel_quote_tape_cursor_missing'; END IF;

  -- The 30-minute overlap re-reads rows a batch committed a little after its
  -- recordedAt; the primary key makes a second copy a no-op.
  lo := cur - interval '30 minutes';
  hi := least(cur + p_span, now() + interval '30 days 5 minutes');

  INSERT INTO public.intel_quote_tape (subject, observed_at, price, retain_until)
  SELECT DISTINCT ON (o.subject, o.observed_at) o.subject, o.observed_at, q.v::double precision, o.retain_until
  FROM public.intel_market_observations o
  CROSS JOIN LATERAL (
    SELECT CASE WHEN jsonb_typeof(o.observation->'value') = 'number' THEN (o.observation->>'value')::numeric END AS v
  ) q
  WHERE o.retain_until > lo AND o.retain_until <= hi
    AND o.metric = 'price' AND o.provider = 'coinmarketcap'
    AND o.subject ~ '^market:coinmarketcap:[1-9][0-9]{0,11}$'
    AND o.observation->>'unit' = 'USD'
    AND q.v > 0 AND q.v < 1e15
    AND o.retain_until > now()
  ORDER BY o.subject, o.observed_at, o.id
  ON CONFLICT (subject, observed_at) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;

  -- A tape row never outlives the observation it copies.
  DELETE FROM public.intel_quote_tape t
  WHERE t.ctid IN (SELECT x.ctid FROM public.intel_quote_tape x WHERE x.retain_until <= now() LIMIT 20000);
  GET DIAGNOSTICS pruned = ROW_COUNT;

  UPDATE app_private.intel_quote_tape_cursor
  SET through = greatest(through, hi), runs = runs + 1, last_added = added, last_pruned = pruned,
      last_ms = (extract(epoch FROM clock_timestamp() - started) * 1000)::integer, updated_at = now()
  WHERE id = 1;

  RETURN jsonb_build_object('from', lo, 'through', hi, 'added', added, 'pruned', pruned,
    'ms', (extract(epoch FROM clock_timestamp() - started) * 1000)::integer);
END $$;
REVOKE ALL ON FUNCTION app_private.intel_quote_tape_ingest(interval) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.intel_quote_tape_ingest(interval) IS
  'Copies CoinMarketCap price observations into public.intel_quote_tape through the retention index, one bounded range per call (catch-up p_span, default 6 hours), and prunes expired tape rows. pg_cron job intel-quote-tape, every minute.';

DO $schedule$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intel-quote-tape';
  PERFORM cron.schedule('intel-quote-tape', '* * * * *',
    $job$SET statement_timeout = '100s'; SELECT app_private.intel_quote_tape_ingest();$job$);
END
$schedule$;

-- ─── The small capture tables, read by crypto id ─────────────────────────────
CREATE INDEX IF NOT EXISTS intel_rwa_wrapper_tokens_crypto_fetched_idx ON public.intel_rwa_wrapper_tokens (crypto_id, fetched_at);
CREATE INDEX IF NOT EXISTS intel_rwa_coverage_tokens_crypto_captured_idx ON public.intel_rwa_coverage_tokens (crypto_id, captured_at);
CREATE INDEX IF NOT EXISTS intel_rwa_wrapper_premium_backfill_crypto_day_idx ON public.intel_rwa_wrapper_premium_backfill (crypto_id, day);

-- ─── 3. The read ─────────────────────────────────────────────────────────────
-- Every stored price of one asset inside [p_from, p_to), one per instant. A
-- CoinMarketCap id reads the quote tape and the two RWA capture tables; a
-- CoinGecko id (only when there is no CoinMarketCap id) reads the catalogue
-- snapshots. Two providers are never mixed in one series.
CREATE FUNCTION public.intel_stored_price_points(p_cmc_id text, p_coingecko_id text, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (t timestamptz, p double precision, src text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT ON (x.t) x.t, x.p, x.src
  FROM (
    SELECT q.observed_at AS t, q.price AS p, 'quotes'::text AS src, 1 AS pref
    FROM public.intel_quote_tape q
    WHERE p_cmc_id IS NOT NULL AND q.subject = 'market:coinmarketcap:' || p_cmc_id
      AND q.observed_at >= p_from AND q.observed_at < p_to AND q.retain_until > now()
    UNION ALL
    SELECT w.fetched_at, w.price::double precision, 'wrapper_captures', 2
    FROM public.intel_rwa_wrapper_tokens w
    WHERE p_cmc_id IS NOT NULL AND w.crypto_id = p_cmc_id
      AND w.fetched_at >= p_from AND w.fetched_at < p_to AND w.price > 0 AND w.price < 1e15
    UNION ALL
    SELECT c.captured_at, c.price::double precision, 'coverage_captures', 3
    FROM public.intel_rwa_coverage_tokens c
    WHERE p_cmc_id IS NOT NULL AND c.crypto_id = p_cmc_id
      AND c.captured_at >= p_from AND c.captured_at < p_to AND c.price > 0 AND c.price < 1e15
    UNION ALL
    SELECT s.as_of, s.current_price, 'catalogue_snapshots', 4
    FROM public.market_asset_snapshots s
    WHERE p_cmc_id IS NULL AND p_coingecko_id IS NOT NULL
      AND s.source_provider = 'coingecko' AND s.provider_id = p_coingecko_id
      AND s.as_of >= p_from AND s.as_of < p_to AND s.current_price > 0 AND s.current_price < 1e15
  ) x
  ORDER BY x.t, x.pref
$$;
REVOKE ALL ON FUNCTION public.intel_stored_price_points(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_stored_price_points(text, text, timestamptz, timestamptz) TO service_role;

CREATE FUNCTION public.intel_stored_price_series(
  p_mode text,
  p_cmc_id text,
  p_coingecko_id text,
  p_archive_keys text[],
  p_from timestamptz,
  p_to timestamptz,
  p_bucket_seconds integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  cmc text;
  gecko text;
  keys text[];
  bucket_width interval;
  result jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('stats', 'buckets', 'daily') THEN
    RAISE EXCEPTION 'invalid_series_mode' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to OR p_from < timestamptz '2009-01-01 00:00:00+00'
     OR p_to > now() + interval '1 day' OR p_to - p_from > interval '7400 days' THEN
    RAISE EXCEPTION 'invalid_series_window' USING ERRCODE = '22023';
  END IF;
  IF p_cmc_id IS NOT NULL AND p_cmc_id !~ '^[1-9][0-9]{0,11}$' THEN
    RAISE EXCEPTION 'invalid_series_identity' USING ERRCODE = '22023';
  END IF;
  IF p_coingecko_id IS NOT NULL AND p_coingecko_id !~ '^[a-z0-9][a-z0-9._-]{0,119}$' THEN
    RAISE EXCEPTION 'invalid_series_identity' USING ERRCODE = '22023';
  END IF;
  IF coalesce(array_length(p_archive_keys, 1), 0) > 8
     OR EXISTS (SELECT 1 FROM unnest(coalesce(p_archive_keys, '{}'::text[])) k WHERE k IS NULL OR k !~ '^[A-Za-z0-9:._/-]{1,200}$') THEN
    RAISE EXCEPTION 'invalid_series_archive_keys' USING ERRCODE = '22023';
  END IF;
  cmc := p_cmc_id;
  gecko := CASE WHEN p_cmc_id IS NULL THEN p_coingecko_id END;

  -- The archive's own keys for this identity, besides the ones the caller named.
  keys := ARRAY(
    SELECT DISTINCT k FROM (
      SELECT unnest(coalesce(p_archive_keys, '{}'::text[])) AS k
      UNION ALL
      SELECT b.asset_key FROM public.market_asset_candle_backfill b WHERE cmc IS NOT NULL AND b.cmc_id = cmc
      UNION ALL
      SELECT b.asset_key FROM public.market_asset_candle_backfill b
      WHERE p_coingecko_id IS NOT NULL AND b.provider = 'coingecko' AND b.provider_id = p_coingecko_id
    ) z WHERE k ~ '^[A-Za-z0-9:._/-]{1,200}$' LIMIT 12);

  IF p_mode = 'stats' THEN
    WITH pts AS (
      SELECT * FROM public.intel_stored_price_points(cmc, gecko, p_from, p_to)
    ), gaps AS (
      SELECT extract(epoch FROM pts.t - lag(pts.t) OVER (ORDER BY pts.t)) AS g FROM pts
    )
    SELECT jsonb_build_object(
      'points', (SELECT count(*) FROM pts),
      'first', (SELECT min(pts.t) FROM pts),
      'last', (SELECT max(pts.t) FROM pts),
      'spacingSeconds', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gaps.g) FROM gaps WHERE gaps.g > 0),
      'sources', coalesce((SELECT jsonb_object_agg(s.src, s.n) FROM (SELECT pts.src, count(*) AS n FROM pts GROUP BY pts.src) s), '{}'::jsonb),
      'archiveFirst', (SELECT min(a.candle_time) FROM public.market_asset_candles a
                       WHERE a.asset_key = ANY (keys) AND a.candle_interval = '1d' AND a.candle_time >= p_from AND a.candle_time < p_to),
      'backfillFirst', (SELECT min(b.day) FROM public.intel_rwa_wrapper_premium_backfill b
                        WHERE cmc IS NOT NULL AND b.crypto_id = cmc
                          AND b.day >= (p_from AT TIME ZONE 'UTC')::date AND b.day < (p_to AT TIME ZONE 'UTC')::date),
      'archiveKeys', to_jsonb(keys)
    ) INTO result;
    RETURN result;
  END IF;

  IF p_mode = 'buckets' THEN
    IF p_bucket_seconds IS NULL OR p_bucket_seconds NOT IN (60, 300, 900, 1800, 3600, 14400) THEN
      RAISE EXCEPTION 'invalid_series_bucket' USING ERRCODE = '22023';
    END IF;
    IF extract(epoch FROM p_to - p_from) / p_bucket_seconds > 6000 THEN
      RAISE EXCEPTION 'series_too_long' USING ERRCODE = '22023';
    END IF;
    bucket_width := make_interval(secs => p_bucket_seconds);
    WITH pts AS (
      SELECT * FROM public.intel_stored_price_points(cmc, gecko, p_from, p_to)
    ), agg AS (
      SELECT date_bin(bucket_width, pts.t, timestamptz '1970-01-01 00:00:00+00') AS bt,
        (array_agg(pts.p ORDER BY pts.t))[1] AS o, max(pts.p) AS h, min(pts.p) AS l,
        (array_agg(pts.p ORDER BY pts.t DESC))[1] AS c, count(*) AS n, max(pts.t) AS lt
      FROM pts GROUP BY 1
    )
    SELECT jsonb_build_object(
      'bucketSeconds', p_bucket_seconds,
      -- [open time ms, open, high, low, close, stored prices, newest price time ms].
      -- Only buckets that have closed by p_to: the one in progress is not a candle yet.
      'bars', coalesce((SELECT jsonb_agg(jsonb_build_array(
                  (extract(epoch FROM agg.bt) * 1000)::bigint, agg.o, agg.h, agg.l, agg.c, agg.n, (extract(epoch FROM agg.lt) * 1000)::bigint)
                ORDER BY agg.bt) FROM agg WHERE agg.bt + bucket_width <= p_to), '[]'::jsonb),
      'sources', coalesce((SELECT jsonb_object_agg(s.src, s.n) FROM (SELECT pts.src, count(*) AS n FROM pts GROUP BY pts.src) s), '{}'::jsonb),
      'last', (SELECT max(pts.t) FROM pts)
    ) INTO result;
    RETURN result;
  END IF;

  -- 'daily': one row per complete UTC day. Precedence: the archive candle (a real
  -- OHLCV period, venue before aggregate), else the backfill close, else the day's
  -- stored prices.
  WITH pts AS (
    SELECT * FROM public.intel_stored_price_points(cmc, gecko, p_from, p_to)
  ), qd AS (
    SELECT date_bin(interval '1 day', pts.t, timestamptz '1970-01-01 00:00:00+00') AS d,
      (array_agg(pts.p ORDER BY pts.t))[1] AS o, max(pts.p) AS h, min(pts.p) AS l,
      (array_agg(pts.p ORDER BY pts.t DESC))[1] AS c, count(*) AS n
    FROM pts GROUP BY 1
  ), ar AS (
    SELECT DISTINCT ON (a.candle_time) a.candle_time AS d, a.open::double precision AS o, a.high::double precision AS h,
      a.low::double precision AS l, a.close::double precision AS c, a.volume::double precision AS v, a.provider
    FROM public.market_asset_candles a
    WHERE a.asset_key = ANY (keys) AND a.candle_interval = '1d' AND a.candle_time >= p_from AND a.candle_time < p_to
      AND a.close > 0
    ORDER BY a.candle_time,
      CASE a.provider WHEN 'binance' THEN 0 WHEN 'coinbase' THEN 1 WHEN 'kraken' THEN 2 WHEN 'kucoin' THEN 3
        WHEN 'coinmarketcap' THEN 4 WHEN 'coinmarketcap_kline' THEN 5 WHEN 'coingecko' THEN 6 ELSE 99 END,
      a.asset_key
  ), bf AS (
    SELECT DISTINCT ON (b.day) (b.day::timestamp AT TIME ZONE 'UTC') AS d, b.close_price::double precision AS c
    FROM public.intel_rwa_wrapper_premium_backfill b
    WHERE cmc IS NOT NULL AND b.crypto_id = cmc
      AND b.day >= (p_from AT TIME ZONE 'UTC')::date AND b.day < (p_to AT TIME ZONE 'UTC')::date
      AND b.close_price > 0 AND b.close_price < 1e15
    ORDER BY b.day, b.fetched_at DESC NULLS LAST
  ), days AS (
    SELECT ar.d FROM ar UNION SELECT bf.d FROM bf UNION SELECT qd.d FROM qd
  )
  SELECT jsonb_build_object(
    -- [day open ms, open, high, low, close, volume, stored prices, kind, provider].
    -- kind: 'archive' | 'backfill' (close only) | 'quotes'.
    'days', coalesce((SELECT jsonb_agg(
        CASE
          WHEN ar.d IS NOT NULL THEN jsonb_build_array((extract(epoch FROM days.d) * 1000)::bigint, ar.o, ar.h, ar.l, ar.c, ar.v, NULL, 'archive', ar.provider)
          WHEN bf.d IS NOT NULL THEN jsonb_build_array((extract(epoch FROM days.d) * 1000)::bigint, NULL, NULL, NULL, bf.c, NULL, NULL, 'backfill', 'coinmarketcap')
          ELSE jsonb_build_array((extract(epoch FROM days.d) * 1000)::bigint, qd.o, qd.h, qd.l, qd.c, NULL, qd.n, 'quotes', CASE WHEN cmc IS NOT NULL THEN 'coinmarketcap' ELSE 'coingecko' END)
        END ORDER BY days.d)
      FROM days
      LEFT JOIN ar ON ar.d = days.d
      LEFT JOIN bf ON bf.d = days.d
      LEFT JOIN qd ON qd.d = days.d
      WHERE days.d + interval '1 day' <= p_to), '[]'::jsonb),
    'sources', coalesce((SELECT jsonb_object_agg(s.src, s.n) FROM (SELECT pts.src, count(*) AS n FROM pts GROUP BY pts.src) s), '{}'::jsonb),
    'last', (SELECT max(pts.t) FROM pts),
    'archiveKeys', to_jsonb(keys)
  ) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_stored_price_series(text, text, text, text[], timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_stored_price_series(text, text, text, text[], timestamptz, timestamptz, integer) TO service_role;
COMMENT ON FUNCTION public.intel_stored_price_series(text, text, text, text[], timestamptz, timestamptz, integer) IS
  'Chart prices from stored data only (stats | intraday buckets | daily rows) for one CoinMarketCap or CoinGecko identity. One jsonb value per call. Service role only.';
