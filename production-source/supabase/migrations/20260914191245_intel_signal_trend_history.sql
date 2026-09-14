-- Signal trend history, September 14.
--
-- produceSignalState read seven days of intel_signal_snapshots for 200 signal keys at a time
-- through PostgREST. Those reads averaged 6.7 s, and each returned at most the API row limit,
-- oldest first, while up to 336 snapshots exist per key. Trend windows therefore used
-- truncated history, and because the read started at now minus seven days, the seven-day
-- window could never find its anchor.
--
-- This returns, per key, what computeTrends reads: the latest snapshot at or before the
-- 1-hour, 24-hour and 7-day cutoffs, plus the most recent points (48 by default, enough for
-- the 8-point slope and a day of 30-minute steps). Each point is [epoch ms, severity,
-- direction], and one call returns a single JSON object, so the row limit does not apply.

CREATE OR REPLACE FUNCTION public.intel_signal_trend_history(
  p_keys text[],
  p_now timestamptz DEFAULT now(),
  p_recent integer DEFAULT 48
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_object_agg(k.signal_key, h.points), '{}'::jsonb)
  FROM (SELECT DISTINCT key AS signal_key FROM unnest(p_keys) AS key WHERE key IS NOT NULL LIMIT 500) k
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_array((extract(epoch FROM p.snapshot_at) * 1000)::bigint, p.severity, p.direction)
                     ORDER BY p.snapshot_at) AS points
    FROM (
      (SELECT s.snapshot_at, s.severity, s.direction FROM intel_signal_snapshots s
        WHERE s.signal_key = k.signal_key AND s.snapshot_at <= p_now AND s.snapshot_at >= p_now - interval '7 days'
        ORDER BY s.snapshot_at DESC LIMIT LEAST(GREATEST(COALESCE(p_recent, 48), 8), 96))
      UNION
      (SELECT s.snapshot_at, s.severity, s.direction FROM intel_signal_snapshots s
        WHERE s.signal_key = k.signal_key AND s.snapshot_at <= p_now - interval '1 hour' AND s.snapshot_at >= p_now - interval '7 days'
        ORDER BY s.snapshot_at DESC LIMIT 1)
      UNION
      (SELECT s.snapshot_at, s.severity, s.direction FROM intel_signal_snapshots s
        WHERE s.signal_key = k.signal_key AND s.snapshot_at <= p_now - interval '24 hours' AND s.snapshot_at >= p_now - interval '7 days'
        ORDER BY s.snapshot_at DESC LIMIT 1)
      UNION
      (SELECT s.snapshot_at, s.severity, s.direction FROM intel_signal_snapshots s
        WHERE s.signal_key = k.signal_key AND s.snapshot_at <= p_now - interval '7 days' AND s.snapshot_at >= p_now - interval '9 days'
        ORDER BY s.snapshot_at DESC LIMIT 1)
    ) p
  ) h
  WHERE h.points IS NOT NULL
$function$;

REVOKE ALL ON FUNCTION public.intel_signal_trend_history(text[], timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_signal_trend_history(text[], timestamptz, integer) TO service_role;
