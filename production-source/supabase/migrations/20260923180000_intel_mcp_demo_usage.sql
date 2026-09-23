-- Investor Intel public MCP demo (intel-mcp-demo): the daily tool-call allowance.
--
-- The demo is a read-only MCP server anyone may call with no account. Its
-- per-minute limits reuse rate_limit_check_and_increment (093_rate_limit_log.sql).
-- A DAY cannot: that limiter sweeps rows older than one hour, so a count over
-- 86,400 seconds would lose everything but the last hour and cap nothing. The
-- same reason gave the authenticated server intel_mcp_daily_usage; the demo has
-- no token to key that table on, so it gets its own dated counter here.
--
-- WHAT IS STORED. One row per caller per UTC day: the salted SHA-256 prefix of
-- the caller's network address (the same `ip:<32 hex>` key the rate limiter
-- uses, built in the Edge Function from RATE_LIMIT_SALT), never the address
-- itself, plus one row keyed 'all' for every caller together. A count and two
-- timestamps; no tool name, no argument, nothing a caller typed.
--
-- RETENTION. Rows older than seven days are swept opportunistically by the take
-- function itself (about one call in a hundred), so the table stays a week deep
-- with no cron entry.
--
-- ACCESS. Service role only: RLS on with no policy, and every grant removed from
-- PUBLIC, anon and authenticated by name (REVOKE FROM PUBLIC alone does not
-- remove Supabase's default grants). The Edge Function is the only caller.
--
-- Additive: no existing object changes.

CREATE TABLE IF NOT EXISTS public.intel_mcp_demo_daily_usage (
 caller_key text NOT NULL CHECK (caller_key ~ '^(ip:[0-9a-f]{32}|all)$'),
 usage_date date NOT NULL,
 calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
 first_call_at timestamptz NOT NULL DEFAULT now(),
 last_call_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (caller_key, usage_date)
);

CREATE INDEX IF NOT EXISTS intel_mcp_demo_daily_usage_date ON public.intel_mcp_demo_daily_usage (usage_date);

COMMENT ON TABLE public.intel_mcp_demo_daily_usage IS
 'intel-mcp-demo: tool calls per salted address hash (or ''all'') per UTC day. Never a raw address. '
 'Separate from rate_limit_log because that table is swept hourly and so cannot hold a daily window.';

ALTER TABLE public.intel_mcp_demo_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_mcp_demo_daily_usage FROM PUBLIC;
REVOKE ALL ON public.intel_mcp_demo_daily_usage FROM anon;
REVOKE ALL ON public.intel_mcp_demo_daily_usage FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_mcp_demo_daily_usage TO service_role;

-- ── Take one tool call from today's allowance, atomically ──────────────────
--
-- Counted BEFORE the tool runs, so a refused or failing call still costs its
-- call. ON CONFLICT DO UPDATE is the concurrency story, as in
-- intel_mcp_quota_take: the count comes back from the upsert, so two calls from
-- one address cannot both read "under the limit". The caller's own row is
-- counted first; the 'all' row only when the caller is still inside its own
-- allowance, so one busy address cannot use up everyone's day by being refused.
--
-- Returns jsonb {allowed, used, limit, reason_code, resets_at}. Never raises for
-- a bad input: a malformed key is refused in the result.
CREATE OR REPLACE FUNCTION public.intel_mcp_demo_take(p_caller_key text, p_limit integer, p_global_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
 v_today date := (now() AT TIME ZONE 'UTC')::date;
 v_resets timestamptz := ((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC';
 v_calls integer;
 v_all integer;
BEGIN
 IF p_caller_key IS NULL OR p_caller_key !~ '^ip:[0-9a-f]{32}$'
    OR p_limit IS NULL OR p_limit < 1 OR p_global_limit IS NULL OR p_global_limit < 1 THEN
  RETURN jsonb_build_object('allowed', false, 'used', 0, 'reason_code', 'invalid_caller', 'resets_at', v_resets);
 END IF;

 IF random() < 0.01 THEN
  DELETE FROM public.intel_mcp_demo_daily_usage WHERE usage_date < v_today - 7;
 END IF;

 INSERT INTO public.intel_mcp_demo_daily_usage (caller_key, usage_date, calls)
 VALUES (p_caller_key, v_today, 1)
 ON CONFLICT (caller_key, usage_date)
 DO UPDATE SET calls = public.intel_mcp_demo_daily_usage.calls + 1, last_call_at = now()
 RETURNING calls INTO v_calls;

 IF v_calls > p_limit THEN
  RETURN jsonb_build_object('allowed', false, 'used', v_calls, 'limit', p_limit,
   'reason_code', 'daily_cap_reached', 'resets_at', v_resets);
 END IF;

 INSERT INTO public.intel_mcp_demo_daily_usage (caller_key, usage_date, calls)
 VALUES ('all', v_today, 1)
 ON CONFLICT (caller_key, usage_date)
 DO UPDATE SET calls = public.intel_mcp_demo_daily_usage.calls + 1, last_call_at = now()
 RETURNING calls INTO v_all;

 IF v_all > p_global_limit THEN
  RETURN jsonb_build_object('allowed', false, 'used', v_calls, 'limit', p_limit,
   'reason_code', 'demo_daily_cap_reached', 'resets_at', v_resets);
 END IF;

 RETURN jsonb_build_object('allowed', true, 'used', v_calls, 'limit', p_limit, 'resets_at', v_resets);
END $$;

REVOKE ALL ON FUNCTION public.intel_mcp_demo_take(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_mcp_demo_take(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.intel_mcp_demo_take(text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_mcp_demo_take(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.intel_mcp_demo_take(text, integer, integer) IS
 'intel-mcp-demo: atomically take one tool call from a salted address hash''s UTC-day allowance '
 '(p_limit) and from everyone''s (p_global_limit). Counts before the tool runs. Service role only.';
