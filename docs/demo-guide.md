# Demo guide

Operating detail for the runnable demo. The short version is in the README.

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

`npm test` runs 26 tests across five files (counted from the `test(` calls in `tests/*.test.mjs` and confirmed by a passing run on 2026-09-16: 26 pass, 0 fail). Eleven cover the governed service, charts and notebook (`governance.test.mjs` 7, `chart-data.test.mjs` 3, `notebook.test.mjs` 1): OHLCV shape, exact close timestamps, absent volume, fixture mode making zero calls, invalid/oversized requests are blocked, reserve/reconcile tracks actual credits, cache hits avoid new calls, account failure stops calls, and the credit ceiling survives reopening the database. Ten cover the keyless mode (`keyless.test.mjs`): the labelled payload and its credential-free request, path parity with the keyed catalog, `keyless_unavailable` for every route the subset omits, keyless mode discarding a configured key, k-line candle mapping and its derived close time, k-line parameter refusals, the 30-second per-route cache, the per-minute and per-run ceilings, and the four honest failure payloads. Five cover the keyless evidence capture (`capture-keyless-evidence.test.mjs`): real answers recorded with no credential in the request, the provider status object kept verbatim with a reported zero staying zero, the capture passing its own secret gate, a refused probe recorded with its refusal, and answered and refused probes kept side by side. `npm run build` checks the standalone browser bundle. The same tests, the build, 2,299 production-source Deno tests (listed in `production-source/runnable-tests.txt`) and 32 production-source Vitest tests of the React frontend (listed in `production-source/runnable-vitest-tests.txt`) run on every push in `.github/workflows/test.yml`, offline and with no secrets. Local HTTP smoke tests cover all three fixture workflows. Browser verification of the production application is separate.

This extraction does not implement production RLS, paid subscriptions, wallet import, portfolio accounting/PnL, real thesis persistence, alert delivery, full CMC account administration, on-chain claims or public hosting. A CMC daily history is a provider history, not the execution history of a trade. The sample manual ledger has no brokerage or chain connection. Exact original notes are preserved locally on append; clearing browser storage clears local demo records.

## How this repository was built

It was generated from the private TheContentForge repository by `scripts/package-investor-intel-demo.mjs`, which copies an explicit allowlist of files, never the whole repository or its history. Before writing anything, it:

- refuses private working documents by name and any file that still carries an unresolved drafting marker
- scans every text file for secret shapes (API keys, tokens, JWTs, Supabase project URLs and refs, UUIDs, email addresses) and stops on any match. The only exceptions are a short list of reviewed public values, such as fake keys in test fixtures and the published support address.
- checks that every relative import in the demo and in `production-source/` resolves inside the package, so nothing private is reached for

`SOURCE-MANIFEST.json` lists every file with its original path and SHA-256. `node_modules`, `.env`, `.local`, database files and production configuration are never copied.

Its test, `scripts/test-intel-extraction-package.mjs` (published as `production-source/scripts/test-intel-extraction-package.mjs`), then runs the package the way the workflow does and checks every count of tests, test files and MCP tools stated in the README and in these documents against it. The tests that cannot run here are counted in the private repository, where their modules load. A count recorded for a named earlier run is left as it was.

## Current chart scope

The extraction uses the product's current renderer and mathematical tools, not a separate demonstration renderer. New local events retain both occurrence and recording time. A chart at the latest requested edge follows a newly appended event; panned historical views retain their chosen times. Overlapping markers have a chronological record selector, and details remain inside the viewport on a scrolled page.

Synthetic candle recording times are synthetic simulation data. Live OHLCV bars retain the provider's close time and the local server fetch time; historical replay cannot invent when corrected data was originally known. USD volume is period volume, and missing volume remains unavailable.

The research notebook persists locally. Chart drawings, study choices and layout changes in this extraction are session-only; production layout libraries, private snapshots, sharing and alert persistence require the authenticated product backend and are deliberately not represented as operational local save controls. Reusing those components does not bypass authentication or enable a hosted share service.

What the demo leaves out: named watchlists, private workspace selection, chart working-state saving, chart sharing and server-side reading of posts from X are available in the authenticated product only. Seven explicitly listed adapters cover them. They disable the named-list chart action, reject standalone private-list reads, carry only the pure draft store out of the working-state module, say beside the chart that changes are not saved, disable the Share control, and say on an anchored post card that its text cannot be read here. They do not emulate persistence, include account providers, or change the product renderer. The source manifest records these adapters separately.
