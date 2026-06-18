# Investor Intel redesign feature-preservation inventory

Created before UI code edits for the Investor Intel presentation-only redesign.

Rules for this pass:
- Preserve all existing routes, data loaders, hooks, backend contracts, CTAs, filters, links, visible fields, states, and disclaimers.
- Do not remove information to make pages cleaner.
- If information is moved, renamed, grouped, visually de-emphasized, or placed behind progressive disclosure, record it in the stage and final handoff.
- Do not introduce buy/sell/trade language.

## Shared shell and primitives

### `IntelModeShell`
- Visible modules: desktop sidebar, mobile drawer, product/org header, trial banner, grouped nav sections, support/report action, team-workspace switch, sign out, language switcher, mobile header, disclaimer bar, scroll-restored main content, support ticket modal.
- CTAs/links: nav links, Report Issue, Switch to a team workspace, Sign out, language switcher, support modal submission path.
- Badges/status: trial days remaining, active nav state, admin-only nav entries.
- States: mobile overlay open/closed, protected Intel route loading handled by `IntelApp`, modal open/closed.
- Disclaimers: global Intel disclaimer bar.

### Shared components and utility classes
- Visible modules preserved by shared use: cards/surfaces, buttons, chips, status badges, tables, skeleton/loading indicators, empty/error notices, disclaimer blocks, chart frames, source/evidence strips.
- Data fields: all children are passed through; primitives must not filter fields.
- States: hover, pressed, focus-visible, disabled, loading/skeleton, empty/error wrappers.

## Primary pages

### `/intel` `MarketPulsePage`
- Visible modules: header, refresh, What matters now artifact generation, market regime banner, today's picture, notable changes, scope selector, chain/project selectors, summary artifact, What changed since last visit, catalysts rail, empty home prompt, following/alerts/narratives/news stats, chains followed, For You, outside bubble, holdings/followed signal rails, notable stories/news, fired alerts, latest brief, source/disclaimer material.
- Data fields: regime data, grounding, movers, prices, 24h change, market signal context, scope, chain/project labels, followed counts, unread alerts, narrative/news counts, chain performance, signals, news source/category/timestamp/source count, brief/alert data.
- CTAs/links: refresh, What matters now, scope buttons, chain/project filters, Open full breakdown, Watchlist, News, asset links, market chain links, signal/story links, alert/brief links.
- Badges/status: market signals, source/category chips, confidence/source-support labels, personalization/relevance chips from signal data, fresh/stale signal markers.
- States: initial loading, empty dashboard, error, artifact loading/error/result, unavailable sparse data.
- Disclaimers: inherited bar plus page/block disclaimer where rendered.

### `/intel/markets` `MarketsPage`
- Visible modules: header, mode tabs, regime banner, macro bar, rank movers, global snapshot, provider-degraded notice, top movers/losers, derived views, watchlist movers, category leaders, chain browser, token lookup/address resolver, candidate chooser, filters/search/sort/pagination, canonical markets table, degen mode filters/table, spreads, disclaimers.
- Data fields: tracked assets, up/down counts, volume, market cap, CEX coverage, strongest chain, market rows with rank/asset/price/1h/24h/7d/volume/market cap/FDV/signal/exchanges, degen rows, derived counts, provider status, chain perf.
- CTAs/links: mode tabs, filters, search/open token, candidate selection, table row open, watchlist/view chips, pagination, refresh-like tab changes.
- Badges/status: signal badges, provider coverage, risk/caution chips, derived view counts, degraded provider warning.
- States: market/degen loading, no data, locate errors, candidate ambiguity, provider degradation.
- Disclaimers: market intelligence/not financial advice language.

### `/intel/markets/:symbol` `MarketAssetPage`
- Visible modules: back link, asset header, price/change, best exchange pair, market signal, signal factors, confirming/conflicting providers, profile panel, price chart, metrics, per-exchange reads, cross-exchange spread, order book depth, market memory, on-chain activity, ecosystem narratives, catalysts/news, unlocks, analyst artifact, thesis drift, year in review, disclaimer.
- Data fields: symbol/name/chain/source, price, 1h/24h/7d, volume, market cap, FDV, supply, provider prices/spreads/order book imbalance, signal strength/confidence/factors, profile links/socials/categories, on-chain holders/wallets/volume/liquidity, narrative stages/signals, catalyst/news dates/source links, unlock timing/supply, thesis drift details.
- CTAs/links: back, profile external links, explanation generation/refresh, source/news links, thesis links.
- Badges/status: market signal, confidence, provider coverage, stage/signal chips, unlock dilution, thesis drift, freshness/context labels.
- States: loading, asset not found, profile refreshing/partial, missing chart/order book/enrichment slices, artifact loading/error/result.
- Disclaimers: block disclaimer.

### `/intel/narratives` `NarrativeRadarPage`
- Visible modules: header, refresh, summary row, tabs, category/chain filters, degraded/error notices, custom narrative advanced form/list, narrative cards, relevant signals, disclaimer.
- Data fields: narrative name/category/status/signal/on-chain/market confirmation/velocity/chains/relevance labels/scorecard/leaders/what changed, custom narrative title/status/private marker.
- CTAs/links: refresh, tabs, category/chain filters, follow/unfollow, open detail, add custom narrative, mapped narrative open.
- Badges/status: stage, signal, market confirmation, on-chain coverage, dynamic/seeded, followed star, clarity/personalization labels, velocity, leader moves.
- States: loading skeletons, empty filter, follow limit/error, degraded data, custom create/mapped/error/empty.
- Disclaimers: block disclaimer.

### `/intel/narratives/:slug` `NarrativeDetailPage`
- Visible modules: back/open header, follow/unfollow, summary/score sections, history/priority/stage, evidence/news/leaders/signals/relevance where available, relevant signals/disclaimer.
- Data fields: narrative identity, status/stage/signal, scores, leaders, chains/categories, evidence/news/source facts, history/time series, follow state, relevance labels.
- CTAs/links: back, follow, open linked assets/news/sources where present.
- Badges/status: stage/signal/confirmation/risk/confidence/freshness/relevance labels.
- States: loading, not found/error, sparse missing evidence/history.
- Disclaimers: block disclaimer.

### `/intel/news` `NewsPage` and `CuratedNewsCard`
- Visible modules: header, Fetch news, add source form, source chips/removal, error notice, search/filter/date controls, curated/top stories, all headlines, pagination, relevant signals, disclaimer.
- Data fields: source type/value/usage limit, source quality, source count/supporting sources, categories, timestamps, signal, curated title, what happened, why it matters, crypto impact, bull/bear cases when present, affected tokens/narratives, watch next, headline source/entity/sentiment.
- CTAs/links: Fetch news, Add source, remove source, search, clear filters, source expand/collapse, source/news external links, pagination.
- Badges/status: source quality, unverified, curated, signal, category, entity/token, sentiment, source count.
- States: loading, no match, empty feed, source duplicate/limit/error, pagination.
- Disclaimers: block disclaimer.

### `/intel/macro` `MacroPage`
- Visible modules: header, economic data, economic calendar, big macro news, WhyImportant/Explain actions, disclaimer.
- Data fields: indicator label/value/unit/change/trend/as-of/period, event title/importance/country/scheduled time/forecast/previous, news title/source/corroboration/sentiment/date/summary.
- CTAs/links: WhyImportant generation, news external links.
- Badges/status: trend direction, event importance, source count/corroboration, sentiment.
- States: loading, no indicators, no calendar, no news, explain loading/error/result.
- Disclaimers: block disclaimer.

## Remaining surfaces to receive shared-system polish

### `/intel/watchlist`
- Modules/fields: add form, item list, item type, entity symbol/name, signal badge, portfolio action, remove action, watchlist limit/status, loading/empty/error states, portfolio tracking note.
- CTAs: Add, track in Portfolio, add to Portfolio, remove, entity links.

### `/intel/portfolio` and `/intel/portfolio/:portfolioId/asset/:assetKey`
- Modules/fields: portfolio summary, wallet sync panel, holdings, activity/transactions, performance chart, exposure cards, cost basis/P&L/allocation/source status, CSV/manual/source controls, safety/disclaimer.
- CTAs: connect/import/sync wallets, manual transaction, export, source controls, asset drill-in.

### `/intel/wallets` `AnalyzeInputPage`
- Modules/fields: identifier form, analysis artifact, error/empty/loading states.
- CTAs: Analyze, artifact refresh/save where rendered.

### `/intel/defi`
- Modules/fields: chain/view/product filters, pool/lending tables, APY/TVL/risk/status, deep-dive panel, metrics/history/news/artifact, stale/provider status, safety copy.
- CTAs: analyze address, row deep dive, copy address, external protocol links, close deep dive.

### `/intel/execution`
- Modules/fields: quote/check form, slippage/input token/amount/output mint, execution quality, price impact/liquidity/token price/slippage tolerance, route venues, report generation, report sections.
- CTAs: Check Execution, Generate report, report/source links.

### `/intel/alerts`
- Modules/fields: rule form, rules list, quality/noisy state, suggested config, alert events/groups, explanation artifact.
- CTAs: Add rule, apply suggestion, delete, Why it matters.

### `/intel/briefs`
- Modules/fields: brief generation, brief cards/history, summary, regime/watchlist/macro/news/thesis sections, source labels, no-change state.
- CTAs: Generate today's brief, open existing brief, refresh/save artifact.

### `/intel/explain`
- Modules/fields: question/context form, quick chips/ref handling, generated artifact, empty/loading/error states.
- CTAs: Ask/explain, quick prompts, artifact refresh/save.

### `/intel/compare`
- Modules/fields: two asset inputs/resolution cards, compare action, multi-token chart, comparison artifact, errors/loading.
- CTAs: Compare, open assets where rendered.

### `/intel/theses` and thesis subcomponents
- Modules/fields: legacy tracker or journal shell, thesis list/detail/builder/dashboard/analytics/settings, status badges, quality/delta/boundary/portfolio insights, baseline/drift/review data, empty/loading/error states.
- CTAs: New thesis, save, review, delete, status decisions, accept rules.

### `/intel/research`
- Modules/fields: saved artifacts/research list, metadata, empty/loading/error states.
- CTAs: open, delete/save controls where present.

### `/intel/settings`, `/intel/support`, `/intel/support/:refCode`, admin-only Intel routes
- Modules/fields: existing settings/support/admin modules, support thread/inbox states, admin metrics/quality controls, visible safety/support copy.
- CTAs: preserve all existing settings, support, admin, and ticket actions.
- Scope: only shared shell/surface polish unless a component is explicitly touched.

## Components expected to be touched

- `IntelModeShell`, `IntelDisclaimer`, `IntelActionButton`, `WhyImportant`, `ArtifactView`
- `MarketsTable`, `MarketSignalBadge`, `ProviderCoveragePill`, `ConfidenceChip`
- `NarrativeCard`, narrative UI metadata helpers
- `CuratedNewsCard`, `MarketEnrichmentCards`, `OrderbookDepthCard`, chart frame components
- Shared new primitives under `src/intel/components`

