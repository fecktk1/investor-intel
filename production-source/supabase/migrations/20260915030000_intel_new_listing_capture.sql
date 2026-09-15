-- ============================================================
-- Investor Intel — new-listing due diligence (CMC plan proposal 21)
-- ============================================================
-- One new capture table behind the `new_listings` lane of the `intel-capture` Edge Function, and one new arm of the
-- SAME market-alert evaluator:
--
--   intel_new_listing_snapshots  every asset on the daily CoinMarketCap "new listings" page, one row per asset per UTC
--                                day, joined where possible to a contract on a VERIFIED CMC DEX chain (ethereum, base,
--                                arbitrum, solana) and carrying that contract's reported security flags and holder
--                                count. Service-role only, exactly like every other capture table: reads go through
--                                `intel-capture` `{op:'read',view:'new_listings'}`, never through PostgREST.
--
--   listing_flag_change          a trigger that fires when the SECURITY FLAG SET recorded for a listed asset differs
--                                between the two newest daily snapshots. It adds no table, no provider call and no
--                                credit: it reads the capture table this migration creates.
--
-- HONESTY RULES the table enforces in the schema, not only in the job:
--   * A listing with no contract on a verified chain is still stored, with `security_state =
--     'no_contract_on_verified_chain'`. A check makes it impossible for such a row to carry a holder count or a
--     security document at all.
--   * A security or holder call that failed leaves NULLS and records the reason as `security_state`. Zero is a real
--     holder count and is stored as zero; it is never used to stand in for "unknown".
--   * `security` and `security_hash` exist together or not at all, so a hash can never describe a document the table
--     does not hold, and a stored document can never be uncomparable.
--   * The stored document is the whitelisted subset the platform already reads (`exists`, `level`, and items keyed by
--     `code` with `hit`, `level` and a description capped at 200 characters). It is not a mirror of the endpoint.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.
--
-- Credits per day at the seeded cadence (upper bound; a fresh shared cache costs 0):
--   new_listings   1 run x (1 listings page + 25 x (dexSecurity + dexHolderCount)) = 51
-- `newListings` is a Startup capability; below Startup the lane is skipped with `plan_below_startup` and spends
-- nothing, the way `network_stats` is skipped below Growth.
--
-- Retention: 180 days of daily rows, added to app_private.intel_capture_retention below, which stays pg_cron only.
-- The function is restated IN FULL from its live definition (20260915014404_intel_display_currency), because a
-- CREATE OR REPLACE is the whole function: a lost DELETE block means that lane's table grows without bound. The
-- category and FX blocks carried here are guarded with `to_regclass` so a lane that is absent in an environment
-- cannot break the nightly job; this migration's own block is unguarded, its table having just been created.
-- If a LATER capture lane restates this function again, it must carry the intel_new_listing_snapshots block below.
--
-- Vault + net.http_post cron pattern, identical to 20260915010343_intel_capture_cron. Safe to apply anytime; idempotent
-- except for the bridge patch, which refuses a second run rather than guessing at a moved anchor.
--
-- ROLLBACK
--   -- stop the lane, keep the data:
--   SELECT cron.unschedule('intel-capture-new-listings-daily');
--   -- disable it instead of unscheduling it:
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'listings';
--   -- drop the data too:
--   DROP TABLE public.intel_new_listing_snapshots;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'listings';
--   -- then restore app_private.intel_capture_retention from 20260915014404_intel_display_currency.sql
--   -- (otherwise the nightly job errors on its next run against the dropped table),
--   -- and restore public.intel_record_market_alert and public.intel_emit_bridged_alert from
--   -- 20260915014031_intel_liquidation_attention_alerts.sql (the `-- SECTION:` bodies in that file).
--   -- Any listing_flag_change rules left behind then simply never load:
--   UPDATE public.intel_alert_rules SET is_active = false WHERE trigger_type = 'listing_flag_change';
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: new listing capture table

-- 1. The daily new-listing cohort with its per-row due diligence.
CREATE TABLE public.intel_new_listing_snapshots (
  provider text NOT NULL DEFAULT 'coinmarketcap',
  provider_id text NOT NULL,
  snapshot_date date NOT NULL,
  symbol text,
  name text,
  slug text,
  date_added timestamptz,
  -- CAIP-style chain of the joined contract, restricted to the shapes the four verified CMC DEX networks use.
  chain text CHECK (chain IS NULL OR chain ~ '^(eip155:[1-9][0-9]*|solana)$'),
  contract_address text CHECK (contract_address IS NULL OR contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  price numeric,
  market_cap numeric,
  volume_24h numeric,
  change_24h_pct numeric,
  -- A holder count we could not read is NULL. Zero is a real answer and is stored as zero.
  holder_count bigint CHECK (holder_count IS NULL OR holder_count >= 0),
  security jsonb CHECK (security IS NULL OR jsonb_typeof(security) = 'object'),
  security_hash text CHECK (security_hash IS NULL OR security_hash ~ '^[0-9a-f]{64}$'),
  -- 'captured', 'no_contract_on_verified_chain', 'due_diligence_budget', or the provider reason for a failure.
  security_state text NOT NULL CHECK (security_state ~ '^[a-z][a-z0-9_]{0,59}$'),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_id, snapshot_date),
  -- A chain without an address, or an address without a chain, is not an identity.
  CONSTRAINT intel_new_listing_snapshots_identity CHECK ((chain IS NULL) = (contract_address IS NULL)),
  -- A hash always describes a document the table holds, and a held document is always comparable.
  CONSTRAINT intel_new_listing_snapshots_hash CHECK ((security IS NULL) = (security_hash IS NULL)),
  -- Due diligence is impossible without a contract, so it may not be recorded against one that does not exist.
  CONSTRAINT intel_new_listing_snapshots_no_contract CHECK (
    contract_address IS NOT NULL OR (holder_count IS NULL AND security IS NULL AND security_state = 'no_contract_on_verified_chain')),
  CONSTRAINT intel_new_listing_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(price), abs(market_cap), abs(volume_24h), abs(change_24h_pct)]), true))
);
-- The read view asks for "every listing inside the last N days, newest first".
CREATE INDEX intel_new_listing_snapshots_date_idx ON public.intel_new_listing_snapshots (snapshot_date DESC);
-- The alert arm asks for "the two newest snapshots of THIS asset".
CREATE INDEX intel_new_listing_snapshots_asset_idx ON public.intel_new_listing_snapshots (provider_id, snapshot_date DESC);
-- The capture lane's cadence guard asks for the newest capture of any asset.
CREATE INDEX intel_new_listing_snapshots_captured_idx ON public.intel_new_listing_snapshots (captured_at DESC);
ALTER TABLE public.intel_new_listing_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_new_listing_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_new_listing_snapshots TO service_role;

-- 2. Cadence policy for the new lane. A later edit to a row wins, so re-running this migration never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('coinmarketcap', 'listings', 86400, true, 'startup', NULL)
ON CONFLICT (provider, feature) DO NOTHING;

-- 3. Retention, restated in full from 20260915014404 to add intel_new_listing_snapshots at 180 days.
-- 180 days is twice the widest window the read offers (90 days) — enough to review a cohort against the quarter
-- before it without retaining a year of rows nothing reads.
CREATE OR REPLACE FUNCTION app_private.intel_capture_retention(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  removed jsonb := '{}'::jsonb;
  n integer;
BEGIN
  DELETE FROM public.intel_regime_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_regime_snapshots', n);

  DELETE FROM public.intel_rank_history WHERE snapshot_date < (p_now - interval '3 years')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_rank_history', n);

  DELETE FROM public.intel_rwa_universe_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_rwa_universe_snapshots', n);

  DELETE FROM public.intel_index_constituent_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_index_constituent_snapshots', n);

  n := app_private.intel_thin_liquidation_snapshots(p_now);
  removed := removed || jsonb_build_object('intel_liquidation_snapshots', n);

  DELETE FROM public.intel_exchange_reserve_snapshots WHERE snapshot_date < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_exchange_reserve_snapshots', n);

  DELETE FROM public.intel_venue_share_snapshots WHERE snapshot_date < (p_now - interval '3 years')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_venue_share_snapshots', n);

  DELETE FROM public.intel_attention_snapshots WHERE captured_at < p_now - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_attention_snapshots', n);

  DELETE FROM public.intel_network_stats_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_network_stats_snapshots', n);

  -- From the category capture lane, carried so this restatement does not drop it. Guarded because that lane may not
  -- be present in every environment.
  IF to_regclass('public.intel_category_snapshots') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_category_snapshots WHERE captured_at < $1 - interval ''90 days''' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_category_snapshots', n);
  END IF;

  IF to_regclass('public.intel_category_members') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_category_members WHERE snapshot_date < ($1 - interval ''400 days'')::date' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_category_members', n);
  END IF;

  DELETE FROM public.market_asset_demand_daily WHERE day < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('market_asset_demand_daily', n);

  -- From the display-currency lane (20260915014404), carried for the same reason and guarded the same way.
  IF to_regclass('public.intel_fx_rates') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_fx_rates WHERE captured_at < $1 - interval ''400 days''' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_fx_rates', n);
  END IF;

  -- Added here: daily new-listing rows. 180 days is twice the widest read window.
  DELETE FROM public.intel_new_listing_snapshots WHERE snapshot_date < (p_now - interval '180 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_new_listing_snapshots', n);

  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;

-- 4. Schedule. At 06:10 UTC, clear of the :07 hourly batch, the :17 category run, the :23 FX run and the 01:35 daily
-- membership run, so the lane's fifty-one calls never queue behind another lane's. The job is idempotent: rows are
-- keyed on the UTC day and upserted, and the lane additionally skips when the newest capture is younger than the
-- feature's cadence_seconds in provider_schedule_policy.
SELECT cron.unschedule('intel-capture-new-listings-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-new-listings-daily');
SELECT cron.schedule('intel-capture-new-listings-daily', '10 6 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','new_listings'), timeout_milliseconds := 110000);
$$);

-- SECTION: new listing alert bridge
-- The new trigger type joins the ones the market path may bridge. Patched the way 20260911213014, 20260915004720 and
-- 20260915014031 patched it, against the LIVE definition, so no earlier change is reverted and the edit is refused if
-- the reviewed text moved.
DO $bridge$ DECLARE original text;changed text;BEGIN
 original:=pg_get_functiondef('public.intel_emit_bridged_alert(uuid,uuid,integer,text,text,text,text,numeric,jsonb)'::regprocedure);
 changed:=replace(original,
  '''narrative_heat'',''metadata_notice'',''liquidation_cascade'',''attention_entry'')',
  '''narrative_heat'',''metadata_notice'',''liquidation_cascade'',''attention_entry'',''listing_flag_change'')');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_bridge_definition';END IF;
 EXECUTE changed;
END $bridge$;

-- SECTION: new listing alert evaluation
-- The reviewed 20260915014031 body with the smallest possible addition for one more trigger type. The only changed
-- expressions are the accepted trigger list, the metric, unit, freshness and comparison-basis CASEs, the period test
-- and one new behaviour guard. Nothing else moves.
--
-- `listing_flag_change` — metric `listing_flag_change`, unit 'flags'. The value is a CHANGE TEST over the two newest
-- daily snapshots of one asset: 1 when their recorded security-flag hashes differ, 0 when they match. It is neither a
-- rate nor a magnitude, so it has no rolling period, `threshold_pct` must be exactly 1 and the plain level comparator
-- `value >= 1` is the firing test — any other comparator would claim a size a change test does not carry. Freshness is
-- 48 hours: the capture is daily, so two passes is the honest ceiling, the same window `metadata_notice` uses. The
-- observation id carries BOTH hashes and the newer snapshot's date, so a re-armed rule cannot fire twice on one change.
--
-- Not in the bridge's private-owner list, so a firing is a shared market fact with no private owner.
CREATE OR REPLACE FUNCTION public.intel_record_market_alert(p_rule uuid,p_org uuid,p_revision integer,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $market$
DECLARE r intel_alert_rules;e entities;value numeric;level numeric;sample_at timestamptz;known_at timestamptz;expires_at timestamptz;previous jsonb;step jsonb;config jsonb;candidate boolean;outcome text:='evaluated_no_match';metric text;unit text;receipt jsonb;direction text;event_id uuid;freshness interval;BEGIN
 SELECT * INTO r FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org FOR UPDATE;
 IF NOT FOUND OR NOT r.is_active OR r.chart_revision<>p_revision THEN RETURN jsonb_build_object('state','changed');END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR NOT can_access_intel(r.user_id,r.org_id) THEN RETURN jsonb_build_object('state','access_unavailable');END IF;
 IF r.trigger_type NOT IN('price_move','volume_spike','liquidity_drop','metadata_notice','liquidation_cascade','attention_entry','listing_flag_change') OR jsonb_typeof(p_observation)<>'object' OR octet_length(p_observation::text)>8000 THEN RAISE EXCEPTION 'invalid_market_condition';END IF;
 SELECT * INTO e FROM entities WHERE id=r.entity_id AND org_id=r.org_id;
 IF e.id IS NULL OR e.canonical_ref_key IS DISTINCT FROM p_observation->>'subject' THEN RAISE EXCEPTION 'market_condition_identity_changed';END IF;
 value:=(p_observation->>'value')::numeric;level:=CASE WHEN r.trigger_type='liquidity_drop' THEN (r.config->>'min_liquidity_usd')::numeric ELSE (r.config->>'threshold_pct')::numeric END;
 sample_at:=(p_observation->>'sampleAt')::timestamptz;known_at:=(p_observation->>'recordedAt')::timestamptz;expires_at:=(p_observation->>'expiresAt')::timestamptz;
 metric:=CASE r.trigger_type WHEN 'price_move' THEN 'price_change_24h_pct' WHEN 'volume_spike' THEN 'volume_change_24h_pct' WHEN 'metadata_notice' THEN 'metadata_notice' WHEN 'liquidation_cascade' THEN 'liquidation_cascade_ratio' WHEN 'attention_entry' THEN 'attention_persistence_hours' WHEN 'listing_flag_change' THEN 'listing_flag_change' ELSE 'liquidity_usd' END;unit:=CASE r.trigger_type WHEN 'liquidity_drop' THEN 'USD' WHEN 'metadata_notice' THEN 'notice' WHEN 'liquidation_cascade' THEN 'x' WHEN 'attention_entry' THEN 'hours' WHEN 'listing_flag_change' THEN 'flags' ELSE '%' END;
 -- A daily metadata pass cannot meet a twenty-minute window, and an hourly
 -- attention capture needs one hour plus the slack to run it; nothing else moves.
 -- The new-listing lane is daily too, so it takes the same 48 hours.
 freshness:=CASE r.trigger_type WHEN 'metadata_notice' THEN interval '48 hours' WHEN 'listing_flag_change' THEN interval '48 hours' WHEN 'attention_entry' THEN interval '90 minutes' ELSE interval '20 minutes' END;
 -- The notice rule is a presence test. Any other comparator or threshold would
 -- claim a magnitude a presence flag does not carry.
 IF r.trigger_type='metadata_notice' AND (coalesce(r.config->>'condition','legacy_level')<>'legacy_level' OR level IS DISTINCT FROM 1 OR value NOT IN(0,1)) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 -- The listing flag rule is a change test between two dated snapshots, for the
 -- same reason: "the flags changed" has no size, only a yes or a no.
 IF r.trigger_type='listing_flag_change' AND (coalesce(r.config->>'condition','legacy_level')<>'legacy_level' OR level IS DISTINCT FROM 1 OR value NOT IN(0,1)) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 -- A cascade multiple is a ratio against the asset's own seven-day average. Below
 -- 1.5 it is noise and above 20 it is not a threshold anyone can defend; a
 -- negative ratio is not a measurement at all.
 IF r.trigger_type='liquidation_cascade' AND (level<1.5 OR level>20 OR value<0) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 -- Persistence is a whole number of hourly captures inside the retained day.
 IF r.trigger_type='attention_entry' AND (level<1 OR level>24 OR level<>trunc(level) OR value<0 OR value>24 OR value<>trunc(value)) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 IF value IS NULL OR level IS NULL OR abs(value)>1e18 OR value::text IN('NaN','Infinity','-Infinity') OR level<0 OR level>1e18 OR level::text IN('NaN','Infinity','-Infinity') OR p_observation->>'unit' IS DISTINCT FROM unit OR nullif(p_observation->>'id','') IS NULL OR nullif(p_observation->>'sourceRef','') IS NULL THEN RAISE EXCEPTION 'market_condition_value_invalid';END IF;
 IF sample_at IS NULL OR known_at IS NULL OR expires_at IS NULL OR sample_at>now() OR known_at>now() OR expires_at<=now() OR sample_at<now()-freshness OR known_at<now()-freshness THEN RAISE EXCEPTION 'market_condition_source_expired';END IF;
 -- A cascade ratio states the window it describes; a persistence count and a flag
 -- change have no rolling window at all and may not claim one. Every other
 -- trigger is unchanged.
 IF r.trigger_type='liquidation_cascade' THEN
  IF (p_observation->>'periodSeconds')::integer IS NULL OR (p_observation->>'periodSeconds')::integer NOT IN(3600,14400) THEN RAISE EXCEPTION 'market_condition_period_invalid';END IF;
 ELSIF r.trigger_type IN('attention_entry','listing_flag_change') THEN
  IF p_observation->>'periodSeconds' IS NOT NULL THEN RAISE EXCEPTION 'market_condition_period_invalid';END IF;
 ELSIF r.trigger_type NOT IN('liquidity_drop','metadata_notice') AND (p_observation->>'periodSeconds')::integer IS DISTINCT FROM 86400 THEN RAISE EXCEPTION 'market_condition_period_invalid';END IF;
 IF p_observation->>'clockBasis'='provider_observation' THEN
  IF (p_observation->>'observedAt')::timestamptz IS DISTINCT FROM sample_at THEN RAISE EXCEPTION 'market_condition_clock_invalid';END IF;
 ELSIF p_observation->>'clockBasis'='cache_capture' THEN
  IF p_observation->>'observedAt' IS NOT NULL OR sample_at<>known_at THEN RAISE EXCEPTION 'market_condition_clock_invalid';END IF;
 ELSE RAISE EXCEPTION 'market_condition_clock_invalid';END IF;
 previous:=CASE WHEN r.chart_state->>'revision'=p_revision::text THEN coalesce(r.chart_state->'sample','{}') ELSE '{}' END;
 IF previous->>'observationId'=p_observation->>'id' THEN RETURN jsonb_build_object('state','same_observation');END IF;
 IF nullif(previous->>'observedAt','')::timestamptz>=sample_at THEN RETURN jsonb_build_object('state','older_observation_ignored');END IF;
 direction:=coalesce(r.config->>'direction','either');
 IF direction NOT IN('up','down','either') THEN RAISE EXCEPTION 'market_condition_direction_invalid';END IF;
 IF r.trigger_type='price_move' THEN value:=CASE direction WHEN 'down' THEN -value WHEN 'either' THEN abs(value) ELSE value END;END IF;
 config:=jsonb_build_object('threshold_usd',level,'direction',CASE WHEN r.trigger_type='liquidity_drop' THEN 'below' ELSE 'above' END,'hysteresis_pct',coalesce(r.config->'hysteresis_pct','0'),'sustain_minutes',CASE WHEN r.config->>'condition'='sustained' THEN coalesce(r.config->'sustain_minutes','15') ELSE '0'::jsonb END);
 IF jsonb_typeof(config->'hysteresis_pct')<>'number' OR (config->>'hysteresis_pct')::numeric NOT BETWEEN 0 AND 50 OR jsonb_typeof(config->'sustain_minutes')<>'number' OR (config->>'sustain_minutes')::numeric<>trunc((config->>'sustain_minutes')::numeric) OR (config->>'sustain_minutes')::integer NOT BETWEEN 0 AND 1440 OR (r.config->>'condition'='sustained' AND (config->>'sustain_minutes')::integer<15) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 IF coalesce(r.config->>'condition','legacy_level') NOT IN('legacy_level','crossing','sustained') OR coalesce(r.config->>'repeat','rearm') NOT IN('rearm','once') THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 step:=app_private.intel_condition_step(previous,jsonb_build_object('observationId',p_observation->>'id','observedAt',sample_at,'value',value,'provider',p_observation->>'provider','subject',p_observation->>'subject'||':'||metric||':'||(p_observation->>'clockBasis')),config);
 candidate:=CASE WHEN coalesce(r.config->>'condition','legacy_level')='legacy_level' THEN CASE WHEN r.trigger_type='liquidity_drop' THEN value>=0 AND value<level ELSE value>=level END ELSE (step->>'candidate')::boolean END;
 receipt:=jsonb_build_object('rule_revision',p_revision,'config',r.config,'metric',metric,'unit',unit,'observation',p_observation-'value','checkedAt',now(),'method',coalesce(r.config->>'condition','legacy_level'),'comparison_basis',CASE WHEN r.trigger_type='price_move' THEN 'Reported rolling 24-hour price change; not change since activation or entry.' WHEN r.trigger_type='volume_spike' THEN 'Reported rolling 24-hour volume change.' WHEN r.trigger_type='metadata_notice' THEN 'Presence of a provider listing notice at the daily metadata clock; its wording, cause and severity are not evaluated.' WHEN r.trigger_type='liquidation_cascade' THEN 'Reported liquidation total for the stated window against the same window''s seven-day average of retained captures; it is not a measure of positions at risk.' WHEN r.trigger_type='attention_entry' THEN 'Consecutive hourly captures of the named provider list that contained the asset; attention is not a valuation and the list ordering is not published.' WHEN r.trigger_type='listing_flag_change' THEN 'Whether the security flags the provider reported for this contract differ between the two newest daily captures; the provider publishes no time at which a flag changed, and a changed flag set is not a safety verdict.' ELSE 'Reported absolute liquidity; not executable depth.' END);
 IF candidate THEN
  outcome:=public.intel_emit_bridged_alert(r.id,r.org_id,r.chart_revision,p_observation->>'provider','retained_market_observation',p_observation->>'id',metric,(p_observation->>'value')::numeric,jsonb_build_object('checkpoint',receipt,'ref',e.canonical_ref_key,'symbol',e.display_symbol,'threshold',level,'unit',unit,'source_observed_at',p_observation->'observedAt','known_at',p_observation->'recordedAt','provider_source_ref',p_observation->>'sourceRef','expires_at',p_observation->'expiresAt','coverage',p_observation->>'coverage','why_now','The recorded condition matched a compatible retained sample. Review its source clock and coverage.'));
 END IF;
 IF NOT candidate THEN outcome:=step->>'state';END IF;
 UPDATE intel_alert_rules SET chart_state=jsonb_build_object('revision',p_revision,'sample',step->'next'),evaluation_state=receipt||jsonb_build_object('status',outcome),last_evaluation_attempt_at=now() WHERE id=r.id;
 IF outcome='fired' AND r.config->>'repeat'='once' THEN
  UPDATE intel_alert_rules SET is_active=false WHERE id=r.id;
  -- Preserve the firing receipt even if a legacy activation guard increments the
  -- paused state revision. The receipt retains the exact evaluated rule version.
  UPDATE intel_alert_rules SET evaluation_state=receipt||jsonb_build_object('status','fired') WHERE id=r.id;
 END IF;
 SELECT id INTO event_id FROM intel_alert_events WHERE rule_id=r.id AND dedup_key='retained_market_observation:'||(p_observation->>'id')||':revision:'||p_revision;
 RETURN jsonb_build_object('state',outcome,'eventId',event_id,'checkpoint',receipt);
END $market$;
REVOKE ALL ON FUNCTION public.intel_record_market_alert(uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_market_alert(uuid,uuid,integer,jsonb) TO service_role;
