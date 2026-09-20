-- The hosted MCP server: a daily call counter, a call audit, two new token
-- scopes, and the per-tier call allowance.
--
-- Everything here is additive. No existing table, function or policy changes
-- meaning, with one exception that is called out below and is a WIDENING only.
--
-- WHY A SECOND COUNTER EXISTS AT ALL. The minute-window limiter
-- (093_rate_limit_log.sql) cannot hold a daily window: its cleanup deletes
-- `bucket_at < now() - interval '1 hour'` on roughly one call in two hundred, so
-- a count over 86400 seconds silently loses everything older than an hour and
-- caps nothing. Rather than change a limiter every other Edge Function depends
-- on, the daily allowance gets its own dated row per token.

-- Two foreign keys into intel_agent_tokens and orgs, each taking SHARE ROW
-- EXCLUSIVE on the referenced table. Both are on the hot path of a signed-in
-- session, so the same bound the rest of this set carries applies: wait five
-- seconds and fail rather than queue behind a long transaction.
SET LOCAL lock_timeout='5s';

-- ── The daily allowance ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.intel_mcp_daily_usage (
 token_id uuid NOT NULL REFERENCES public.intel_agent_tokens(id) ON DELETE CASCADE,
 -- UTC, and deliberately a date rather than a rolling window. A member can be
 -- told "your allowance resets at midnight UTC", which is a sentence; "your
 -- allowance resets 24 hours after your oldest call" is not.
 usage_date date NOT NULL,
 calls integer NOT NULL DEFAULT 0 CHECK(calls >= 0),
 first_call_at timestamptz NOT NULL DEFAULT now(),
 last_call_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (token_id, usage_date)
);

COMMENT ON TABLE public.intel_mcp_daily_usage IS
 'One row per agent token per UTC day, counting hosted MCP tool calls. Separate from '
 'rate_limit_log because that table is swept hourly and so cannot hold a daily window.';

-- ── The audit ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.intel_mcp_call_audit (
 id bigserial PRIMARY KEY,
 token_id uuid NOT NULL REFERENCES public.intel_agent_tokens(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 tool text NOT NULL CHECK(length(tool) BETWEEN 1 AND 80),
 outcome text NOT NULL CHECK(outcome IN ('served','refused','failed')),
 -- A machine code only, and at most 60 characters of it. There is deliberately
 -- NO column for arguments: a tool argument can be a wallet address, a note or a
 -- thesis title, and the question this table answers (what did this token do,
 -- how often, was it refused) never needs one. Anything that would CHANGE data
 -- is stored in full, with its hash and its approval, in intel_agent_plans.
 reason_code text CHECK(reason_code IS NULL OR length(reason_code) <= 60),
 duration_ms integer NOT NULL DEFAULT 0 CHECK(duration_ms >= 0),
 result_bytes integer NOT NULL DEFAULT 0 CHECK(result_bytes >= 0),
 -- True when the refusal was the plan gate rather than a scope or a bad
 -- argument, so "how often did a plan stop someone" is one predicate.
 tier_locked boolean NOT NULL DEFAULT false,
 called_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- A refusal must be recorded, so reason_code is required whenever the call was
 -- not served. Without this an unexplained refusal is indistinguishable from a
 -- logging bug.
 CHECK(outcome = 'served' OR reason_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS intel_mcp_call_audit_token ON public.intel_mcp_call_audit(token_id, called_at DESC);
CREATE INDEX IF NOT EXISTS intel_mcp_call_audit_org ON public.intel_mcp_call_audit(org_id, called_at DESC);
CREATE INDEX IF NOT EXISTS intel_mcp_call_audit_refused ON public.intel_mcp_call_audit(org_id, called_at DESC) WHERE outcome <> 'served';

COMMENT ON TABLE public.intel_mcp_call_audit IS
 'One row per hosted MCP tool call: the tool, whether it was served or refused and why, '
 'how long it took and how big the answer was. Carries NO tool arguments by design.';

-- ── RLS and grants: service role only, matching the agent tables ─────────────
-- No policy and no grant for anon or authenticated. Every read and write goes
-- through the Edge Function, which holds the service role and does the whole
-- authorization in the handler. This matches 20260916090000_intel_agent_tokens.sql
-- exactly: a browser session must not be able to read another member's call log
-- even inside its own organization.

ALTER TABLE public.intel_mcp_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intel_mcp_call_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.intel_mcp_daily_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.intel_mcp_call_audit FROM PUBLIC, anon, authenticated;
-- bigserial creates a sequence, and an INSERT needs USAGE on it. Revoking the
-- table without revoking the sequence would leave a grant nobody meant to keep.
REVOKE ALL ON SEQUENCE public.intel_mcp_call_audit_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.intel_mcp_daily_usage TO service_role;
GRANT SELECT, INSERT ON public.intel_mcp_call_audit TO service_role;
GRANT USAGE ON SEQUENCE public.intel_mcp_call_audit_id_seq TO service_role;

-- ── Take one call from today's allowance, atomically ────────────────────────
--
-- The increment happens BEFORE the tool runs, so a tool that throws still costs
-- its call. Charging only for successes would let a loop of failing calls run
-- without limit, which is the shape of the abuse a daily cap is for.
--
-- ON CONFLICT DO UPDATE is the whole concurrency story: two simultaneous calls
-- for the same token contend on the primary key and one waits, so the count
-- cannot be read-then-written by both. No advisory lock is needed because there
-- is no read-then-act: the count comes back FROM the upsert.
--
-- p_limit NULL means no ceiling, which is how intel_limit_for already reports a
-- tier with no row. The call is still counted, because the allowance figure a
-- member sees has to be true even when it is unlimited.
CREATE OR REPLACE FUNCTION public.intel_mcp_quota_take(p_token_id uuid, p_limit integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
 v_today date := (now() AT TIME ZONE 'UTC')::date;
 v_calls integer;
BEGIN
 IF p_token_id IS NULL THEN
  RETURN jsonb_build_object('allowed', false, 'used', 0, 'reason_code', 'no_token',
   'resets_at', ((v_today + 1)::timestamp AT TIME ZONE 'UTC'));
 END IF;

 INSERT INTO public.intel_mcp_daily_usage (token_id, usage_date, calls)
 VALUES (p_token_id, v_today, 1)
 ON CONFLICT (token_id, usage_date)
 DO UPDATE SET calls = public.intel_mcp_daily_usage.calls + 1, last_call_at = now()
 RETURNING calls INTO v_calls;

 -- The comparison is on the count AFTER this call. A limit of 2000 allows a
 -- two-thousandth call and refuses the two-thousand-and-first, which is what
 -- "2000 a day" means to the person reading it.
 IF p_limit IS NOT NULL AND v_calls > p_limit THEN
  RETURN jsonb_build_object('allowed', false, 'used', v_calls, 'limit', p_limit,
   'reason_code', 'daily_quota_reached',
   'resets_at', ((v_today + 1)::timestamp AT TIME ZONE 'UTC'));
 END IF;

 RETURN jsonb_build_object('allowed', true, 'used', v_calls, 'limit', p_limit,
  'resets_at', ((v_today + 1)::timestamp AT TIME ZONE 'UTC'));
END $$;

REVOKE ALL ON FUNCTION public.intel_mcp_quota_take(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_mcp_quota_take(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.intel_mcp_quota_take(uuid, integer) IS
 'Atomically take one hosted MCP call from a token''s UTC-day allowance. Counts the call '
 'before the tool runs, so a failing tool still costs its call. NULL p_limit means no ceiling.';

-- ── Retention: the audit is evidence, not an archive ────────────────────────
-- Ninety days is longer than any support question about "what did my agent do"
-- and short enough that the table never becomes the biggest thing in the
-- database. Run from the same nightly sweep pattern the other intel retention
-- jobs use; there is no cron entry here because this migration adds no lane.
CREATE OR REPLACE FUNCTION public.intel_mcp_audit_sweep(p_days integer DEFAULT 90)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted integer;
BEGIN
 IF p_days IS NULL OR p_days < 7 THEN
  RAISE EXCEPTION 'intel_mcp_audit_sweep_minimum_7_days' USING ERRCODE = 'check_violation';
 END IF;
 DELETE FROM public.intel_mcp_call_audit WHERE called_at < now() - make_interval(days => p_days);
 GET DIAGNOSTICS v_deleted = ROW_COUNT;
 DELETE FROM public.intel_mcp_daily_usage WHERE usage_date < ((now() AT TIME ZONE 'UTC')::date - p_days);
 RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION public.intel_mcp_audit_sweep(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_mcp_audit_sweep(integer) TO service_role;

-- ── The per-tier daily allowance ────────────────────────────────────────────
-- Read through intel_limit_for, which is the mechanism every other Intel limit
-- already uses, so a per-org override in orgs.plan_overrides->'intel_limits'
-- works here with no further code. An ABSENT row means no ceiling, which is why
-- elite has none: that is how intel_limit_for reports unlimited.
--
-- trial matches elite because a trial is a full-plan trial everywhere else in
-- this table. free has a row even though agent_access is a starter surface and a
-- free member therefore cannot hold a usable token at all: if that surface is
-- ever opened to free, an unlimited allowance must not be what it inherits.
INSERT INTO public.intel_plan_limits (tier, key, value) VALUES
 ('free',    'agent_mcp_calls_per_day', 100),
 ('starter', 'agent_mcp_calls_per_day', 2000),
 ('pro',     'agent_mcp_calls_per_day', 10000),
 ('elite',   'agent_mcp_calls_per_day', NULL),
 ('trial',   'agent_mcp_calls_per_day', NULL)
ON CONFLICT (tier, key) DO UPDATE SET value = EXCLUDED.value;

-- ── Two new token scopes ────────────────────────────────────────────────────
--
-- THIS IS THE ONE EXISTING OBJECT THIS MIGRATION CHANGES, and it is a WIDENING.
-- app_private.intel_agent_scopes_valid backs a CHECK constraint on
-- intel_agent_tokens.scopes. Replacing a function that backs a CHECK does not
-- revalidate the rows already stored, which is why the original pinned its
-- search_path and said so. Adding entries to an allowlist and raising the upper
-- cardinality bound can only ACCEPT more than before, so every stored row that
-- satisfied the old predicate satisfies this one. The reverse direction, removing
-- a scope, would need a rewrite of the affected rows and is deliberately not done
-- here.
--
-- read:market is NOT added. The market and RWA readings are the product's shared
-- intelligence rather than the member's records, and they are gated by tier
-- alone. Requiring a new read scope for them would refuse every token minted
-- before today on every new tool: a migration problem wearing a security
-- control's clothes.
--
-- write:research pairs with read:evidence rather than a read:research that does
-- not exist, because read:evidence is already the scope that reads
-- saved_research (its investigation receipts). One store, one read scope.
CREATE OR REPLACE FUNCTION app_private.intel_agent_scopes_valid(p_scopes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
 SELECT p_scopes IS NOT NULL
  AND cardinality(p_scopes) BETWEEN 1 AND 11
  AND p_scopes <@ ARRAY['read:portfolio','read:thesis','read:alerts','read:charts','read:watchlists','read:evidence','write:alerts','write:charts','write:thesis','write:watchlists','write:research']::text[]
  -- Each scope named once, so a token cannot be padded into looking different.
  AND cardinality(p_scopes) = (SELECT count(DISTINCT s) FROM unnest(p_scopes) s)
  -- A write scope without its read scope cannot verify its own writes, and
  -- verification by re-reading is the point of the write path.
  AND (NOT 'write:alerts' = ANY(p_scopes) OR 'read:alerts' = ANY(p_scopes))
  AND (NOT 'write:charts' = ANY(p_scopes) OR 'read:charts' = ANY(p_scopes))
  AND (NOT 'write:thesis' = ANY(p_scopes) OR 'read:thesis' = ANY(p_scopes))
  AND (NOT 'write:watchlists' = ANY(p_scopes) OR 'read:watchlists' = ANY(p_scopes))
  AND (NOT 'write:research' = ANY(p_scopes) OR 'read:evidence' = ANY(p_scopes))
$$;

-- CREATE OR REPLACE keeps existing grants, but the grant is restated because the
-- original migration's comment is the reason it exists and losing it would break
-- every insert with "permission denied for function": a CHECK expression runs as
-- the INSERTING role, and service_role neither is nor inherits from a superuser.
REVOKE ALL ON FUNCTION app_private.intel_agent_scopes_valid(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_agent_scopes_valid(text[]) TO service_role;
