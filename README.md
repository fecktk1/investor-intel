# Investor Intel by TheContentForge

Build with CMC: API Hackathon entry, **Real World Assets** track.

Crypto tools show a price, but not where it came from, whether other data agrees, or who issued the asset behind it. For tokenised real-world assets, Investor Intel adds the issuer, the filings, how much of the liquidity is real, and a receipt behind every number.

| | |
|---|---|
| Live product | https://thecontentforge.io/intel (free account, no card: https://thecontentforge.io/intel/signup?plan=free) |
| RWA workspace | https://thecontentforge.io/intel/rwa and https://thecontentforge.io/intel/rwa/wrappers |
| Demo video | https://www.youtube.com/watch?v=DUn6vZ0KKQg |
| DoraHacks BUIDL | https://dorahacks.io/buidl/49075 |

## What is in this repository

| Folder | What it is | How to check it |
|---|---|---|
| `production-source/` | A read-only copy of the production modules behind the live RWA lane and the CMC transport: wrapper premiums, on-chain depth, issuers and underlying SEC registrants, yield against NAV, the capability registry, credit reservation and receipts. Kept under its original paths. | `deno test --allow-read --allow-env production-source/supabase` (398 tests, no key, no network calls to CMC) |
| everything else | A runnable local demo: three investigations (asset notebook, RWA and issuers, market structure) that run on fixtures with no key, on CoinMarketCap's keyless API, or on your own key. | `npm install`, `npm test`, `npm run dev` (see below) |
| `docs/real-api-call.md` | One real production call to `/v5/real-world-assets/quotes/latest`: the code that made it and the response. | |
| `evidence/recorded-cmc-calls/` | Recorded keyless probes, with provider status objects kept verbatim, refusals included. | |

`production-source/` is a snapshot of the private product, not the whole of it. Authentication, org authorization, the free-tier access gate, the Edge Function entry points and the database services are deliberately left out. Every module in the snapshot imports only other modules in the snapshot, which is why its tests run on their own. The product itself runs on Supabase (Postgres and Deno Edge Functions), with React on Netlify.

## CoinMarketCap endpoints used

These are every endpoint the production product called in the 24 hours before 2026-09-22 18:00 UTC, taken from its shared response cache. All calls go through one registry (`production-source/supabase/functions/_shared/market-assets/cmc-capabilities.ts`) and one transport (`cmc-transport.ts`).

**Real-world assets (this track):**
- `/v5/real-world-assets/map`: the whole RWA universe by asset type (7,811 assets, 791 with tokens)
- `/v5/real-world-assets/assets/list`: listings with tokenised price, value and 24-hour volume
- `/v5/real-world-assets/info`: asset profiles, including the underlying company's SEC `cik`
- `/v5/real-world-assets/quotes/latest`: every wrapper of an asset, with its issuer, for wrapper premiums
- `/v1/dex/token/pools`: DEX pools for each wrapper deployment, for the on-chain depth board
- `/v2/cryptocurrency/info`: wrapper contract deployments per chain

**Markets, charts and structure:**
`/v3/cryptocurrency/listings/latest`, `/v3/cryptocurrency/quotes/latest`, `/v2/cryptocurrency/ohlcv/historical`, `/v1/cryptocurrency/listings/historical`, `/v1/cryptocurrency/listings/new`, `/v1/cryptocurrency/categories`, `/v1/cryptocurrency/category`, `/v1/cryptocurrency/trending/latest`, `/v1/cryptocurrency/trending/gainers-losers`, `/v1/cryptocurrency/trending/most-visited`, `/v1/cryptocurrency/airdrops`, `/v1/global-metrics/quotes/latest`, `/v3/fear-and-greed/latest`, `/v1/altcoin-season-index/latest`, `/v3/index/cmc100-latest`, `/v3/index/cmc20-latest`, `/v2/tools/price-conversion`, `/v1/exchange/map`, `/v1/exchange/assets`

**Derivatives:**
`/v5/exchange/derivatives/list`, `/v5/cryptocurrency/derivatives/market-pairs/list/latest`, `/v5/derivatives/liquidations/cryptocurrency/list/latest`

**DEX and on-chain:**
`/v1/k-line/candles`, `/v1/dex/tokens/batch-query`, `/v1/dex/token/price/batch`, `/v1/dex/security/detail`, `/v1/dex/holders/count`, `/v1/dex/meme/list`

**Account:** `/v1/key/info` (plan and credit headroom before any paid call)

## Evidence of a real API call

See [`docs/real-api-call.md`](docs/real-api-call.md): a real `rwaQuotes` call from production on 2026-09-22 (HTTP 200, 1 credit), the lines of code that built and sent it, and the response. The live product shows the same receipt beside each research figure: endpoint, parameters, live call or cache, HTTP status, credits charged as CMC reported them, and cache age.

## What the API made possible, and where it got in the way

**What it made possible.**
- One RWA universe across stocks, funds, commodities and treasuries, keyed by a stable `rwa_id`. Before this, mapping a tokenised stock to its underlying meant maintaining our own list.
- `quotes/latest` returns every wrapper of an asset together with its issuer in one call. That single response is the whole input to the wrapper-premium page.
- `info` carries the underlying company's SEC `cik`, which let us go straight to EDGAR for its annual and quarterly reports.
- Every response reports its own `status.credit_count`. That made honest per-figure cost receipts possible, and let us hold the free RWA workspace to a fixed daily credit budget.
- `/v1/dex/token/pools` gave on-chain depth for wrapper tokens without running our own indexer.

**Where it got in the way.**
- `/v5/real-world-assets/market-pairs/list` refused our Startup key with error 1006, so there is no venue-level depth for RWA pairs. We read DEX pools for each wrapper contract instead.
- The RWA `cik` belongs to the underlying listed company, not the token issuer. The docs don't say which it is, and treating it as the issuer would be a serious mistake. Issuer identity comes from separate, dated evidence (GLEIF, EDGAR, OFAC).
- Gold wrappers under the same asset are priced per gram and per troy ounce. We added a unit guard that converts them to one unit before comparing them.
- None of the tokenised treasury funds we track carry a NAV from CMC, so NAV comes from each fund's Chainlink feed.
- `/v1/dex/token/pools` returns no `data` field at all for a token with zero pools. Our generic guard read that as malformed, and three permissioned funds were charged for refused reads before we special-cased it.
- Some refusals are not JSON: `/v1/dex/meme/list` without `platformIds` answers with an HTML 403 from a gateway, which hid the real reason until the transport started trusting the HTTP status over the body. With `platformIds`, it returns empty lists for every documented request body on Startup.
- The keyless public API answers a small burst and then returns 429 with error 1022, so it can't be relied on for a replayable demo.

## Pre-existing work and what is new

Investor Intel has been part of TheContentForge since June 2026 (narrative radar and signals). Before the event, the product had a narrow v1 listing and global-metrics adapter and v2 quote and map price helpers. **Everything CMC-specific in `production-source/` was built during the event: the first commit was 2026-09-14, after submissions opened on 2026-09-09.** That covers the capability registry, credit reservation and receipts, the v3 and v5 consumers, the whole RWA lane (universe, wrappers, depth, issuers, underlyings, yield) and the DEX lanes. The runnable demo was also written for the event. The shared chart code it reuses contains both older and changed code, so including it is not a claim that every line is new.

## Licence

Copyright 2026 TheContentForge. All rights reserved. This repository is public so the hackathon judges and CoinMarketCap can read, clone and run it. No licence to reuse, modify or redistribute it is granted. CoinMarketCap may feature and showcase the entry under the hackathon rules. Third-party files keep their own licences: TradingView Lightweight Charts (Apache-2.0, `product/src/intel/vendor/`) and the bundled fonts (SIL OFL 1.1, `public/fonts/`, `public/vsx-fonts/`). CoinMarketCap data is not covered by any licence here. Data provided by CoinMarketCap.com.

No API key is committed. The demo reads `CMC_API_KEY` from a local `.env` that `.gitignore` excludes, and the packaging script refuses to build if any file contains a key-shaped string.

# Running the demo

A local research workspace demonstrating three connected investigations: asset price plus personal thesis/activity history, tokenized real-world assets and issuers, and derivatives/market structure. The parent TCF repository, production database and proprietary integrations are not needed to run it.

## Run on Windows

Install Node.js 24 or later. From this directory:

```powershell
npm.cmd install
npm.cmd test
npm.cmd run dev
```

Open http://127.0.0.1:5187. The API binds only http://127.0.0.1:8788. Fixture mode is the default and needs no API key, account or internet connection after dependencies are installed. All supplied market values, issuers, transactions and research records are synthetic and explicitly labeled. Personal edits persist in this browser's localStorage. No trade, real wallet movement, public post or notification is executed.

For a build check: `npm.cmd run build`. The local API is not an Internet-ready hosted service; keep it on loopback. A public deployment requires separate authentication, authorization, licensing and hosting review.

## Keyless demo mode (judge-replayable, opt-in)

A third mode runs the demonstration against CoinMarketCap's keyless public API, so a judge can replay it with real data and no account at all:

```powershell
Copy-Item .env.example .env
# Edit .env locally: CMC_MODE=keyless
npm.cmd run dev
```

**Caveat, verbatim: keyless commercial terms are unstated; keep it to the demo until reviewed.** Do not run this mode inside a product, a hosted service or anything a customer can reach. It lives only in this extraction; the parent application has no code path to it.

**To turn it off, one line in `.env`: `CMC_MODE=fixture`** — which is also the unconfigured default, so deleting `.env` turns it off too.

No key is read or sent in this mode. `CMC_API_KEY` is discarded before the service starts, `/api/status` reports `keyConfigured: false`, and each keyless request carries exactly one header (`Accept`). The base is `https://pro-api.coinmarketcap.com/public-api` and the request never leaves that prefix.

Every keyless answer is labelled `source: "coinmarketcap_keyless"` with `retrievedAt`, and a successful one also carries the provider's own `observedAt`. Each route caches for 30 seconds in memory (nothing keyless touches the SQLite file). The process allows 60 keyless requests a minute and 600 for the whole run; past either ceiling the route answers `keyless_budget_exhausted`. A keyless route **never** substitutes fixture data: a refusal, an exhausted budget or an absent endpoint is reported as itself.

| Journey | Keyless routes used | What is not keyless |
| --- | --- | --- |
| Asset notebook | `/v3/cryptocurrency/quotes/latest`, `/v2/cryptocurrency/info`, `/v1/k-line/candles` | `/v2/cryptocurrency/ohlcv/historical` and `/v3/cryptocurrency/quotes/historical` — the chart uses k-line candles for the WETH contract instead, which is a DEX aggregate across every Ethereum pool, not the CMC reference price of ETH |
| Real-world assets | none | the whole `/v5/real-world-assets/*` family; the route answers `keyless_unavailable` and the RWA demonstration stays in fixture mode |
| Market structure | `/v3/cryptocurrency/listings/latest`, `/v1/cryptocurrency/categories`, `/v1/global-metrics/quotes/latest`, `/v3/fear-and-greed/latest`, `/v1/altcoin-season-index/latest`, `/v3/index/cmc100-latest`, `/v3/index/cmc20-latest`, `/v1/dex/token`, `/v1/dex/security/detail`, `/v1/dex/holders/count` | the derivatives family (`/v5/exchange/derivatives/*`, `/v5/cryptocurrency/derivatives/*`, `/v5/derivatives/liquidations/*`); those routes answer `keyless_unavailable` |

Honest failure codes: `keyless_unavailable` (the subset does not publish that endpoint), `keyless_budget_exhausted` (a local ceiling), `keyless_rate_limited` (the shared IP pool refused the request) and `keyless_provider_unavailable` (anything else). **On 2026-09-15 every keyless probe from the development network returned HTTP 429 with error code 1022, "You've reached the limit for anonymous access." On 2026-09-16 the same network was answered:** `/v1/global-metrics/quotes/latest`, `/v3/cryptocurrency/listings/latest` and `/v1/dex/holders/count` each returned HTTP 200 with real data, and a further burst was refused 429/1022 again within ninety seconds. The shared anonymous pool answers a small burst and then refuses, so the mapping is now confirmed against live keyless responses for the routes that answered and remains unit-tested against the documented shapes for the rest. `docs/keyless-demo-mode.md` beside this README records both probe logs. `npm run capture:evidence` records a dated evidence artefact from the routes that answer, pacing itself and writing a refusal verbatim rather than retrying into the wall. A judge on a different network may fare better or worse, which is exactly what the mode is for, and if they are refused the failure is shown, not hidden.

## Bring your own CMC key

The demo makes real calls only after you explicitly enable live mode on the local server:

```powershell
Copy-Item .env.example .env
# Edit .env locally: CMC_MODE=live, CMC_API_KEY=<your key>
# Keep CMC_VERIFIED_PLAN=basic unless your plan is separately verified.
npm.cmd run dev
```

Restart after changing `.env`. Never use a VITE-prefixed key or paste a key into the browser. Live mode does not silently substitute synthetic market values when a request fails; missing/limited responses remain unavailable. Personal ledger and thesis records remain local examples in live mode.

The server reuses the production branch's capability catalog, normalization and documented credit estimates. It validates allowed parameters and stable identifiers, fixes the CMC host, uses one USD conversion, refuses unsupported plans, checks `/v1/key/info`, caches operational responses and reserves/reconciles a persistent local credit ceiling in SQLite. The default ceiling is 20 credits per UTC calendar month, capped at 100 even if configured higher, and is subordinate to the live account's 20% headroom. A process restart does not reset spent/reserved credits. The demo has one local request lane, no streaming, no upstream retries and no per-user fan-out. Process death leaves a reservation charged. This local SQLite implementation is intentionally separate from the production Supabase/Railway deployment; it is not a production accounting substitute.

The local database is `.local/demo.sqlite`. It contains operational response caches and aggregate local budget state, never the key. Do not distribute it. Keys and cached responses are excluded by `.gitignore` and the explicit package manifest. Review CoinMarketCap's commercial terms before displaying its data outside your permitted product; retaining/exporting raw histories or sending data to models is not part of this demo.

## Three demonstrations

1. **Asset notebook:** review real OHLCV as candles, OHLC bars or a line; use volume, studies and historical replay; toggle marker classes, open exact original research/portfolio event details, append a thesis review or manual movement, reopen its original note from the research ledger, and evaluate a deterministic threshold against the displayed quote. Markers outside price coverage remain in event history; missing execution prices are never fabricated.
2. **RWA:** load instrument listings, inspect separate metadata and current aggregate quotes, explore issuer listings and issuer details. The UI distinguishes issuer, RWA and crypto IDs, and explicitly identifies missing redemption/custody/eligibility evidence.
3. **Market structure:** read derivative exchange volume/open interest, load ETH derivative pairs/funding context, inspect aggregate liquidation data, then save the observation into the notebook. No synthetic spread or trade execution path is offered.

## CMC endpoints the demo calls

| Consumer | Endpoint | Access / documented credits |
| --- | --- | --- |
| Account budget guard | `/v1/key/info` | Internal; 0 credits observed |
| ETH quote | `/v3/cryptocurrency/quotes/latest` | Basic+; ceil(items/250) |
| ETH daily OHLCV chart | `/v2/cryptocurrency/ohlcv/historical` | Startup+; ceil(points/100); one asset, 90 daily candles |
| Historical quotes service | `/v3/cryptocurrency/quotes/historical` | Callable service; ceil(points/100); not substituted for candles |
| Metadata service | `/v2/cryptocurrency/info` | Basic+; ceil(items/250); callable service, not a separate screen |
| RWA instrument list | `/v5/real-world-assets/assets/list` | Basic+; ceil(items/250) |
| RWA metadata | `/v5/real-world-assets/info` | Basic+; ceil(items/250) |
| RWA aggregate quotes | `/v5/real-world-assets/quotes/latest` | Basic+; ceil(items/250) |
| Issuers / issuer | `/v5/real-world-assets/issuers/list`, `/v5/real-world-assets/issuers` | Basic+; 1 each |
| Derivative exchanges | `/v5/exchange/derivatives/list` | Basic+; ceil(items/250) |
| ETH derivative pairs | `/v5/cryptocurrency/derivatives/market-pairs/list/latest` | Basic+; ceil(items/250) |
| Liquidation summary | `/v5/derivatives/liquidations/quotes/latest` | Basic+; 1 |

References: [official endpoint chooser](https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview), [pricing](https://coinmarketcap.com/api/pricing/), [commercial terms](https://pro.coinmarketcap.com/user-agreement-commercial/). A documented plan is not proof of your key's access. Local tests use injected synthetic responses and spend no provider credits. The demo's tests use injected synthetic responses; the real production call is in `docs/real-api-call.md`.

## Tests and limitations

`npm test` runs 26 tests across five files (counted from the `test(` calls in `tests/*.test.mjs` and confirmed by a passing run on 2026-09-16: 26 pass, 0 fail). Eleven cover the governed service, charts and notebook (`governance.test.mjs` 7, `chart-data.test.mjs` 3, `notebook.test.mjs` 1): OHLCV shape, exact close timestamps, absent volume, fixture mode making zero calls, invalid/oversized requests are blocked, reserve/reconcile tracks actual credits, cache hits avoid new calls, account failure stops calls, and the credit ceiling survives reopening the database. Ten cover the keyless mode (`keyless.test.mjs`): the labelled payload and its credential-free request, path parity with the keyed catalog, `keyless_unavailable` for every route the subset omits, keyless mode discarding a configured key, k-line candle mapping and its derived close time, k-line parameter refusals, the 30-second per-route cache, the per-minute and per-run ceilings, and the four honest failure payloads. Five cover the keyless evidence capture (`capture-keyless-evidence.test.mjs`): real answers recorded with no credential in the request, the provider status object kept verbatim with a reported zero staying zero, the capture passing its own secret gate, a refused probe recorded with its refusal, and answered and refused probes kept side by side. `npm run build` checks the standalone browser bundle. Local HTTP smoke tests cover all three fixture workflows. Browser verification of the production application is separate.

This extraction does not implement production RLS, paid subscriptions, wallet import, portfolio accounting/PnL, real thesis persistence, alert delivery, full CMC account administration, on-chain claims or public hosting. A CMC daily history is a provider history, not the execution history of a trade. The sample manual ledger has no brokerage or chain connection. Exact original notes are preserved locally on append; clearing browser storage clears local demo records.

## How this repository was built

It was generated from the private TheContentForge repository by `scripts/package-investor-intel-demo.mjs`, which copies an explicit allowlist of files, never the whole repository or its history. Before writing anything, it:

- refuses private working documents by name and any file that still carries an unresolved drafting marker
- scans every text file for secret shapes (API keys, tokens, JWTs, Supabase project URLs and refs, UUIDs, email addresses) and stops on any match. The only exceptions are a short list of reviewed public values, such as fake keys in test fixtures and the published support address.
- checks that every relative import in the demo and in `production-source/` resolves inside the package, so nothing private is reached for

`SOURCE-MANIFEST.json` lists every file with its original path and SHA-256. `node_modules`, `.env`, `.local`, database files and production configuration are never copied.

## Current chart scope

The extraction uses the product's current renderer and mathematical tools, not a separate demonstration renderer. New local events retain both occurrence and recording time. A chart at the latest requested edge follows a newly appended event; panned historical views retain their chosen times. Overlapping markers have a chronological record selector, and details remain inside the viewport on a scrolled page.

Synthetic candle recording times are synthetic simulation data. Live OHLCV bars retain the provider's close time and the local server fetch time; historical replay cannot invent when corrected data was originally known. USD volume is period volume, and missing volume remains unavailable.

The research notebook persists locally. Chart drawings, study choices and layout changes in this extraction are session-only; production layout libraries, private snapshots, sharing and alert persistence require the authenticated product backend and are deliberately not represented as operational local save controls. Reusing those components does not bypass authentication or enable a hosted share service.

Fresh standalone dependency installation, build and the test suite as it then stood were verified on September 11 (superseded for the current count by the Tests section above). Separate browser fixture checks covered OHLC/candles, volume, SMA, replay, a new note appearing without Reset view, original-note selection in an overlapping marker, and a 390-pixel mobile portfolio detail sheet. These are synthetic demonstration checks, not signed-in product acceptance or field-performance evidence.

Phase 3 extraction boundary: named watchlists, private workspace selection, chart working-state saving, chart sharing and server-side reading of posts from X are available in the authenticated product only. Seven explicitly listed adapters cover them. They disable the named-list chart action, reject standalone private-list reads, carry only the pure draft store out of the working-state module, say beside the chart that changes are not saved, disable the Share control, and say on an anchored post card that its text cannot be read here. They do not emulate persistence, include account providers, or change the product renderer. The source manifest records these adapters separately.

September 12 verification: a new directory outside the parent repository completed `npm ci --ignore-scripts --no-audit --no-fund`, the test suite as it then stood and its own Vite build. The current count is in the Tests section above. The missing `cmc-dex.ts` server dependency found by that clean installation is now explicitly included. Fixture browser checks cover all three workflows, an appended review marker, and original-note reopening. Browser snapshots and production product acceptance remain separate evidence.
