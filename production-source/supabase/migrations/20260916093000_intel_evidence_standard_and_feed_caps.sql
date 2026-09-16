-- ============================================================
-- SHIPPING ORDER DEPENDENCY - READ BEFORE DEPLOYING THIS BRANCH
-- ============================================================
-- This migration PATCHES three live function definitions by EXACT STRING MATCH
-- and RAISES when the text it expects is not there:
--
--   app_private.intel_condition_step      -> 'unexpected_condition_step_definition'
--   app_private.intel_market_rule_guard   -> 'unexpected_market_rule_guard'
--   public.intel_markets_screen_for_user  -> 'unexpected_markets_gainers_definition'
--                                            'unexpected_markets_losers_definition'
--
-- Raising is the RIGHT failure mode - a silent no-op would leave the feed caps
-- and the hysteresis wiring unapplied with nothing to show for it - but it makes
-- this branch ORDER DEPENDENT. If any other branch edits one of those three
-- functions and lands first, the live text moves, the guard fires, and the whole
-- seven-migration sequence aborts here, at file 3 of 7.
--
-- SO: this branch must land BEFORE anything else that touches those three
-- functions. If something else has already landed on one of them, do NOT relax
-- the guard. Re-derive the replacement strings against the new live text and
-- re-review them: the guard firing means the body this file was written against
-- is no longer the body in production.
-- ============================================================
--
-- ============================================================
-- Investor Intel - the stated evidentiary standard, hysteresis on the level
-- triggers that lacked it, and per-entity caps on the ranked feeds
-- ============================================================
-- Three additive changes. Nothing is removed, no existing rule changes meaning,
-- and every list this touches is the same length or longer than it was.
--
-- 1. THE EVIDENTIARY STANDARD. A market move counts as CORROBORATED only when
--    price, market capitalisation AND volume describe one window, each with its
--    own observation clock, and all agree. Anything else is a research lead.
--    The field is `metric_agreement` with values corroborated / conflicting /
--    incomplete / unmeasured. It deliberately shares no morpheme with
--    "confirmed", which this codebase already spends on FOUR unrelated ideas:
--    narrative-scoring's *_confirmation_score components and its 'confirmed'
--    lifecycle stage, intel-signals' `market_confirmed` (a 24-hour PRICE move
--    alone), thesis-evidence's EngineStatus 'confirmed'/'partially_confirmed',
--    and the portfolio classifier's 'confirmed' classification.
--
--    The verdict is COMPUTED IN TYPESCRIPT (`_shared/intel/metric-agreement.ts`,
--    read by `metric-agreement-read.ts`) because that is where the retained
--    observations are already being read. This migration's job is to VALIDATE
--    the verdict and put it on the receipt: an unreadable or absent verdict
--    becomes 'unmeasured', which is a research lead, so a malformed payload can
--    never upgrade an alert's evidence class. The existing confidence column and
--    its high/medium/low CHECKs (133:60, 044:130) are untouched: this is a
--    different question from confidence and does not widen that vocabulary.
--
--    Market capitalisation is the honest weak point and is treated as one. For a
--    CoinMarketCap listing it arrives as a DATED LEVEL, so a change is derivable
--    only when two levels roughly a day apart are retained, and corroboration is
--    genuinely reachable. For a Birdeye overview the retained response carries
--    our CAPTURE clock only, and for a CMC DEX discovery cohort market
--    capitalisation is explicitly undated at source. Those sources degrade to a
--    stated reason and can never reach 'corroborated'.
--
-- 2. HYSTERESIS WHERE IT WAS MISSING. `app_private.intel_condition_step`
--    (20260911202815) is a complete armed/re-arm machine and is NOT rebuilt
--    here. It gains ONE optional config key, `max_gap_minutes`, defaulting to
--    the 20 minutes it already hard-coded, so a slower lane can use the same
--    machine without a quote-cadence gap resetting it on every pass. Every
--    existing caller passes no such key and is byte-for-byte unchanged.
--
--    It is then wired to the two bridge paths that are genuinely CROSSABLE
--    LEVELS:
--      * supply_shock   a signed percentage against a threshold, via the new
--                       public.intel_step_bridged_condition.
--      * narrative_heat the momentum-delta and risk-score arms, inside
--                       public.intel_record_narrative_alert.
--
--    Deliberately NOT wired, because none of them is a level that can oscillate
--    and all of them are already permanently deduped by
--    (rule, source_table, source_ref):
--      * wallet_activity     every candidate is a DISTINCT transfer. Two
--                            transfers over the floor are two real events; a
--                            re-arm gate would silence the second one.
--      * unlock              qualification is a DATE WINDOW, not a level, and a
--                            calendar version fires at most once per rule.
--      * metadata_migration  each drift row is a distinct recorded change.
--      * holder_shift        it WOULD be a level (top-10 concentration), but
--                            alert-candidates.ts refuses it outright for want of
--                            a comparable population id and an original source
--                            clock. A state machine over a source that never
--                            produces a candidate would be dead code dressed as
--                            a rule.
--      * narrative stage_change  a DISCRETE transition between two named
--                            stages. Debouncing it would suppress a real second
--                            transition rather than smooth a flapping number.
--
--    OPT-IN, exactly like the market path. Both new lanes read
--    `coalesce(config->>'condition','legacy_level')` the same way
--    intel_record_market_alert has since 20260911213014, so every rule that
--    exists today keeps its current firing test until its owner chooses
--    'crossing' or 'sustained' in the editor. That is what stops this from being
--    a silent behaviour change to live rules.
--
--    STATE THIS PLAINLY, because it is easy to read this migration and conclude
--    the opposite: APPLYING THIS DOES NOT BY ITSELF STOP ANY EXISTING ALERT FROM
--    DOUBLE-FIRING. It makes the fix AVAILABLE. Every supply_shock and
--    narrative_heat rule already in the table carries no `condition` key, so it
--    keeps its plain level test and will keep re-firing across an oscillating
--    threshold until somebody opens it and chooses a crossing or sustained
--    evaluation. Flipping that default here would silently rewrite the firing
--    behaviour of live rules whose owners never asked for it, which is the worse
--    of the two failures.
--
-- 3. PER-ENTITY CAPS. The only diversity rule in the repo was the markets
--    category board's row_number() window (20260914234442). The same shape is
--    applied to narrative_feed, signal_feed and the markets gainers/losers
--    boards, and to the TypeScript feeds through
--    `_shared/intel/feed-entity-cap.ts`.
--
--    A CAP NEVER EMPTIES A LIST. Every cap here is expressed as an ORDER BY over
--    a clamped row_number, never as a WHERE: over-quota rows sort AFTER the
--    in-quota ones and the existing LIMIT then takes exactly as many rows as it
--    always did. A board with only one entity in it is therefore the same length
--    it was before the cap, just as a board with many entities is.
--
-- Safe to apply once. Every patched function is edited against its LIVE
-- definition and refuses to apply if the reviewed text has moved.
--
-- ROLLBACK
--   DROP FUNCTION public.intel_step_bridged_condition(uuid,uuid,integer,jsonb);
--   -- then re-create from their previous migrations:
--   --   app_private.intel_condition_step      20260911202815
--   --   app_private.intel_market_rule_guard   20260911213014 + 20260911220846
--   --   public.intel_record_market_alert      20260915034150
--   --   public.intel_record_narrative_alert   20260911213014
--   --   public.narrative_feed                 219
--   --   public.signal_feed                    233
--   --   public.intel_markets_screen_for_user  20260915014302
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: the condition machine learns a slower cadence
-- One optional key, defaulting to the 20 minutes already hard-coded, so the
-- chart and market lanes are unchanged and a daily or six-hourly lane can use
-- the same reviewed transition instead of a second copy of it.
DO $gap$ DECLARE original text;changed text;occurrences integer;BEGIN
 original:=pg_get_functiondef('app_private.intel_condition_step(jsonb,jsonb,jsonb)'::regprocedure);
 occurrences:=(length(original)-length(replace(original,'t-prior_at<=interval ''20 minutes''','')))/length('t-prior_at<=interval ''20 minutes''');
 IF occurrences<>1 THEN RAISE EXCEPTION 'unexpected_condition_step_definition';END IF;
 changed:=replace(original,'t-prior_at<=interval ''20 minutes''','t-prior_at<=make_interval(mins=>coalesce((config->>''max_gap_minutes'')::integer,20))');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_condition_step_definition';END IF;
 EXECUTE changed;
END $gap$;
REVOKE ALL ON FUNCTION app_private.intel_condition_step(jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_condition_step(jsonb,jsonb,jsonb) TO service_role;

-- SECTION: the rule guard validates behaviour on the two new level triggers
-- Same validation the market triggers already get, so a reset margin outside
-- 0..50 or an unknown condition is refused at write time rather than discovered
-- during an evaluation. Existing rows validate unchanged: none of them carries a
-- condition, repeat, direction or hysteresis_pct key, and every coalesce default
-- in that guard is the legacy behaviour.
DO $guard$ DECLARE original text;changed text;BEGIN
 original:=pg_get_functiondef('app_private.intel_market_rule_guard()'::regprocedure);
 changed:=replace(original,
  'IF NEW.trigger_type IN(''price_move'',''volume_spike'',''liquidity_drop'') THEN',
  'IF NEW.trigger_type IN(''price_move'',''volume_spike'',''liquidity_drop'',''supply_shock'',''narrative_heat'') THEN');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_market_rule_guard';END IF;
 EXECUTE changed;
END $guard$;
REVOKE ALL ON FUNCTION app_private.intel_market_rule_guard() FROM PUBLIC,anon,authenticated;

-- SECTION: the bridge steps its level triggers through the condition machine
-- The bridge had cooldown plus permanent source_ref dedupe and nothing else, so
-- a percentage oscillating around its threshold re-fired every time the cooldown
-- lapsed. This is the market path's transition, applied to the bridge's one
-- oscillating level, and nothing else: the trigger list is closed.
--
-- MAGNITUDE, NOT SIGN. The deployed supply_shock test is abs(pct) >= threshold
-- (alert-bridge.ts exceedsThreshold), so a 10% CONTRACTION fires a 5% rule
-- today. The machine is therefore fed abs(value) with direction 'above', which
-- preserves that meaning exactly and makes the reset margin a margin on
-- magnitude. Reading the signed value instead would silently stop every
-- contraction alert that fires today.
CREATE FUNCTION public.intel_step_bridged_condition(p_rule uuid,p_org uuid,p_revision integer,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $step$
DECLARE r intel_alert_rules;value numeric;level numeric;observed timestamptz;previous jsonb;config jsonb;step jsonb;candidate boolean;BEGIN
 SELECT * INTO r FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org FOR UPDATE;
 IF NOT FOUND OR NOT r.is_active OR r.chart_revision<>p_revision THEN RETURN jsonb_build_object('candidate',false,'state','changed');END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR NOT can_access_intel(r.user_id,r.org_id) THEN RETURN jsonb_build_object('candidate',false,'state','access_unavailable');END IF;
 IF r.trigger_type NOT IN('supply_shock') OR jsonb_typeof(p_observation)<>'object' OR octet_length(p_observation::text)>4000 THEN RAISE EXCEPTION 'invalid_bridge_condition';END IF;
 value:=(p_observation->>'value')::numeric;level:=(r.config->>'threshold_pct')::numeric;
 observed:=(p_observation->>'observedAt')::timestamptz;
 IF value IS NULL OR abs(value)>1e18 OR value::text IN('NaN','Infinity','-Infinity')
  OR level IS NULL OR level<0 OR level>1e18 OR level::text IN('NaN','Infinity','-Infinity')
  OR observed IS NULL OR observed>now()
  OR nullif(p_observation->>'observationId','') IS NULL OR nullif(p_observation->>'provider','') IS NULL OR nullif(p_observation->>'subject','') IS NULL
  THEN RAISE EXCEPTION 'bridge_condition_value_invalid';END IF;
 previous:=CASE WHEN r.chart_state->>'revision'=p_revision::text THEN coalesce(r.chart_state->'sample','{}') ELSE '{}' END;
 IF previous->>'observationId'=p_observation->>'observationId' THEN RETURN jsonb_build_object('candidate',false,'state','same_observation');END IF;
 IF nullif(previous->>'observedAt','')::timestamptz>=observed THEN RETURN jsonb_build_object('candidate',false,'state','older_observation_ignored');END IF;
 -- Supply snapshots are captured across a two-day window (alert-candidates.ts),
 -- so a quote-cadence gap rule would treat every consecutive pair as a fresh
 -- baseline and the machine would never reach a crossing.
 config:=jsonb_build_object('threshold_usd',level,'direction','above',
  'hysteresis_pct',coalesce(r.config->'hysteresis_pct','0'),
  'sustain_minutes',CASE WHEN r.config->>'condition'='sustained' THEN coalesce(r.config->'sustain_minutes','15') ELSE '0'::jsonb END,
  'max_gap_minutes',2880);
 IF jsonb_typeof(config->'hysteresis_pct')<>'number' OR (config->>'hysteresis_pct')::numeric NOT BETWEEN 0 AND 50
  OR jsonb_typeof(config->'sustain_minutes')<>'number' OR (config->>'sustain_minutes')::numeric<>trunc((config->>'sustain_minutes')::numeric)
  OR (config->>'sustain_minutes')::integer NOT BETWEEN 0 AND 1440
  OR (r.config->>'condition'='sustained' AND (config->>'sustain_minutes')::integer<15)
  OR coalesce(r.config->>'condition','legacy_level') NOT IN('legacy_level','crossing','sustained')
  OR coalesce(r.config->>'repeat','rearm') NOT IN('rearm','once')
  THEN RAISE EXCEPTION 'bridge_condition_behavior_invalid';END IF;
 step:=app_private.intel_condition_step(previous,jsonb_build_object('observationId',p_observation->>'observationId','observedAt',observed,'value',abs(value),'provider',p_observation->>'provider','subject',p_observation->>'subject'),config);
 -- A rule recorded before this lane existed keeps its own test, exactly as the
 -- market path does for its legacy rules. Opting in is an editor choice.
 candidate:=CASE WHEN coalesce(r.config->>'condition','legacy_level')='legacy_level' THEN abs(value)>=level ELSE coalesce((step->>'candidate')::boolean,false) END;
 UPDATE intel_alert_rules SET chart_state=jsonb_build_object('revision',p_revision,'sample',step->'next'),last_evaluation_attempt_at=now() WHERE id=r.id;
 RETURN jsonb_build_object('candidate',candidate,'state',CASE WHEN candidate THEN 'crossed' ELSE step->>'state' END);
END $step$;
REVOKE ALL ON FUNCTION public.intel_step_bridged_condition(uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_step_bridged_condition(uuid,uuid,integer,jsonb) TO service_role;

-- SECTION: the market alert receipt states its evidence class
-- The reviewed 20260915034150 body with two additions and NOTHING else moved:
-- the `agreement` validation, and `metric_agreement` on the receipt and on the
-- fired payload. Every trigger keeps its metric, unit, period, freshness, clock
-- rules, comparator, state transition and comparison basis unchanged.
CREATE OR REPLACE FUNCTION public.intel_record_market_alert(p_rule uuid,p_org uuid,p_revision integer,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $market$
DECLARE r intel_alert_rules;e entities;value numeric;level numeric;sample_at timestamptz;known_at timestamptz;expires_at timestamptz;previous jsonb;step jsonb;config jsonb;candidate boolean;outcome text:='evaluated_no_match';metric text;unit text;receipt jsonb;direction text;event_id uuid;freshness interval;agreement jsonb;BEGIN
 SELECT * INTO r FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org FOR UPDATE;
 IF NOT FOUND OR NOT r.is_active OR r.chart_revision<>p_revision THEN RETURN jsonb_build_object('state','changed');END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR NOT can_access_intel(r.user_id,r.org_id) THEN RETURN jsonb_build_object('state','access_unavailable');END IF;
 IF r.trigger_type NOT IN('price_move','volume_spike','liquidity_drop','metadata_notice','liquidation_cascade','attention_entry','listing_flag_change') OR jsonb_typeof(p_observation)<>'object' OR octet_length(p_observation::text)>12000 THEN RAISE EXCEPTION 'invalid_market_condition';END IF;
 SELECT * INTO e FROM entities WHERE id=r.entity_id AND org_id=r.org_id;
 IF e.id IS NULL OR e.canonical_ref_key IS DISTINCT FROM p_observation->>'subject' THEN RAISE EXCEPTION 'market_condition_identity_changed';END IF;
 -- The evidentiary standard rides with the observation and is VALIDATED, never
 -- trusted. Anything unreadable becomes 'unmeasured', which is a research lead,
 -- so a malformed payload can only ever weaken a claim and never strengthen it.
 agreement:=CASE WHEN jsonb_typeof(p_observation->'agreement')='object'
   AND p_observation->'agreement'->>'metric_agreement' IN('corroborated','conflicting','incomplete','unmeasured')
   AND octet_length((p_observation->'agreement')::text)<=3000
  THEN p_observation->'agreement'
  ELSE jsonb_build_object('metric_agreement','unmeasured','research_lead',true,'period_seconds',NULL,'reasons',jsonb_build_array('metric_not_supplied'),'readings',jsonb_build_array()) END;
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
 receipt:=jsonb_build_object('rule_revision',p_revision,'config',r.config,'metric',metric,'unit',unit,'observation',p_observation-'value'-'agreement','metric_agreement',agreement,'checkedAt',now(),'method',coalesce(r.config->>'condition','legacy_level'),'comparison_basis',CASE WHEN r.trigger_type='price_move' THEN 'Reported rolling 24-hour price change; not change since activation or entry.' WHEN r.trigger_type='volume_spike' THEN 'Reported rolling 24-hour volume change.' WHEN r.trigger_type='metadata_notice' THEN 'Presence of a provider listing notice at the daily metadata clock; its wording, cause and severity are not evaluated.' WHEN r.trigger_type='liquidation_cascade' THEN 'Reported liquidation total for the stated window against the same window''s seven-day average of retained captures; it is not a measure of positions at risk.' WHEN r.trigger_type='attention_entry' THEN 'Consecutive hourly captures of the named provider list that contained the asset; attention is not a valuation and the list ordering is not published.' WHEN r.trigger_type='listing_flag_change' THEN 'Whether the security flags the provider reported for this contract differ between the two newest daily captures; the provider publishes no time at which a flag changed, and a changed flag set is not a safety verdict.' ELSE 'Reported absolute liquidity; not executable depth.' END);
 IF candidate THEN
  outcome:=public.intel_emit_bridged_alert(r.id,r.org_id,r.chart_revision,p_observation->>'provider','retained_market_observation',p_observation->>'id',metric,(p_observation->>'value')::numeric,jsonb_build_object('checkpoint',receipt,'ref',e.canonical_ref_key,'symbol',e.display_symbol,'threshold',level,'unit',unit,'metric_agreement',agreement->>'metric_agreement','source_observed_at',p_observation->'observedAt','known_at',p_observation->'recordedAt','provider_source_ref',p_observation->>'sourceRef','expires_at',p_observation->'expiresAt','coverage',p_observation->>'coverage','why_now','The recorded condition matched a compatible retained sample. Review its source clock and coverage.'));
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

-- SECTION: narrative heat gains hysteresis on its level arms and states its evidence class
-- The reviewed 20260911213014 body with three additions and nothing else moved.
--
-- WHICH ARMS. `stage_change` is a DISCRETE transition between two named stages
-- and keeps its existing test: a re-arm gate over it would suppress a genuine
-- second transition. `momentum_delta` and `risk_score` are continuously moving
-- numbers compared to a fixed level on every pass, which is exactly what a
-- crossing test is for, so both take the machine.
--
-- SEPARATE STATE PER ARM. Each arm's observation names its own subject
-- (`<narrative>:momentum` / `<narrative>:risk`), which is how intel_condition_step
-- decides two samples are contiguous. Storing them in one slot would let a
-- risk reading be compared against a momentum baseline.
--
-- ABSENT IS NOT ZERO. A missing momentum delta or risk score does NOT step the
-- machine with a zero; the arm carries its previous state forward untouched, so
-- a gap in scoring can never arm or fire a rule.
--
-- EVIDENCE CLASS. A narrative score carries price and volume confirmation
-- components but NO market capitalisation, so the full agreement test cannot be
-- run on it. It is recorded as 'incomplete' with that exact reason rather than
-- left blank, which a reader could mistake for a test that passed.
CREATE OR REPLACE FUNCTION public.intel_record_narrative_alert(p_rule uuid,p_org uuid,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $narrative$
DECLARE r intel_alert_rules;s narrative_state;title text;reason text;outcome text;event_id uuid;checkpoint jsonb;momentum numeric;risk numeric;delta numeric;source_ref text;behavior text;previous jsonb;momentum_step jsonb;risk_step jsonb;agreement jsonb;BEGIN
 SELECT * INTO r FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org FOR UPDATE;
 IF NOT FOUND OR NOT r.is_active OR r.chart_revision<>p_revision OR r.trigger_type<>'narrative_heat' THEN RETURN jsonb_build_object('state','changed');END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR NOT can_access_intel(r.user_id,r.org_id) THEN RETURN jsonb_build_object('state','access_unavailable');END IF;
 SELECT st.* INTO s FROM narrative_state st JOIN narrative_taxonomy t ON t.id=st.narrative_id WHERE t.slug=r.config->>'slug' FOR SHARE OF st;
 IF NOT FOUND OR s.scored_at IS NULL OR s.scored_at>now() OR s.scored_at<now()-interval '6 hours' THEN
  PERFORM intel_record_alert_evaluation(r.id,r.org_id,r.chart_revision,'{"status":"evidence_unavailable","reason":"No narrative calculation within the last six hours is available. Its calculation time is distinct from underlying source observation times."}');RETURN jsonb_build_object('state','evidence_unavailable');
 END IF;
 SELECT name INTO title FROM narrative_taxonomy WHERE id=s.narrative_id;
 momentum:=coalesce((r.config->>'momentum_delta')::numeric,10);risk:=coalesce((r.config->>'risk_score')::numeric,65);
 IF momentum NOT BETWEEN 0 AND 100 OR risk NOT BETWEEN 0 AND 100 THEN RAISE EXCEPTION 'narrative_threshold_invalid';END IF;
 delta:=CASE WHEN jsonb_typeof(s.score_delta->'momentum')='number' THEN (s.score_delta->>'momentum')::numeric ELSE NULL END;
 behavior:=coalesce(r.config->>'condition','legacy_level');
 IF behavior NOT IN('legacy_level','crossing','sustained') OR coalesce(r.config->>'repeat','rearm') NOT IN('rearm','once')
  OR (r.config?'hysteresis_pct' AND (jsonb_typeof(r.config->'hysteresis_pct')<>'number' OR (r.config->>'hysteresis_pct')::numeric NOT BETWEEN 0 AND 50))
  THEN RAISE EXCEPTION 'narrative_condition_behavior_invalid';END IF;
 previous:=CASE WHEN r.chart_state->>'revision'=p_revision::text THEN coalesce(r.chart_state->'sample','{}') ELSE '{}' END;
 -- Narrative scoring runs on its own cadence, well outside a quote's twenty
 -- minutes, so the machine is told the six hours this function already treats as
 -- the ceiling for a usable calculation. Without that every pass would baseline.
 momentum_step:=CASE WHEN delta IS NULL THEN jsonb_build_object('candidate',false,'state','evidence_unavailable','next',coalesce(previous->'momentum','{}'))
  ELSE app_private.intel_condition_step(coalesce(previous->'momentum','{}'),
   jsonb_build_object('observationId',s.narrative_id::text||':'||s.scored_at::text||':momentum','observedAt',s.scored_at,'value',delta,'provider','narrative','subject',s.narrative_id::text||':momentum'),
   jsonb_build_object('threshold_usd',momentum,'direction','above','hysteresis_pct',coalesce(r.config->'hysteresis_pct','0'),'sustain_minutes',CASE WHEN behavior='sustained' THEN coalesce(r.config->'sustain_minutes','15') ELSE '0'::jsonb END,'max_gap_minutes',360)) END;
 risk_step:=CASE WHEN s.risk_score IS NULL THEN jsonb_build_object('candidate',false,'state','evidence_unavailable','next',coalesce(previous->'risk','{}'))
  ELSE app_private.intel_condition_step(coalesce(previous->'risk','{}'),
   jsonb_build_object('observationId',s.narrative_id::text||':'||s.scored_at::text||':risk','observedAt',s.scored_at,'value',s.risk_score,'provider','narrative','subject',s.narrative_id::text||':risk'),
   jsonb_build_object('threshold_usd',risk,'direction','above','hysteresis_pct',coalesce(r.config->'hysteresis_pct','0'),'sustain_minutes',CASE WHEN behavior='sustained' THEN coalesce(r.config->'sustain_minutes','15') ELSE '0'::jsonb END,'max_gap_minutes',360)) END;
 IF coalesce((r.config->>'stage_change')::boolean,true) AND s.prev_stage IS NOT NULL AND s.lifecycle_stage IS NOT NULL AND s.prev_stage<>s.lifecycle_stage AND s.stage_changed_at BETWEEN now()-interval '6 hours' AND now() THEN reason:='stage '||s.prev_stage||' → '||s.lifecycle_stage;
 ELSIF (CASE WHEN behavior='legacy_level' THEN delta>=momentum ELSE coalesce((momentum_step->>'candidate')::boolean,false) END) THEN reason:='momentum '||delta::text||' points';
 ELSIF coalesce((r.config->>'risk_spike')::boolean,true) AND (CASE WHEN behavior='legacy_level' THEN s.risk_score>=risk ELSE coalesce((risk_step->>'candidate')::boolean,false) END) THEN reason:='risk elevated ('||s.risk_score::text||' points)';END IF;
 agreement:=jsonb_build_object('metric_agreement','incomplete','research_lead',true,'period_seconds',NULL,
  'reasons',jsonb_build_array('narrative_scores_exclude_market_cap'),'readings',jsonb_build_array());
 checkpoint:=jsonb_build_object('rule_revision',r.chart_revision,'config',r.config,'calculated_at',s.scored_at,'checkedAt',now(),'clock_basis','narrative_calculation','source_observed_at',null,'coverage','Calculation time is known; underlying sources have mixed observation times. No single source freshness is asserted.','metric_agreement',agreement,'method',behavior,'momentum_delta',delta,'momentum_score',s.momentum_score,'risk_score',s.risk_score,'stage_changed_at',s.stage_changed_at);
 outcome:=CASE WHEN reason IS NOT NULL THEN 'candidate' WHEN delta IS NULL OR (coalesce((r.config->>'risk_spike')::boolean,true) AND s.risk_score IS NULL) THEN 'evidence_unavailable' ELSE 'evaluated_no_match' END;
 IF reason IS NOT NULL THEN
  source_ref:=s.narrative_id::text||':'||s.scored_at::text;
  outcome:=intel_emit_bridged_alert(r.id,r.org_id,r.chart_revision,'narrative','narrative_state',source_ref,'narrative_condition',NULL,jsonb_build_object('checkpoint',checkpoint,'slug',r.config->>'slug','name',title,'reason',reason,'metric_agreement',agreement->>'metric_agreement','lifecycle_stage',s.lifecycle_stage,'prev_stage',s.prev_stage,'signal_class',s.signal_class,'momentum',s.momentum_score,'risk',s.risk_score,'calculated_at',s.scored_at));
  SELECT id INTO event_id FROM intel_alert_events WHERE rule_id=r.id AND dedup_key='narrative_state:'||source_ref||':revision:'||r.chart_revision;
 END IF;
 -- Both arms commit their new state together, under the same lock that read it.
 UPDATE intel_alert_rules SET chart_state=jsonb_build_object('revision',p_revision,'sample',jsonb_build_object('momentum',momentum_step->'next','risk',risk_step->'next')) WHERE id=r.id;
 PERFORM intel_record_alert_evaluation(r.id,r.org_id,r.chart_revision,checkpoint||jsonb_build_object('status',outcome,'reason',CASE WHEN outcome='evidence_unavailable' THEN 'A required narrative score is missing; a successful no-match cannot be established.' ELSE reason END));
 RETURN jsonb_build_object('state',outcome,'eventId',event_id,'reason',reason,'snapshot',jsonb_build_object('narrative_id',s.narrative_id,'name',title,'lifecycle_stage',s.lifecycle_stage,'scored_at',s.scored_at));
END $narrative$;
REVOKE ALL ON FUNCTION public.intel_record_narrative_alert(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_narrative_alert(uuid,uuid,integer) TO service_role;

-- SECTION: narrative feed keeps one category from filling the board
-- The reviewed 219 body, unchanged, wrapped so the ranking is interleaved by
-- parent category. The cap is an ORDER BY over a clamped row_number and NOT a
-- WHERE: the first three narratives of each category sort first, everything else
-- follows in its original rank order, and the existing LIMIT then returns the
-- same number of rows it always did. A feed containing exactly one category is
-- therefore the same length it was before this change.
-- Schema qualified on purpose. An unqualified DROP ... IF EXISTS is a SILENT
-- NO-OP under any search_path that does not resolve this name to the public
-- copy, after which the CREATE OR REPLACE below plants a SECOND definition
-- wherever that search_path does point - leaving the real public.narrative_feed
-- untouched, the two copies diverging, and no error raised anywhere.
DROP FUNCTION IF EXISTS public.narrative_feed(uuid, int);
CREATE OR REPLACE FUNCTION public.narrative_feed(p_org_id uuid, p_limit int DEFAULT 80)
RETURNS TABLE (
  slug text, name text, parent_category text, origin text, status text, chains text[],
  momentum_score numeric, chatter_score numeric, price_confirmation_score numeric,
  volume_confirmation_score numeric, breadth_score numeric, freshness_score numeric,
  crowding_score numeric, risk_score numeric, confidence_score numeric,
  global_priority_score numeric, signal_class text, lifecycle_stage text, prev_stage text,
  onchain_status text, onchain_summary jsonb, leaders jsonb, laggards jsonb,
  related_chains text[], related_assets jsonb, source_drivers jsonb, score_delta jsonb,
  brief_artifact_ref text, last_brief_at timestamptz, scored_at timestamptz,
  is_followed boolean, from_user_source boolean, relevance_score numeric, final_rank numeric,
  clarity_labels jsonb, relevance_labels text[]
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (p_org_id = get_my_org_id() OR is_super_admin()) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  WITH user_syms AS (
    SELECT DISTINCT upper(coalesce(e.display_symbol, e.native_symbol)) AS sym
    FROM watchlist_items wi JOIN entities e ON e.id = wi.entity_id
    WHERE wi.org_id = p_org_id AND e.entity_kind = 'asset'
      AND coalesce(e.display_symbol, e.native_symbol) IS NOT NULL
  ),
  user_chains AS (
    SELECT COALESCE(array_agg(DISTINCT c), '{}') AS chains FROM (
      SELECT unnest(chains_of_interest) AS c FROM intel_user_profiles WHERE org_id = p_org_id
    ) z
  ),
  port_syms AS (   -- the CALLER's holdings (normalized symbols), never another user's
    SELECT COALESCE(array_agg(DISTINCT upper(h.normalized_symbol)) FILTER (WHERE h.normalized_symbol IS NOT NULL), '{}') AS syms
    FROM investor_portfolios p JOIN investor_portfolio_holdings h ON h.portfolio_id = p.id
    WHERE p.org_id = p_org_id AND p.user_id = auth.uid()
  ),
  watch_overlap AS (
    SELECT na.narrative_id, count(DISTINCT na.normalized_symbol) AS n
    FROM narrative_assets na
    WHERE na.normalized_symbol IN (SELECT sym FROM user_syms)
    GROUP BY na.narrative_id
  ),
  port_overlap AS (
    SELECT na.narrative_id, count(DISTINCT na.normalized_symbol) AS n
    FROM narrative_assets na CROSS JOIN port_syms ps
    WHERE array_length(ps.syms, 1) IS NOT NULL AND na.normalized_symbol = ANY(ps.syms)
    GROUP BY na.narrative_id
  ),
  src_tier AS (
    SELECT nsd.narrative_id,
           max(CASE ss.priority_level WHEN 'private' THEN 4 WHEN 'public_user' THEN 3
                    WHEN 'followed' THEN 2 WHEN 'saved' THEN 1 ELSE 0 END) AS tier
    FROM narrative_source_drivers nsd
    JOIN signals sg ON sg.cluster_id = nsd.cluster_id
    JOIN signal_item_sources si ON si.raw_item_id = sg.raw_item_id
    JOIN source_subscriptions ss ON ss.source_id = si.source_id AND ss.workspace_id = p_org_id
    GROUP BY nsd.narrative_id
  ),
  followed AS (
    SELECT narrative_id FROM user_followed_narratives WHERE user_id = auth.uid()
  ),
  interacted AS (
    SELECT narrative_id, count(*) AS n FROM narrative_interactions
    WHERE user_id = auth.uid() AND created_at > now() - interval '14 days'
    GROUP BY narrative_id
  ),
  feed AS (
    SELECT t.slug, t.name, t.parent_category, t.origin, t.status, t.chains,
           s.momentum_score, s.chatter_score, s.price_confirmation_score, s.volume_confirmation_score,
           s.breadth_score, s.freshness_score, s.crowding_score, s.risk_score, s.confidence_score,
           s.global_priority_score, s.signal_class, s.lifecycle_stage, s.prev_stage,
           s.onchain_status, s.onchain_summary, s.leaders, s.laggards, s.related_chains,
           s.related_assets, s.source_drivers, s.score_delta, s.brief_artifact_ref, s.last_brief_at, s.scored_at,
           (f.narrative_id IS NOT NULL) AS is_followed,
           (COALESCE(st.tier, 0) > 0) AS from_user_source,
           ( CASE WHEN f.narrative_id IS NOT NULL THEN 4000 ELSE 0 END
             + LEAST(COALESCE(wo.n, 0), 5) * 300
             + COALESCE(st.tier, 0) * 600
             + LEAST(COALESCE(ix.n, 0), 5) * 40 )::numeric AS relevance_score,
           ( COALESCE(s.global_priority_score, 0)
             + (CASE WHEN f.narrative_id IS NOT NULL THEN 4000 ELSE 0 END
                + LEAST(COALESCE(wo.n, 0), 5) * 300
                + COALESCE(st.tier, 0) * 600
                + LEAST(COALESCE(ix.n, 0), 5) * 40)
             - COALESCE(s.risk_score, 0) * 0.15 )::numeric AS final_rank,
           COALESCE(s.clarity_labels, '[]'::jsonb) AS clarity_labels,
           array_remove(ARRAY[
             CASE WHEN COALESCE(po.n, 0) > 0 THEN 'portfolio_relevant' END,
             CASE WHEN COALESCE(wo.n, 0) > 0 THEN 'watchlist_relevant' END,
             CASE WHEN s.related_chains && (SELECT uc.chains FROM user_chains uc) THEN 'chain_relevant' END
           ], NULL) AS relevance_labels
    FROM narrative_taxonomy t
    LEFT JOIN narrative_state s ON s.narrative_id = t.id
    LEFT JOIN watch_overlap wo ON wo.narrative_id = t.id
    LEFT JOIN port_overlap po ON po.narrative_id = t.id
    LEFT JOIN src_tier st ON st.narrative_id = t.id
    LEFT JOIN followed f ON f.narrative_id = t.id
    LEFT JOIN interacted ix ON ix.narrative_id = t.id
    WHERE t.status IN ('active','surfaced')
  ),
  -- A narrative with no parent category is its OWN entity, never a member of one
  -- shared "uncategorised" bucket that would bury all of them together.
  capped AS (
    SELECT q.*, LEAST(row_number() OVER (
      PARTITION BY COALESCE(q.parent_category, q.slug)
      ORDER BY q.final_rank DESC NULLS LAST, q.global_priority_score DESC NULLS LAST, q.name), 4) AS category_slot
    FROM feed q
  )
  SELECT c.slug, c.name, c.parent_category, c.origin, c.status, c.chains,
         c.momentum_score, c.chatter_score, c.price_confirmation_score, c.volume_confirmation_score,
         c.breadth_score, c.freshness_score, c.crowding_score, c.risk_score, c.confidence_score,
         c.global_priority_score, c.signal_class, c.lifecycle_stage, c.prev_stage,
         c.onchain_status, c.onchain_summary, c.leaders, c.laggards, c.related_chains,
         c.related_assets, c.source_drivers, c.score_delta, c.brief_artifact_ref, c.last_brief_at, c.scored_at,
         c.is_followed, c.from_user_source, c.relevance_score, c.final_rank,
         c.clarity_labels, c.relevance_labels
  FROM capped c
  ORDER BY c.category_slot, c.final_rank DESC NULLS LAST, c.global_priority_score DESC NULLS LAST, c.name
  LIMIT GREATEST(1, LEAST(p_limit, 200));
END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.narrative_feed(uuid,int) FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.narrative_feed(uuid,int) TO authenticated, service_role';
END $$;

-- SECTION: the signal feed keeps one token from filling the board
-- The reviewed 233 body, unchanged, wrapped with the same interleave. A cluster
-- carrying no token is its own entity (keyed by its id), so untagged clusters
-- are never buried together as if they were one subject.
-- Schema qualified for the same reason as narrative_feed above: an unqualified
-- CREATE OR REPLACE resolves through search_path and can plant a second copy.
CREATE OR REPLACE FUNCTION public.signal_feed(
  p_workspace_id uuid, p_chains text[] DEFAULT NULL, p_followed_only boolean DEFAULT false, p_limit int DEFAULT 40
) RETURNS TABLE (
  cluster_id uuid, main_title text, cluster_summary text, item_count int, momentum_score numeric,
  chains text[], tokens text[], sectors text[], narratives text[], top_sources text[], last_seen_at timestamptz,
  from_user_source boolean, precedence_tier text, relevance_score numeric, saved boolean, hidden boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (p_workspace_id = get_my_org_id() OR is_super_admin()) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  WITH ws_sub AS (
    SELECT ss.source_id, ss.priority_level FROM source_subscriptions ss WHERE ss.workspace_id = p_workspace_id
  ),
  ws_interest AS (
    SELECT COALESCE(array_agg(DISTINCT ch), '{}') AS chains
    FROM (SELECT unnest(s.chains) ch FROM signal_sources s JOIN ws_sub u ON u.source_id = s.id) z
  ),
  cl AS (
    SELECT c.id, c.main_title, c.cluster_summary, c.item_count, c.momentum_score,
           c.chains, c.tokens, c.sectors, c.narratives, c.top_sources, c.last_seen_at,
           (SELECT max(CASE u.priority_level WHEN 'private' THEN 4 WHEN 'public_user' THEN 3 WHEN 'followed' THEN 2 WHEN 'saved' THEN 1 ELSE 0 END)
              FROM signals sg JOIN signal_item_sources si ON si.raw_item_id = sg.raw_item_id JOIN ws_sub u ON u.source_id = si.source_id
              WHERE sg.cluster_id = c.id) AS sub_tier
    FROM signal_clusters c
    WHERE c.item_count > 0
      -- Title-sanity floor: must read like a headline, never a bare number / URL.
      AND c.main_title ~ '[A-Za-z]'
      AND char_length(btrim(c.main_title)) >= 12
      AND c.main_title !~* '^https?://'
      AND (p_chains IS NULL OR array_length(p_chains, 1) IS NULL OR c.chains && p_chains)
  ),
  feed AS (
    SELECT cl.id AS cluster_id, cl.main_title, cl.cluster_summary, cl.item_count, cl.momentum_score,
           cl.chains, cl.tokens, cl.sectors, cl.narratives, cl.top_sources, cl.last_seen_at,
           (COALESCE(cl.sub_tier, 0) > 0) AS from_user_source,
           (CASE cl.sub_tier WHEN 4 THEN 'private' WHEN 3 THEN 'public_user' WHEN 2 THEN 'followed' WHEN 1 THEN 'saved' ELSE 'global' END) AS precedence_tier,
           (COALESCE(cl.momentum_score, 0)
            + (CASE WHEN cl.chains && (SELECT wi.chains FROM ws_interest wi) THEN 50 ELSE 0 END)
            + (CASE WHEN COALESCE(array_length(cl.top_sources, 1), 0) >= 2 THEN 25 ELSE 0 END)
            + (COALESCE(cl.sub_tier, 0) * 1000))::numeric AS relevance_score,
           COALESCE(r.saved, false) AS saved, COALESCE(r.hidden, false) AS hidden
    FROM cl
    LEFT JOIN signal_relevance r ON r.cluster_id = cl.id AND r.workspace_id = p_workspace_id
    WHERE COALESCE(r.hidden, false) = false
      AND (NOT p_followed_only OR COALESCE(cl.sub_tier, 0) > 0)
  ),
  capped AS (
    SELECT q.*, LEAST(row_number() OVER (
      PARTITION BY COALESCE(q.tokens[1], q.cluster_id::text)
      ORDER BY q.relevance_score DESC, q.last_seen_at DESC NULLS LAST), 3) AS token_slot
    FROM feed q
  )
  SELECT c.cluster_id, c.main_title, c.cluster_summary, c.item_count, c.momentum_score,
         c.chains, c.tokens, c.sectors, c.narratives, c.top_sources, c.last_seen_at,
         c.from_user_source, c.precedence_tier, c.relevance_score, c.saved, c.hidden
  FROM capped c
  ORDER BY c.token_slot, c.relevance_score DESC, c.last_seen_at DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(p_limit, 100));
END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.signal_feed(uuid,text[],boolean,int) FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.signal_feed(uuid,text[],boolean,int) TO authenticated, service_role';
END $$;

-- SECTION: the markets gainers and losers boards keep one chain from filling them
-- Patched against the LIVE definition, so the drawdown work in 20260915014302
-- and everything after it is preserved and the edit is refused if the reviewed
-- text moved. Same shape as the category board this file already had: an ORDER
-- BY over a clamped row_number, the LIMIT 10 unchanged, and the helper column
-- stripped from the payload so the wire shape is byte-for-byte what it was.
DO $markets$ DECLARE original text;changed text;BEGIN
 original:=pg_get_functiondef('public.intel_markets_screen_for_user(uuid,uuid,jsonb)'::regprocedure);
 changed:=replace(original,
  '''topGainers'',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM(SELECT * FROM base WHERE change_24h_pct>0 ORDER BY mover_score DESC,source_provider,provider_id LIMIT 10)g),''[]''),',
  '''topGainers'',COALESCE((SELECT jsonb_agg(to_jsonb(g)-''chain_slot'') FROM(SELECT *,LEAST(row_number() OVER(PARTITION BY COALESCE(public.intel_market_chain(primary_chain),source_provider||'':''||provider_id) ORDER BY mover_score DESC,source_provider,provider_id),4) AS chain_slot FROM base WHERE change_24h_pct>0 ORDER BY chain_slot,mover_score DESC,source_provider,provider_id LIMIT 10)g),''[]''),');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_markets_gainers_definition';END IF;
 original:=changed;
 changed:=replace(original,
  '''topLosers'',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM(SELECT * FROM base WHERE change_24h_pct<0 ORDER BY mover_score DESC,source_provider,provider_id LIMIT 10)g),''[]''),',
  '''topLosers'',COALESCE((SELECT jsonb_agg(to_jsonb(g)-''chain_slot'') FROM(SELECT *,LEAST(row_number() OVER(PARTITION BY COALESCE(public.intel_market_chain(primary_chain),source_provider||'':''||provider_id) ORDER BY mover_score DESC,source_provider,provider_id),4) AS chain_slot FROM base WHERE change_24h_pct<0 ORDER BY chain_slot,mover_score DESC,source_provider,provider_id LIMIT 10)g),''[]''),');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_markets_losers_definition';END IF;
 EXECUTE changed;
END $markets$;
REVOKE ALL ON FUNCTION public.intel_markets_screen_for_user(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_markets_screen_for_user(uuid,uuid,jsonb) TO service_role;
