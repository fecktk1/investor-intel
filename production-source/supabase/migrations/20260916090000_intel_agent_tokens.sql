-- Bring your own agent: scoped inbound tokens for Investor Intel, and the
-- propose/approve/verify triple that stands between an agent and a write.
--
-- A token is a bearer credential handed to software the member chose. Three
-- things make it safe to hand out:
--
--   1. Only the SHA-256 hash is stored. The plaintext exists once, in the
--      response that created it, and is never recoverable afterwards.
--   2. The organization is PINNED on the row. get_my_org_id() is
--      `SELECT org_id FROM org_members WHERE user_id=auth.uid() LIMIT 1` with no
--      ORDER BY (001_initial_schema.sql:63), so for a member of several orgs it
--      returns an arbitrary one that can change between calls. A token that
--      resolved its org that way would read a different book on different days.
--   3. Scopes are on the ROW, not in the token, so revoking or narrowing takes
--      effect on the next request rather than at the next token expiry.
--
-- A token is not an entitlement. Membership and can_access_intel are re-checked
-- on every request, exactly as requireExtensionDevice re-checks per request.

CREATE SCHEMA IF NOT EXISTS app_private;

-- The scope vocabulary, enforced by the database rather than only by the handler.
--
-- This is a FUNCTION rather than an inline CHECK expression because the rules
-- include "no duplicates", which needs a subquery over unnest, and Postgres
-- refuses a subquery inside a CHECK constraint. A CHECK may call an IMMUTABLE
-- function, and the subquery is legal inside the function body.
-- search_path is pinned because this function BACKS A CHECK CONSTRAINT. A later
-- CREATE OR REPLACE would silently change what that constraint means, with no
-- revalidation of the rows already stored, so name resolution is nailed down
-- now. Only built-ins are called, and pg_catalog is searched implicitly whatever
-- this is set to.
CREATE FUNCTION app_private.intel_agent_scopes_valid(p_scopes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
 SELECT p_scopes IS NOT NULL
  AND cardinality(p_scopes) BETWEEN 1 AND 9
  AND p_scopes <@ ARRAY['read:portfolio','read:thesis','read:alerts','read:charts','read:watchlists','read:evidence','write:alerts','write:charts','write:thesis']::text[]
  -- Each scope named once, so a token cannot be padded into looking different.
  AND cardinality(p_scopes) = (SELECT count(DISTINCT s) FROM unnest(p_scopes) s)
  -- A write scope without its read scope cannot verify its own writes, and
  -- verification by re-reading is the point of the write path.
  AND (NOT 'write:alerts' = ANY(p_scopes) OR 'read:alerts' = ANY(p_scopes))
  AND (NOT 'write:charts' = ANY(p_scopes) OR 'read:charts' = ANY(p_scopes))
  AND (NOT 'write:thesis' = ANY(p_scopes) OR 'read:thesis' = ANY(p_scopes))
$$;

REVOKE ALL ON FUNCTION app_private.intel_agent_scopes_valid(text[]) FROM PUBLIC, anon, authenticated;
-- service_role MUST keep EXECUTE. A CHECK expression runs as the INSERTING role,
-- not as the constraint's owner, and service_role is neither a superuser nor an
-- inheriting member of one. Without this grant every insert into
-- intel_agent_tokens fails with "permission denied for function", which is the
-- entire table made unusable by one missing line.
GRANT EXECUTE ON FUNCTION app_private.intel_agent_scopes_valid(text[]) TO service_role;

CREATE TABLE public.intel_agent_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- profiles(id), not auth.users(id). profiles.id is itself a primary key
 -- referencing auth.users(id) ON DELETE CASCADE, so the two identify the same
 -- person and cascade from the same deletion. What differs is which
 -- neighbourhood this agrees with: every id here is passed as p_user to the
 -- Intel RPCs and joined against org_members, and the Intel tables around it
 -- (intel_theses, intel_chart_layouts, intel_alert_rules) all use profiles.
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 -- Pinned at creation from a session that was already proven to be a member of
 -- this org. Every request the token makes is bound to it.
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
 token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 -- The last six characters of the plaintext, so a member with three tokens can
 -- tell which machine holds which one. The token carries 256 bits of entropy;
 -- six base64url characters is 36 of them, which leaves 220 unguessable.
 token_hint text NOT NULL CHECK(token_hint ~ '^[A-Za-z0-9_-]{6}$'),
 scopes text[] NOT NULL CHECK(app_private.intel_agent_scopes_valid(scopes)),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 revoked_reason text CHECK(revoked_reason IS NULL OR length(revoked_reason)<=200),
 last_used_at timestamptz,
 last_ip_hash text CHECK(last_ip_hash IS NULL OR length(last_ip_hash)<=64),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at>created_at),
 -- Biconditional, deliberately. `>=` reads like "a reason requires a
 -- revocation", but boolean ordering makes it true whenever revoked_at IS NULL
 -- is true, so it PERMITS a revocation reason on a token that still reads as
 -- live. A row carrying a reason while counting as live is exactly the state a
 -- token table must not hold. The two are set together or not at all.
 CHECK((revoked_at IS NULL)=(revoked_reason IS NULL))
);
CREATE UNIQUE INDEX intel_agent_tokens_hash_uq ON public.intel_agent_tokens(token_hash);
CREATE INDEX intel_agent_tokens_owner ON public.intel_agent_tokens(user_id,created_at DESC);
CREATE INDEX intel_agent_tokens_live ON public.intel_agent_tokens(org_id,expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.intel_agent_tokens IS
 'Inbound bearer tokens for a member''s own external agent. Hash only, never plaintext. '
 'The org is pinned on the row; scopes live here rather than in the token so a narrowing '
 'takes effect on the next request.';

-- A proposal. Immutable in every field that changes what would happen, because
-- an approval points at a hash of exactly those fields.
CREATE TABLE public.intel_agent_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 token_id uuid NOT NULL REFERENCES public.intel_agent_tokens(id) ON DELETE CASCADE,
 tool_key text NOT NULL CHECK(tool_key IN ('intel_create_alert','intel_annotate_chart','intel_append_thesis_evidence')),
 -- What row it touches, and what it would put there. Both are validated by the
 -- existing contract for that write before they are ever stored.
 target jsonb NOT NULL CHECK(jsonb_typeof(target)='object' AND octet_length(target::text)<=8000),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=200000),
 plan_hash text NOT NULL CHECK(plan_hash ~ '^[0-9a-f]{64}$'),
 risk_level integer NOT NULL CHECK(risk_level BETWEEN 0 AND 4),
 -- Extension-shaped, so an agent action is attributable and distinguishable
 -- from a human one. Under a token there is no auth.uid() to record.
 actor jsonb NOT NULL CHECK(jsonb_typeof(actor)='object' AND actor->>'source'='agent_token' AND actor->>'human_user_id' IS NOT NULL),
 summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','executed','failed','rejected','expired')),
 result jsonb,
 failure_reason text CHECK(failure_reason IS NULL OR length(failure_reason)<=300),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 executed_at timestamptz,
 CHECK(expires_at>created_at)
);
-- A retry of the same proposal finds the existing one instead of stacking a
-- second approval request for an identical write.
CREATE UNIQUE INDEX intel_agent_plans_live_uq ON public.intel_agent_plans(token_id,plan_hash) WHERE status IN ('proposed','approved');
CREATE INDEX intel_agent_plans_inbox ON public.intel_agent_plans(org_id,user_id,status,created_at DESC);

COMMENT ON TABLE public.intel_agent_plans IS
 'Immutable proposals. tool_key, target, payload and plan_hash cannot be changed after '
 'insert, because an approval is a signature over exactly those fields.';

-- The trigger, not just the convention. An approval that could be re-pointed at
-- a different target after it was given is not an approval.
CREATE FUNCTION app_private.intel_agent_plan_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF NEW.tool_key IS DISTINCT FROM OLD.tool_key OR NEW.target IS DISTINCT FROM OLD.target
  OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash
  OR NEW.token_id IS DISTINCT FROM OLD.token_id OR NEW.org_id IS DISTINCT FROM OLD.org_id
  OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.risk_level IS DISTINCT FROM OLD.risk_level THEN
  RAISE EXCEPTION 'agent_plan_immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intel_agent_plan_immutable BEFORE UPDATE ON public.intel_agent_plans
 FOR EACH ROW EXECUTE FUNCTION app_private.intel_agent_plan_immutable();

-- A person said yes to one exact plan hash.
CREATE TABLE public.intel_agent_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 plan_id uuid NOT NULL REFERENCES public.intel_agent_plans(id) ON DELETE CASCADE,
 -- The hash as approved. Execution compares it against the live plan.
 plan_hash text NOT NULL CHECK(plan_hash ~ '^[0-9a-f]{64}$'),
 -- A human, from a real session. A token can never approve its own proposal.
 -- profiles(id), matching the rest of this migration and the Intel tables.
 approved_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','consumed','revoked')),
 note text CHECK(note IS NULL OR length(note)<=500),
 expires_at timestamptz NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 consumed_at timestamptz,
 CHECK(expires_at>approved_at)
);
-- One live approval per plan. A retry of the approve call finds the existing
-- one rather than minting a second signature over the same hash.
CREATE UNIQUE INDEX intel_agent_approvals_plan_uq ON public.intel_agent_approvals(plan_id) WHERE status='approved';
CREATE INDEX intel_agent_approvals_org ON public.intel_agent_approvals(org_id,approved_at DESC);

COMMENT ON TABLE public.intel_agent_approvals IS
 'A person''s yes to one exact plan_hash, from a real session. A token cannot approve '
 'its own proposal: approved_by is a profiles id written only from a verified session, '
 'and the agent token path never sets it.';

-- What the row actually says after the write. An HTTP 200 is a claim; this is
-- the result of going back and looking.
CREATE TABLE public.intel_agent_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 plan_id uuid NOT NULL REFERENCES public.intel_agent_plans(id) ON DELETE CASCADE,
 verification_type text NOT NULL CHECK(length(verification_type) BETWEEN 1 AND 60),
 expected_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(expected_state)='object' AND octet_length(expected_state::text)<=20000),
 observed_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(observed_state)='object' AND octet_length(observed_state::text)<=20000),
 status text NOT NULL CHECK(status IN ('passed','failed','inconclusive')),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=8000),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX intel_agent_verifications_plan ON public.intel_agent_verifications(plan_id,verified_at DESC);

COMMENT ON TABLE public.intel_agent_verifications IS
 'Evidence that an agent write landed, gathered by re-reading the row. A write whose '
 'verification fails is reported as a failure, never as an empty success.';

ALTER TABLE public.intel_agent_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intel_agent_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intel_agent_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intel_agent_verifications ENABLE ROW LEVEL SECURITY;

-- No policy and no grant for anon or authenticated. Every read and write goes
-- through the edge function, which holds the service role and does the whole
-- authorization in the handler. A token hash must not be reachable from a
-- browser session even in a row the member owns.
REVOKE ALL ON public.intel_agent_tokens FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.intel_agent_plans FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.intel_agent_approvals FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.intel_agent_verifications FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_agent_tokens TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.intel_agent_plans TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.intel_agent_approvals TO service_role;
GRANT SELECT,INSERT ON public.intel_agent_verifications TO service_role;

-- The last check before an agent write runs.
--
-- Evaluated immediately before the write rather than at proposal time, because
-- everything it checks can have changed in between: the token can be revoked,
-- the membership can end, the entitlement can lapse, the approval can expire.
--
-- Returns a verdict with a reason rather than a bare false. A refusal nobody
-- can read is a refusal that gets worked around instead of understood.
CREATE FUNCTION public.intel_agent_execution_gate(p_plan_id uuid,p_token_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_plan public.intel_agent_plans%ROWTYPE; v_token public.intel_agent_tokens%ROWTYPE; v_appr public.intel_agent_approvals%ROWTYPE; v_scope text;
BEGIN
 SELECT * INTO v_plan FROM public.intel_agent_plans WHERE id=p_plan_id;
 IF v_plan.id IS NULL THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','plan_not_found','reason','That proposal does not exist.');
 END IF;
 -- The token executing must be the token that proposed. A second token of the
 -- same member does not inherit another token's approved plan.
 IF v_plan.token_id IS DISTINCT FROM p_token_id THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','plan_not_yours','reason','This proposal was made by a different token.');
 END IF;
 IF v_plan.status='executed' THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','already_executed','reason','This proposal has already run.');
 END IF;
 IF v_plan.status NOT IN ('proposed','approved') THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','plan_'||v_plan.status,'reason',format('This proposal is %s.',v_plan.status));
 END IF;
 IF v_plan.expires_at<now() THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','plan_expired','reason','This proposal expired before it was run. Propose it again.');
 END IF;

 SELECT * INTO v_token FROM public.intel_agent_tokens WHERE id=p_token_id;
 IF v_token.id IS NULL THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','token_invalid','reason','That token does not exist.');
 END IF;
 IF v_token.revoked_at IS NOT NULL THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','token_revoked','reason','That token was revoked.');
 END IF;
 IF v_token.expires_at<=now() THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','token_expired','reason','That token expired.');
 END IF;
 -- The token's pinned org, not the plan's copy of it.
 IF v_token.org_id IS DISTINCT FROM v_plan.org_id OR v_token.user_id IS DISTINCT FROM v_plan.user_id THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','scope_mismatch','reason','This proposal belongs to another workspace.');
 END IF;

 v_scope := CASE v_plan.tool_key
  WHEN 'intel_create_alert' THEN 'write:alerts'
  WHEN 'intel_annotate_chart' THEN 'write:charts'
  WHEN 'intel_append_thesis_evidence' THEN 'write:thesis' END;
 IF v_scope IS NULL OR NOT v_scope=ANY(v_token.scopes) THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','scope_missing','reason',format('This token does not carry %s.',coalesce(v_scope,v_plan.tool_key)));
 END IF;

 -- A token is not an entitlement. Both are re-checked here.
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=v_plan.org_id AND user_id=v_plan.user_id) THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','membership_revoked','reason','The member who created this token is no longer in this workspace.');
 END IF;
 IF public.can_access_intel(v_plan.user_id,v_plan.org_id) IS NOT TRUE THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','entitlement_lost','reason','Investor Intel access is no longer active for this workspace.');
 END IF;

 SELECT * INTO v_appr FROM public.intel_agent_approvals WHERE plan_id=p_plan_id AND status='approved';
 IF v_appr.id IS NULL THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','approval_missing','reason','This write has not been approved yet.');
 END IF;
 IF v_appr.expires_at<now() THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','approval_expired','reason',format('That approval expired on %s.',to_char(v_appr.expires_at,'YYYY-MM-DD HH24:MI')));
 END IF;
 -- The signature check. A plan whose hash no longer matches the approved one is
 -- a different write than the one a person read and allowed.
 IF v_appr.plan_hash IS DISTINCT FROM v_plan.plan_hash THEN
  RETURN jsonb_build_object('allowed',false,'reason_code','plan_changed','reason','The proposal changed after it was approved. It needs approving again.');
 END IF;

 RETURN jsonb_build_object('allowed',true,'reason_code','ok','plan_hash',v_plan.plan_hash,'approval_id',v_appr.id,'tool_key',v_plan.tool_key);
END $$;

REVOKE ALL ON FUNCTION public.intel_agent_execution_gate(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_agent_execution_gate(uuid,uuid) TO service_role;

COMMENT ON FUNCTION public.intel_agent_execution_gate(uuid,uuid) IS
 'The last check before an agent write. Plan existence, token ownership, replay, plan '
 'expiry, token revocation and expiry, pinned org, scope, live membership, live '
 'can_access_intel, approval presence, approval expiry and plan_hash equality. Returns '
 'a reason code, never a bare false.';
