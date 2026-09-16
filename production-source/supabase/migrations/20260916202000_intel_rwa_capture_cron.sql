-- ============================================================
-- Investor Intel: pg_cron schedules for the three RWA capture lanes
-- ============================================================
-- Schedules the `intel-capture` Edge Function ops that fill the RWA provenance and legitimacy tables:
--
--   job                                           schedule (UTC)          op                        tables filled
--   intel-capture-rwa-yield-6h                    '29 1,7,13,19 * * *'    rwa_yield                 intel_rwa_nav_observations,
--                                                                                                    intel_rwa_yield_snapshots,
--                                                                                                    intel_benchmark_rates
--   intel-capture-rwa-issuer-registry-daily       '19 2 * * *'            rwa_issuer_registry       intel_rwa_issuer_entities,
--                                                                                                    intel_rwa_issuer_admission_filings,
--                                                                                                    intel_rwa_issuer_admission_drift,
--                                                                                                    intel_rwa_issuer_risk_signals
--   intel-capture-rwa-token-concentration-daily   '53 2 * * *'            rwa_token_concentration   intel_rwa_token_concentration,
--                                                                                                    intel_rwa_token_restrictions
--
-- CORRECTION OF TWO EARLIER MIGRATION COMMENTS. Both were wrong when written, and until this migration nothing
-- scheduled these ops: on 2026-09-16 production `cron.job` held no job for rwa_yield, rwa_issuer_registry or
-- rwa_token_concentration, and every table listed above had 0 rows.
--   * 20260916120000_intel_rwa_yield_provenance.sql, lines 59-60, says "There is nothing to schedule: the lane runs
--     from the existing capture op". The op is only registered in intel-capture/index.ts; the existing
--     `intel-capture-hourly` job posts {"op":"all_hourly"}, whose sequence is regime, index, rwa (the CoinMarketCap
--     RWA universe) and attention. It never ran rwa_yield.
--   * 20260916150000_intel_rwa_issuer_legitimacy.sql, line 76, says "Capture is on demand from the RWA workspace".
--     No surface calls a capture op: capture ops require the cron secret or a super admin (intel-capture/index.ts),
--     and the RWA workspace only reads the `rwa_issuer_legitimacy` view.
-- What now schedules the lanes is this file. The two earlier files are not edited, because they have been applied.
--
-- WHY THESE CADENCES. Every source is free and keyless, so the limit that matters is each source's published terms and
-- rate policy, and the capture request ceiling (net.http_post timeout 110 s against a 100 s function budget):
--   * rwa_yield, every 6 hours. One run is at most 33 calls (rwa-yield-register.ts): one read of the Chainlink
--     reference-data directory, two batched eth_call requests per registered NAV feed against a public Ethereum RPC,
--     one read per benchmark (US Treasury, New York Fed, ECB) and two SEC EDGAR reads for the one advertised-only fund.
--     NAV feeds publish on a heartbeat of about a day, benchmarks once a business day and N-MFP3 filings monthly, so
--     hourly would re-read unchanged rounds 24 times a day, while four reads a day still date a stale feed within six
--     hours. Rows are keyed on the capture hour, so a retried tick lands on the same keys.
--   * rwa_issuer_registry, daily at 02:19 UTC (22:19 US Eastern in September, outside EDGAR's busy hours). Per run:
--     one OFAC SDN download (about 5.7 MB), one GLEIF record per mapped LEI, and per mapped CIK one EDGAR submissions
--     read plus at most 8 Form D documents (FILINGS_PER_SUBJECT), for at most 10 subjects (SUBJECTS_PER_RUN). The
--     transport spaces EDGAR calls at least 150 ms apart, under the SEC fair access ceiling of 10 requests per second,
--     and sends the descriptive User-Agent the SEC requires; see REQUIRED SETTING below. Form D filings and LEI records
--     change on the scale of months, so once a day is ample.
--   * rwa_token_concentration, daily at 02:53 UTC. Per mapped token: a Blockscout token summary, one page of holders,
--     one address read for the proxy implementation (400 ms apart, well inside the observed 180-request limit) and one
--     Sourcify ABI read. The concentration table is keyed on the capture hour, so daily gives one row per token per day.
--   Minutes 19, 29 and 53 are named by no other job's schedule (checked against cron.job on 2026-09-16; only the
--   every-minute jobs share them), so none of these starts on the same minute as another intel-capture run. The two
--   daily jobs start 34 minutes apart so their external reads do not overlap, and both run between the 01:35 category
--   members job and the 04:50 exchange reserves job.
--
-- WHICH SUBJECTS. The issuer lanes act only on alias assertions IN FORCE at the run's clock
-- (`currentAssertions` in _shared/intel/rwa-issuer-aliases.ts). When an assertion expires its subject stops being
-- refreshed and the read view withholds its legal facts; captured rows are kept. After rwa-issuer-alias-1 expires
-- (2026-09-23 14:30 UTC) and rwa-issuer-alias-2 (2026-09-23 20:47 UTC), both issuer jobs run and report
-- `no_mapped_subjects` / `no_mapped_tokens` until a later version restates a mapping. That is correct, not a fault.
--
-- REQUIRED SETTING: SEC_EDGAR_USER_AGENT. Both EDGAR readers resolve one agent (_shared/intel/rwa-sources/edgar-agent.ts):
-- the Edge Function environment variable first, then `config.SEC_EDGAR_USER_AGENT` on the provider_quota_budgets row
-- with provider 'coinmarketcap', data_type 'cmc_operating_profile' and period_start 1970-01-01. With neither set, the
-- registry lane still writes the asserted entity rows, GLEIF and OFAC signals, but reads no Form D and reports
-- `edgar:user_agent_required`, and the yield lane stores the advertised side as `user_agent_required`. No EDGAR request
-- is ever sent without it. This migration does not set it.
--
-- AUTHENTICATION is copied exactly from 20260915010343_intel_capture_cron.sql and the live intel-capture jobs: the URL,
-- the service-role bearer and the operational x-cron-secret are read from Vault at run time. No secret is in this file.
--
-- Idempotent: each job is unscheduled by name when present, then scheduled. Safe to apply more than once.
-- Validated offline with pglast.
--
-- Disable a lane without touching cron (the job then returns skipped: 'policy_disabled'):
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'chainlink' AND feature = 'rwa_yield';
--   UPDATE public.provider_schedule_policy SET enabled = false
--     WHERE provider = 'primary-sources' AND feature IN ('rwa_issuer_registry','rwa_token_concentration');
--
-- Rollback (stop the schedules, keep the data):
--   SELECT cron.unschedule('intel-capture-rwa-yield-6h');
--   SELECT cron.unschedule('intel-capture-rwa-issuer-registry-daily');
--   SELECT cron.unschedule('intel-capture-rwa-token-concentration-daily');
-- ============================================================

-- ── NAV, realized yield, benchmark and advertised yield, every six hours ──
SELECT cron.unschedule('intel-capture-rwa-yield-6h') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-yield-6h');
SELECT cron.schedule('intel-capture-rwa-yield-6h', '29 1,7,13,19 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_yield'), timeout_milliseconds := 110000);
$$);

-- ── Issuer registry, admission filings, drift and risk signals, once a day ──
SELECT cron.unschedule('intel-capture-rwa-issuer-registry-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-issuer-registry-daily');
SELECT cron.schedule('intel-capture-rwa-issuer-registry-daily', '19 2 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_issuer_registry'), timeout_milliseconds := 110000);
$$);

-- ── Holder concentration and contract transfer restrictions, once a day ──
SELECT cron.unschedule('intel-capture-rwa-token-concentration-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-token-concentration-daily');
SELECT cron.schedule('intel-capture-rwa-token-concentration-daily', '53 2 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_token_concentration'), timeout_milliseconds := 110000);
$$);
