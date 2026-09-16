# Investor Intel — runnable hackathon extraction

A local research workspace demonstrating three connected investigations: asset price plus personal thesis/activity history, tokenized real-world assets and issuers, and derivatives/market structure. This folder is self-contained after the scoped package command synchronizes its explicit chart dependency list, stylesheet, capability catalog and licensed local fonts. The parent TCF repository, production database and proprietary integrations are not needed to run it.

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

## Actual CMC consumers

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

References: [official endpoint chooser](https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview), [pricing](https://coinmarketcap.com/api/pricing/), [commercial terms](https://pro.coinmarketcap.com/user-agreement-commercial/). A documented plan is not proof of your key's access. Local tests use injected synthetic responses and spend no provider credits. This package does not contain recorded production responses or claim live schema verification for all endpoints.

## Tests and limitations

`npm test` runs 26 tests across five files (counted from the `test(` calls in `tests/*.test.mjs` and confirmed by a passing run on 2026-09-16: 26 pass, 0 fail). Eleven cover the governed service, charts and notebook (`governance.test.mjs` 7, `chart-data.test.mjs` 3, `notebook.test.mjs` 1): OHLCV shape, exact close timestamps, absent volume, fixture mode making zero calls, invalid/oversized requests are blocked, reserve/reconcile tracks actual credits, cache hits avoid new calls, account failure stops calls, and the credit ceiling survives reopening the database. Ten cover the keyless mode (`keyless.test.mjs`): the labelled payload and its credential-free request, path parity with the keyed catalog, `keyless_unavailable` for every route the subset omits, keyless mode discarding a configured key, k-line candle mapping and its derived close time, k-line parameter refusals, the 30-second per-route cache, the per-minute and per-run ceilings, and the four honest failure payloads. Five cover the keyless evidence capture (`capture-keyless-evidence.test.mjs`): real answers recorded with no credential in the request, the provider status object kept verbatim with a reported zero staying zero, the capture passing its own secret gate, a refused probe recorded with its refusal, and answered and refused probes kept side by side. `npm run build` checks the standalone browser bundle. Local HTTP smoke tests cover all three fixture workflows. Browser verification of the production application is separate.

This extraction does not implement production RLS, paid subscriptions, wallet import, portfolio accounting/PnL, real thesis persistence, alert delivery, full CMC account administration, on-chain claims or public hosting. A CMC daily history is a provider history, not the execution history of a trade. The sample manual ledger has no brokerage or chain connection. Exact original notes are preserved locally on append; clearing browser storage clears local demo records.

## Pre-existing versus newly added

The pre-event private product had a narrow v1 CMC listing/global adapter, raw v2 quote/map price helpers, a chart, and separate thesis/portfolio experiences. Newly added work includes governed v3/v5 capabilities, CMC quota reservation/reconciliation, connected RWA/issuer/derivative consumers, exact personal history markers, shared chart/evidence components and this independent runnable extraction. The extracted shared chart contains both existing and changed code; its inclusion is not a claim that every line was authored during the event.

Before public submission, the owner must confirm reuse rights/license for the selected source files, organizer eligibility for extending a pre-existing integration, endpoint entitlement and CMC commercial scope. No open-source license grant or publication is implied by this private preparation. The event page requests public source and a working demonstration; owner approval and organizer confirmation remain separate actions. Nothing was registered, posted, published or submitted by this package script.

From the private parent checkout, `node scripts/package-investor-intel-demo.mjs` produces a new source-only folder under `artifacts/` with an explicit SHA-256 manifest. It copies only the listed example files, the explicitly reviewed chart modules (including the two analysis workers), the shared stylesheet and capability catalog, the renderer license/notice, and three explicitly listed licensed font files with their notice. The package run on 2026-09-16 contained 106 allowlisted files (1,128,579 bytes), including its pinned dependency lock, the CMC catalog modules, the keyless demo client with its tests, the six public documents under `docs/` (`keyless-demo-mode.md`, `submission-requirements.md`, `judge-walkthrough.md`, `demo-video-script.md`, `buidl-description.md`, `licence-options.md`) and recorded evidence of real CMC calls under `evidence/recorded-cmc-calls/`. A capture made with `npm run capture:evidence` at the top of `evidence/` is included when present. Two working documents in the private checkout are refused by name, wherever they appear, and every packaged text file is scanned for secret shapes (keys, tokens, JWTs, Supabase project URLs and refs, UUIDs, email addresses); a match stops packaging before anything is written. Dependency-closure guards cover browser, server and test imports and stop packaging if an unreviewed relative import is added. The package regression executes the emitted server tests as well as the browser build. It never recursively copies the TCF repository, node_modules, `.env`, `.local`, database files or production configuration.

The sample position is computed from successful local ETH movements. Its ledger shows recorded quantity and source, with a stable native-asset key. Market value is explicitly illustrative; missing execution evidence leaves cost basis and P&L unavailable. Barlow Condensed, Inter and Geist Mono are bundled locally with their font notice, so fixture viewing needs no font CDN.


The header includes an accessible light/dark theme switch. In fixture mode only, Fixture state selects populated, loading, empty, stale or error for visual checks without changing the server or making external calls. Empty/error snapshots keep personal research and synthetic recorded holdings visible while price and derived market value remain unavailable.


## Current chart scope

The extraction uses the product's current renderer and mathematical tools, not a separate demonstration renderer. New local events retain both occurrence and recording time. A chart at the latest requested edge follows a newly appended event; panned historical views retain their chosen times. Overlapping markers have a chronological record selector, and details remain inside the viewport on a scrolled page.

Synthetic candle recording times are synthetic simulation data. Live OHLCV bars retain the provider's close time and the local server fetch time; historical replay cannot invent when corrected data was originally known. USD volume is period volume, and missing volume remains unavailable.

The research notebook persists locally. Chart drawings, study choices and layout changes in this extraction are session-only; production layout libraries, private snapshots, sharing and alert persistence require the authenticated product backend and are deliberately not represented as operational local save controls. Reusing those components does not bypass authentication or enable a hosted share service.

Fresh standalone dependency installation, build and the test suite as it then stood were verified on September 11 (superseded for the current count by the Tests section above). Separate browser fixture checks covered OHLC/candles, volume, SMA, replay, a new note appearing without Reset view, original-note selection in an overlapping marker, and a 390-pixel mobile portfolio detail sheet. These are synthetic demonstration checks, not signed-in product acceptance or field-performance evidence.

Phase 3 extraction boundary: named watchlists, private workspace selection, chart working-state saving, chart sharing and server-side reading of posts from X are available in the authenticated product only. Seven explicitly listed adapters cover them. They disable the named-list chart action, reject standalone private-list reads, carry only the pure draft store out of the working-state module, say beside the chart that changes are not saved, disable the Share control, and say on an anchored post card that its text cannot be read here. They do not emulate persistence, include account providers, or change the product renderer. The source manifest records these adapters separately.

September 12 verification: a new directory outside the parent repository completed `npm ci --ignore-scripts --no-audit --no-fund`, the test suite as it then stood and its own Vite build. The current count is in the Tests section above. The missing `cmc-dex.ts` server dependency found by that clean installation is now explicitly included. Fixture browser checks cover all three workflows, an appended review marker, and original-note reopening. Browser snapshots and production product acceptance remain separate evidence.
