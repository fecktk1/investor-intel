-- Investor Intel public RWA lookup (intel-rwa-lookup): the daily allowance of
-- LIVE CoinMarketCap calls a visitor can cause.
--
-- The lookup now answers from the stored answer only while that answer can be
-- trusted to be current, and otherwise makes ONE real /v5 quotes call through
-- the governed transport (credit reservation, receipt, proof). A visitor can also
-- ask for that call directly ("Check CoinMarketCap now"). Both kinds of call are
-- bounded here, per salted address hash and for everybody together, per UTC day,
-- on top of the per-address hourly limiter and the platform-wide 200 credit free
-- RWA budget (intel_free_rwa_read_claim) that still decide every call.
--
-- Why a table of its own: rate_limit_log (093_rate_limit_log.sql) sweeps rows
-- older than an hour, so it cannot hold a daily window. This is the same dated
-- counter as intel_mcp_demo_daily_usage (20260923180000_intel_mcp_demo_usage.sql),
-- kept separate so a lookup call never uses up an MCP demo visitor's allowance.
--
-- WHAT IS STORED. One row per caller per kind per UTC day: the salted SHA-256
-- prefix of the caller's network address (the `ip:<32 hex>` key the rate limiter
-- uses, built in the Edge Function from RATE_LIMIT_SALT), never the address,
-- plus one row keyed 'all' per kind. A count and two timestamps; no query, no
-- asset, nothing a visitor typed.
--
-- RETENTION. Rows older than seven days are swept opportunistically by the take
-- function itself (about one call in a hundred). No cron entry.
--
-- ACCESS. Service role only: RLS on with no policy, and every grant removed from
-- PUBLIC, anon and authenticated by name. The Edge Function is the only caller.
--
-- Additive: no existing object changes.

CREATE TABLE IF NOT EXISTS public.intel_rwa_lookup_live_daily_usage (
 caller_key text NOT NULL CHECK (caller_key ~ '^(ip:[0-9a-f]{32}|all)$'),
 kind text NOT NULL CHECK (kind IN ('auto', 'check')),
 usage_date date NOT NULL,
 calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
 first_call_at timestamptz NOT NULL DEFAULT now(),
 last_call_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (caller_key, kind, usage_date)
);

CREATE INDEX IF NOT EXISTS intel_rwa_lookup_live_daily_usage_date ON public.intel_rwa_lookup_live_daily_usage (usage_date);

COMMENT ON TABLE public.intel_rwa_lookup_live_daily_usage IS
 'intel-rwa-lookup: live CoinMarketCap calls per salted address hash (or ''all'') per kind (auto, check) per UTC day. '
 'Never a raw address. Separate from rate_limit_log because that table is swept hourly.';

ALTER TABLE public.intel_rwa_lookup_live_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_rwa_lookup_live_daily_usage FROM PUBLIC;
REVOKE ALL ON public.intel_rwa_lookup_live_daily_usage FROM anon;
REVOKE ALL ON public.intel_rwa_lookup_live_daily_usage FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_rwa_lookup_live_daily_usage TO service_role;

-- ── Take one live call from today's allowance, atomically ──────────────────
--
-- Counted BEFORE the call, so a refused or failing call still counts. The
-- caller's own row first; the 'all' row only while the caller is still inside
-- its own allowance, so one busy address cannot use up everybody's day by being
-- refused. ON CONFLICT DO UPDATE returns the new count, so two concurrent calls
-- from one address cannot both read "under the limit".
--
-- Returns jsonb {allowed, used, limit, reason_code, resets_at}. Never raises for
-- a bad input: a malformed key or kind is refused in the result.
CREATE OR REPLACE FUNCTION public.intel_rwa_lookup_live_take(p_caller_key text, p_kind text, p_limit integer, p_global_limit integer)
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
    OR p_kind IS NULL OR p_kind NOT IN ('auto', 'check')
    OR p_limit IS NULL OR p_limit < 1 OR p_global_limit IS NULL OR p_global_limit < 1 THEN
  RETURN jsonb_build_object('allowed', false, 'used', 0, 'reason_code', 'invalid_caller', 'resets_at', v_resets);
 END IF;

 IF random() < 0.01 THEN
  DELETE FROM public.intel_rwa_lookup_live_daily_usage WHERE usage_date < v_today - 7;
 END IF;

 INSERT INTO public.intel_rwa_lookup_live_daily_usage (caller_key, kind, usage_date, calls)
 VALUES (p_caller_key, p_kind, v_today, 1)
 ON CONFLICT (caller_key, kind, usage_date)
 DO UPDATE SET calls = public.intel_rwa_lookup_live_daily_usage.calls + 1, last_call_at = now()
 RETURNING calls INTO v_calls;

 IF v_calls > p_limit THEN
  RETURN jsonb_build_object('allowed', false, 'used', v_calls, 'limit', p_limit,
   'reason_code', 'daily_cap_reached', 'resets_at', v_resets);
 END IF;

 INSERT INTO public.intel_rwa_lookup_live_daily_usage (caller_key, kind, usage_date, calls)
 VALUES ('all', p_kind, v_today, 1)
 ON CONFLICT (caller_key, kind, usage_date)
 DO UPDATE SET calls = public.intel_rwa_lookup_live_daily_usage.calls + 1, last_call_at = now()
 RETURNING calls INTO v_all;

 IF v_all > p_global_limit THEN
  RETURN jsonb_build_object('allowed', false, 'used', v_calls, 'limit', p_limit,
   'reason_code', 'all_daily_cap_reached', 'resets_at', v_resets);
 END IF;

 RETURN jsonb_build_object('allowed', true, 'used', v_calls, 'limit', p_limit, 'resets_at', v_resets);
END $$;

REVOKE ALL ON FUNCTION public.intel_rwa_lookup_live_take(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_rwa_lookup_live_take(text, text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.intel_rwa_lookup_live_take(text, text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_rwa_lookup_live_take(text, text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.intel_rwa_lookup_live_take(text, text, integer, integer) IS
 'intel-rwa-lookup: atomically take one live CoinMarketCap call of a kind (auto, check) from a salted address hash''s '
 'UTC-day allowance (p_limit) and from everyone''s (p_global_limit). Counts before the call. Service role only.';
