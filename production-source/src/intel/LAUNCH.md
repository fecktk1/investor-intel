# Investor Intel — Launch Readiness

Retail crypto intelligence mode. Built on branch `feat/investor-intel`. Additive
and gated — existing content product is unaffected (every existing org stays
`product_mode = 'content'`).

## Apply in order

### 1. Database migrations (Supabase)
Run in order; each is additive and re-runnable:
- `132_investor_intel_foundation.sql` — `orgs.product_mode`, `trial_ends_at`, `pending_signups.product_mode`
- `133_investor_intel_entities_artifacts.sql` — `entities`, `research_artifacts`, `chain_capabilities`, `intel_ai_events`
- `134_investor_intel_trial_onboarding.sql` — `intel_user_profiles`, `notification_preferences`, `intel_trial_guards`, `start_intel_trial()`, `complete_intel_onboarding()`
- `135_investor_intel_watchlist.sql` — `watchlists`, `watchlist_items`, `tracked_narratives` (+ snapshots)
- `136_investor_intel_briefs_alerts_theses.sql` — `intel_briefs`, `intel_alert_rules`, `intel_alert_events`, `saved_research`, `intel_theses`, `intel_thesis_links`
- `137_investor_intel_limits_admin.sql` — `intel_plan_limits`, `intel_limit()`, `intel_admin_overview()`
- `138_investor_intel_admin_controls.sql` — `intel_global_config` (kill switch + default cap/trial), grant/revoke/trial/tier/cost-cap RPCs, `intel_generation_allowed()`, trial-abuse + expanded overview RPCs
- `139_investor_intel_news_and_limits.sql` — `tracked_sources`, `news_items`; per-tier limit ENFORCEMENT (triggers on watchlist/wallets/alerts/sources + `intel_rate_check`), `intel_usage_summary`, `intel_admin_set_limit`
- `140_investor_intel_cron.sql` — pg_cron schedule for `intel-alerts-eval` (every 15 min)
- `141_investor_intel_trial_bonus.sql` — `intel_add_payment_method_bonus()` (7→14-day trial on card add)
- `142_investor_intel_coverage_cron.sql` — weekly `intel-provider-coverage` schedule
- `143_investor_intel_global_sources.sql` — `intel_global_sources` + `intel_global_news` (shared curated corpus) + super-admin source RPCs
- `144_investor_intel_global_news_cron.sql` — 2-hourly global crawl schedule
- `145_investor_intel_chain_news_cron.sql` — 6-hourly per-chain Gemini news schedule
- `146_investor_intel_defi_snapshot_cron.sql` — daily (05:10 UTC) DeFi vault TVL/APY snapshot into `kamino_vault_snapshots` (history for the DeFi chart)
- `147_investor_intel_crossorg_defi_macro.sql` — `intel_global_news.origin` column; DeFi MIRROR RPCs `intel_defi_universe()` / `intel_defi_vault_history()` (SECURITY DEFINER, cross-org public Kamino data); macro store `intel_macro_calendar` + `intel_macro_indicators` (GLOBAL); `intel_macro_news()` RPC (aggregates `rss_items.retain_forever` cross-org + curated macro corpus, deduped)
- `148_investor_intel_harvest_macro_cron.sql` — schedules `intel-org-news-harvest` (every 3h :15) + `intel-macro-cron` (daily 06:00 UTC)

> Per repo convention, validate each in the SQL editor as a single `DO`/statement run; temp state doesn't survive across editor sessions.

### 2. Edge functions to deploy
- `intel-resolve` — canonical entity resolution
- `intel-generate` — all AI artifacts (breakdown/risk/explain/compare/narrative/wallet/defi/execution/brief/alert-why)
- `intel-comment` — Comment King (copy-only)
- `intel-news-fetch` — news/source ingestion (Grok x_search + web_search); needs `XAI_API_KEY` (or `GROK_API_KEY`)
- `intel-alerts-eval` — pg_cron alert evaluation (service-role; validates `x-cron-secret`); needs `BIRDEYE_API_KEY` + `CRON_SECRET`. Deploy with `--no-verify-jwt` (cron-invoked).
- `intel-provider-coverage` — provider-coverage report → `chain_capabilities` (cron `x-cron-secret` OR super-admin JWT); needs `BIRDEYE_API_KEY` + `CRON_SECRET`.
- `intel-dashboard` — home dashboard digest (live Birdeye movers + news + trends + alerts + latest brief + recent research); needs `BIRDEYE_API_KEY`. Powers the Market Pulse home screen.
- `intel-global-news-cron` — crawls the curated global sources into the shared `intel_global_news` corpus (cron `x-cron-secret` OR super-admin JWT). Uses `_shared/source-crawl.ts` (RSS + X via X dev API + Grok). Needs `XAI_API_KEY`/`GROK_API_KEY`, **`X_BEARER_TOKEN`** (X dev API), `OPENAI_API_KEY` (classification), `CRON_SECRET`.
- `intel-chain-news-cron` — per-chain **Gemini + Google-Search grounding** discovery → shared corpus (zero user setup; cron OR super-admin JWT). Needs **`GEMINI_API_KEY`** + `OPENAI_API_KEY` + `CRON_SECRET`.
- `intel-token-chart` — OHLCV candles + live snapshot (Birdeye) for the token intelligence page. Needs `BIRDEYE_API_KEY`.
- `intel-wallet` — Birdeye wallet portfolio (total USD + top holdings) for the Wallet Watch holdings chart. Needs `BIRDEYE_API_KEY`.
- `intel-defi-metrics` — current Kamino TVL/APY for a vault entity + accumulated TVL/APY history from `kamino_vault_snapshots`. Powers the DeFi page chart.
- `intel-defi-snapshot` — **cron** (service-role; validates `x-cron-secret`). Snapshots Kamino TVL/APY for every DeFi vault watched by an intel workspace so history accumulates. Needs `CRON_SECRET`. Deploy with `--no-verify-jwt` (cron-invoked).
- `intel-org-news-harvest` — **cron** (service-role OR super-admin JWT). Sweeps the org/content side's `rss_items` (already crawled every 5 min) across ALL orgs for chain-relevant + macro news, dedups, runs a bounded Google-grounded fact-check, and merges into the shared `intel_global_news` corpus (`origin='org_rss'`). Reuses data orgs already pull → retail users don't re-hit source APIs. Needs `OPENAI_API_KEY` (classify) + `GEMINI_API_KEY` (verify) + `CRON_SECRET`. Deploy with `--no-verify-jwt`.
- `intel-macro-cron` — **cron** (service-role OR super-admin JWT). One shared Gemini-grounded fetch → global `intel_macro_calendar` (upcoming FOMC/CPI/PPI/PCE/NFP/GDP) + `intel_macro_indicators` (Fed rate, CPI, unemployment, 10Y, DXY, BTC dominance, Fear&Greed). Shared-once (not per-user). Needs `GEMINI_API_KEY` + `CRON_SECRET`. Deploy with `--no-verify-jwt`.

> **Cross-org news + DeFi mirror + Macro batch:** apply migrations `147`, `148`. New edge fns: `intel-org-news-harvest`, `intel-macro-cron` (both `--no-verify-jwt`). **Redeploy `intel-defi-metrics`** (history now reads the cross-org `intel_defi_vault_history` RPC so it's populated for new users). Frontend: new `MacroPage` (`/intel/macro`, nav under Pulse) with a "Why is this important?" button on every item (runs Explain), `WhyImportant` component, `DefiPage` now shows the mirrored top-vault universe from the jump (`intel_defi_universe`), `macro-api.js`, `chart-api.loadDefiUniverse`, admin "Harvest org news" + "Refresh macro" buttons. No new env vars (reuses `GEMINI_API_KEY`/`OPENAI_API_KEY`/`CRON_SECRET`). Macro tiles/calendar populate after the first `intel-macro-cron` run; org news appears in the shared corpus after the first harvest.

> **This batch (token intelligence parity + charts):** new deploys `intel-token-chart`, `intel-wallet`, `intel-defi-metrics`, `intel-defi-snapshot`. New migration `146` (DeFi snapshot cron). Frontend-only: `AssetBreakdownPage` (token chart + news; wallet holdings chart + total value), `ComparePage` (two-token compare-on-chart overlay), new `DefiPage` (TVL/APY tiles + history chart + report + news), components `TokenChart`/`MultiTokenChart`/`WalletHoldingsChart`/`DefiHistoryChart`. History on the DeFi chart begins accumulating only once `146`'s daily cron has run (current TVL/APY shows immediately).

> `intel-dashboard` is now **scope-aware** (Everything / By chain / Following + per-chain projects) — **redeploy it**. No new migrations for the dashboard (existing tables + Birdeye).

> `intel-news-fetch` rewritten to crawl user sources (RSS + X dev API + Grok) + token discovery — **redeploy it**. `intel-dashboard` now merges the shared corpus — **redeploy it**. Set **`X_BEARER_TOKEN`** (X dev API bearer) so X accounts crawl via both APIs; without it X falls back to Grok-only. Super-admins curate sources in the console → "Run global crawl now".

> `intel-generate` changed again (live provider data via `_shared/intel-providers.ts` + `thesis_review`) — **redeploy it**. New deploys: `intel-provider-coverage`. Run the coverage report once (super-admin console → "Run coverage report") so chain capabilities flip from `unverified`.

> **After migrations 138–139, REDEPLOY `intel-generate` and `intel-comment`** — they now enforce the kill switch + monthly cost cap (`intel_generation_allowed`), per-tier daily-rate limits (`intel_rate_check`), and record per-workspace AI cost (`recordAIUsage`). `intel-generate` also grounds breakdown/risk/execution in **live Birdeye** data. `intel-resolve` is unchanged. New deploys: `intel-news-fetch`, `intel-alerts-eval`.

Shared libs they import: `_shared/chains.ts`, `entity-resolver.ts`, `intel-prompts.ts`, `intel-guardrails.ts`, `intel-events.ts`.

### 3. Environment
- `OPENAI_API_KEY` (artifact + comment generation) — already used elsewhere; confirm present for these functions
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` (functions create a user-scoped client)
- (Per-env key separation: keep Railway-worker vs Supabase-edge keys distinct.)

## Gating / feature flag
- Access gate: `RequireIntelMode` → active workspace `product_mode === 'intel'`.
- Entry for a logged-in user: `/intel/start` → `start_intel_trial()` (7-day trial; one-trial-per-identity) → `switchOrg` → onboarding → `/intel`.
- **Default off**: there is NO entry point in the content sidebar. To open the funnel, expose a "Switch to Investor Intel" affordance / link to `/intel/start` (and/or a marketing page). Until then the mode is reachable only by direct URL — safe for a pilot.
- Pilot: flip a canary workspace via `update orgs set product_mode='intel', trial_ends_at=now()+interval '7 days' where slug='<test>'` and validate before widening. No customer slug is hardcoded anywhere.

## QA checklist
- [ ] Migrations apply cleanly on a branch DB; RLS isolates two single-member workspaces.
- [ ] `start_intel_trial` creates org + owner membership + profile + guard; second call for same identity raises `trial_already_used`.
- [ ] Trial `paymentStatus = 'trial'` (full access) pre-expiry; `'expired'` (paywall) post-expiry.
- [ ] Onboarding writes `intel_user_profiles` + flips `onboarding_completed`; Beginner Protection auto-on for `experience='new'`.
- [ ] Entity resolver: token/wallet/narrative across each launch chain (incl. BTC/ZEC native, XRPL issuer.currency).
- [ ] `intel-generate` returns an artifact with confidence/sources/freshness; advice-y prompts get rewritten or blocked (`validation_status`).
- [ ] No banned action buttons render (`IntelActionButton` allowlist).
- [ ] Watchlist add/remove; Breakdown/Risk/Explain/Compare/Narrative/DeFi/Execution/Brief/Alerts/Thesis/Comment King pages load and generate.
- [ ] Capability badges show unsupported/unverified states; a missing signal never reads as positive.
- [ ] Super-admin `/super-admin/intel` overview renders.
- [ ] Deno: `deno test supabase/functions/_shared/intel-guardrails.test.ts entity-resolver.test.ts` passes.

## Rollback
Disable the entry affordance and/or `update orgs set product_mode='content'` for pilot workspaces. All tables are additive; no existing data is altered.

## Post-launch (built as scaffolds; finish before scaling)
- **Provider-coverage report (P0 task):** verify Birdeye/QuickNode/DFlow/Kamino/Grok per chain×capability and populate `chain_capabilities`. Until then capabilities are `unverified` (treated as unavailable). **Do not mark any capability `live` before this runs.**
- **Deep data wiring:** `intel-generate` currently reasons over passed-in context; wire Birdeye market data, QuickNode multichain wallet data, Kamino, and DFlow per artifact type for richer, snapshot-backed evidence.
- **Scheduled briefs (P9):** pg_cron → `generation_jobs` → Railway worker `intel_brief` (reuse newsletter pipeline). Currently on-demand only.
- **Alert evaluation (P10):** cron threshold sweep + `intel-generate` alert_explanation; on-chain triggers wrap `onchain_alert_rules`.
- **Narrative discovery (P5):** Grok X/web search worker job to auto-populate `tracked_narratives` + snapshots.
- **Thesis drift (PL5):** worker comparing current metrics vs `intel_theses.baseline_*`.
- **14-day trial** when a payment method is added (`start_intel_trial` already accepts `p_trial_days`); paid conversion via `claim_pending_signup` passthrough.
- Email/Telegram brief delivery; read-only wallet connect + positions; public fixtures demo; EVM DeFi/execution depth.
- Limit enforcement: `intel_limit()` + `intel_plan_limits` exist; wire checks into add/generate actions and an upgrade surface.
