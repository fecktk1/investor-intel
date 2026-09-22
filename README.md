# Investor Intel by TheContentForge

Build with CMC: API Hackathon entry, **Real World Assets** track.

Crypto tools show a price, but not where it came from, whether other data agrees, or who issued the asset behind it. For tokenised real-world assets, Investor Intel adds the issuer, the filings, how much of the liquidity is real, and a receipt behind every number.

| | |
|---|---|
| Live demo, no account | https://thecontentforge.io/intel/demo (the real app on a daily snapshot; nothing you do is saved) |
| Live product | https://thecontentforge.io/intel (free account, no card: https://thecontentforge.io/intel/signup?plan=free) |
| RWA workspace | https://thecontentforge.io/intel/rwa and https://thecontentforge.io/intel/rwa/wrappers |
| Demo video | https://www.youtube.com/watch?v=DUn6vZ0KKQg |
| DoraHacks BUIDL | https://dorahacks.io/buidl/49075 |

## What it does for tokenised real-world assets

- **Which wrapper to hold.** For every asset with several wrapper tokens: the cheapest to its anchor, the closest to it, and the most traded, with the wrappers left out and why. The anchor is a fresh published NAV where one exists, otherwise the volume-weighted median of the liquid wrappers; a wrapper that sets that median is flagged rather than presented as "closest".
- **Premium over time.** Each wrapper's premium or discount from every six-hourly capture, plus up to 90 days before that rebuilt from daily OHLCV closes through the same unit, accrual and liquidity rules, labelled as reconstructed, with weekends and exchange holidays shaded.
- **Exit capacity.** How many days a position takes to sell at a chosen share of daily volume, computed twice: through the on-chain pools whose other leg can be valued, and across all venues CoinMarketCap reports. Missing data is a stated reason, never zero days.
- **Listed is not tradeable.** A daily census of every tokenised asset in the RWA map: which have a wrapper that actually trades, which are priced but not traded, which are listed only, and what changed since the day before. On 2026-09-22, 526 of 791 had no wrapper with reported trading.
- **Who holds the value.** Issuer concentration (HHI, effective number of issuers, top-five share) and the chains wrappers are deployed on, with value attributed to a chain only for single-chain tokens.
- **Issuers from public registers.** Token to legal entity only through dated evidence (GLEIF, SEC EDGAR, OFAC), never by name similarity; the underlying company of a tokenised stock with its latest filings; advertised yield beside NAV-implied yield.
- **Every number shows its source.** A receipt beside each figure (endpoint, parameters, live call or cache, HTTP status, credits charged, cache age), a `curl` line that reproduces a live call with your own key, and CSV export of each table (provider figures are left blank unless the data licence allows export).
- **Bring your own agent.** A hosted MCP server with 28 grounded read tools covering all of the above, with scoped, revocable tokens and human-approved writes.

## What is in this repository

| Folder | What it is | How to check it |
|---|---|---|
| `production-source/` | A read-only copy of the production modules behind the live RWA lane and the CMC transport: wrapper premiums, best-wrapper picks, premium history, on-chain depth and exit capacity, daily universe coverage and issuer concentration, issuers and underlying SEC registrants, yield against NAV, the capability registry, credit reservation and receipts. Kept under its original paths. | `deno test --allow-read --allow-env production-source/supabase` (473 tests, no key, no network calls to CMC) |
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

# Quick start

Install Node.js 24 or later, then from the repository root:

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:5187. The demo has three modes, set in a local `.env` (copy `.env.example`):

| Mode | `.env` | What you see |
|---|---|---|
| Fixture (default) | nothing | All three investigations on labelled synthetic data. No key, no network. |
| **Live, with your own key** | `CMC_MODE=live`, `CMC_API_KEY=<your key>` and, for a hackathon Startup key, `CMC_VERIFIED_PLAN=startup` | **Real RWA listings, profiles, quotes and issuers** from `/v5/real-world-assets/*`, plus live quotes, OHLCV (Startup) and derivatives. The server spends at most 20 credits a month by default (`CMC_DEMO_CREDIT_LIMIT`) and never sends the key to the browser. |
| Keyless | `CMC_MODE=keyless` | CoinMarketCap's anonymous public API, no key at all. It does not cover the RWA family, and the shared pool refuses bursts (HTTP 429). Caveat, verbatim: keyless commercial terms are unstated; keep it to the demo until reviewed. |

The production modules have their own tests:

```bash
deno test --allow-read --allow-env production-source/supabase
```

## More detail

- [`docs/real-api-call.md`](docs/real-api-call.md): a real production call, the code that made it and the response
- [`docs/build-timeline.md`](docs/build-timeline.md): when the CoinMarketCap work was built, by day
- [`docs/demo-guide.md`](docs/demo-guide.md): modes, credit guard, tests, what the demo leaves out, and how this repository is packaged
- [`docs/keyless-demo-mode.md`](docs/keyless-demo-mode.md): keyless probe logs
