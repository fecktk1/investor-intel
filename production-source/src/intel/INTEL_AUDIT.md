# Investor Intel — Build Audit vs Plan

Status of every plan area. ✅ done · 🟡 partial · ❌ missing → being fixed this pass.

## Phases
| Phase | Status | Notes |
|---|---|---|
| P0 Foundation/tenancy/shell | ✅ | product_mode, /intel shell, gate, i18n, entities, research_artifacts, chains registry, guardrails, monitoring |
| P1 Trial/onboarding/profile | ✅ | start_intel_trial, onboarding wizard, intel_user_profiles, trial guards |
| P2 Watchlist | ✅ | watchlists/watchlist_items, entity resolver, page |
| P3 Market Pulse | ✅ | dashboard + AI summary |
| P4 Token Breakdown + Risk | 🟡→✅ | page + artifacts done; **was missing live Birdeye data → now wired** |
| P5 Narrative Radar | ✅ | tracked_narratives + page |
| P6 Wallet Watch | 🟡 | analyze by address ✅; live QuickNode multichain balances **still passed-context only** (deferred) |
| P7 DeFi | 🟡 | page ✅; live Kamino data deferred |
| P8 Execution | 🟡 | page ✅; live DFlow quote wiring deferred |
| P9 Daily Brief | 🟡→✅ | on-demand ✅; **scheduled cron now added** |
| P10 Alerts | 🟡→✅ | rules/events + page ✅; **evaluation cron + AI "why" now added** |
| P11 Explain | ✅ | |
| P12 Compare | ✅ | |
| P13 Thesis | ✅ | baselines captured on create |
| P14 Comment King | ✅ | copy-only |
| P15 Pricing/limits | 🟡→✅ | tiers + intel_limit ✅; **per-tier ENFORCEMENT now wired (triggers + rate checks)** |
| P16 Admin/cost | 🟡→✅ | controls + cost tracking ✅; **limit overrides + usage visibility added** |
| P17 Tests | 🟡 | guardrail + resolver tests; more added for limits |
| P18 Launch | ✅ | LAUNCH.md kept current |

## Cross-cutting plan items
- Confidence/evidence/sources/freshness contract ✅
- research_artifacts spine + caching ✅
- Entity identity (17 chains, no chain:address) ✅
- Non-advice guardrails (prompt + validator + no-action buttons + disclaimers) ✅
- Provider-coverage report ❌→✅ (`intel-provider-coverage` edge fn + chain_capabilities population + cron)
- Deep provider data in generation 🟡→✅ for Birdeye (token/risk); QuickNode/Kamino/DFlow live wiring still deferred per feature
- **News / source-following ❌→✅ (NEW this pass):** tracked_sources (X accounts/RSS/keywords) + news_items + Grok ingestion + feed + per-token news
- Per-tier limit enforcement ❌→✅
- Super-admin: grant/revoke/trial/tier/cost-cap/kill ✅; **+ per-workspace limit overrides, news oversight, usage** ✅

## Completed in the deferred-cleanup pass
- **Live data in generation** via `_shared/intel-providers.ts`: Birdeye token overview (breakdown/risk/execution/defi), Birdeye wallet portfolio (wallet_summary), DFlow execution quote (Solana), Kamino DeFi (best-effort). Sources merged into each artifact.
- **Provider-coverage report** — `intel-provider-coverage` writes `chain_capabilities` (super-admin "Run coverage report" + weekly cron 142); `loadChainCoverage` on the frontend; capabilities flip off `unverified`.
- **Thesis-drift** — on-demand `thesis_review` (live data vs saved thesis) on the Thesis page.
- **14-day trial** when a payment method is added — `intel_add_payment_method_bonus()` (migration 141).
- **Alert evaluation cron** (`intel-alerts-eval`, migration 140) + on-demand AI "why it matters".

## Still deferred (genuinely separate efforts; hooks in place)
- Auto **news/brief fan-out crons** — on-demand news + brief work today; auto-scheduling needs a service-role per-org generation pass.
- **Email/Telegram delivery** of briefs/alerts — reuse the newsletter email + Telegram bot infra (`notification_preferences.channels` is ready).
- **Public read-only Intel demo** (fixtures, mirroring `/demo`).
- **Read-only wallet connect + "your DeFi positions"** (web3 wallet adapter + portfolio UI; watch-by-address works now).
- **Full 8-language translations** of the `intel` namespace (English defaults render everywhere now; this is a content/translation pass).
