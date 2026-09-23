# Investor Intel by TheContentForge

[![test](https://github.com/fecktk1/investor-intel/actions/workflows/test.yml/badge.svg)](https://github.com/fecktk1/investor-intel/actions/workflows/test.yml)

Build with CMC: API Hackathon entry, **Real World Assets** track.

A tokenised stock, fund or commodity is a wrapper. Investor Intel answers the questions behind the wrapper from CoinMarketCap's RWA endpoints and public registers, with a receipt behind every number.

**Live demo:** https://thecontentforge.io/intel/demo (open this link first: it starts a demo session of the real app on a daily snapshot, and nothing you do is saved)

## What it answers for someone tracking tokenised assets

| Question | Answer in the product | Where |
|---|---|---|
| Which wrapper of this asset should I hold? | Premium or discount of every wrapper against an anchor: a fresh published NAV where one exists, otherwise the volume-weighted median of the liquid wrappers. Picks for cheapest to the anchor, closest to it and most traded, with every wrapper left out and why. A wrapper that sets the median is flagged rather than presented as closest. | Wrapper premiums (`/intel/rwa/wrappers`) |
| Has that premium held? | Each wrapper's premium from every six-hourly capture, plus up to 90 days before that rebuilt from daily OHLCV closes through the same unit, accrual and liquidity rules, labelled as reconstructed, with weekends and exchange holidays shaded. | Wrapper premiums, history panel below the board |
| Does it trade at all? | A daily census of every tokenised asset in the RWA map: a wrapper that trades, priced but not traded, or listed only, and what changed since the day before. On 2026-09-22, 526 of 791 had no wrapper with reported trading. | Real-world assets (`/intel/rwa`), RWA universe coverage |
| Who holds the value? | Issuer concentration (HHI, effective number of issuers, top-five share) and the chains wrappers are deployed on, with value attributed to a chain only for single-chain tokens. | Structure figures (`/intel/structure`) |
| Who is the issuer, legally? | Token to legal entity only through dated evidence from GLEIF, SEC EDGAR and OFAC, never by name similarity. The underlying company of a tokenised stock with its latest filings, and advertised yield beside NAV-implied yield. | Structure figures, issuer and registrant sections |
| Could I get out? | Days a position takes to sell at a chosen share of daily volume, computed twice: through the on-chain pools whose other leg can be valued, and across all venues CoinMarketCap reports. Missing data is a stated reason, never zero days. | Structure figures, on-chain depth, "Exit capacity" |

Every figure carries a receipt: endpoint, parameters, live call or cache, HTTP status, credits charged as CoinMarketCap reported them, and cache age. A live receipt includes a `curl` line that reproduces the call with your own key.

## RWA endpoints used

All calls go through one reviewed registry (`production-source/supabase/functions/_shared/market-assets/cmc-capabilities.ts`) and one transport (`cmc-transport.ts` beside it).

| Endpoint | What it feeds |
|---|---|
| `/v5/real-world-assets/map` | The RWA universe by asset type (7,811 assets on 2026-09-20, 791 with tokens) and the daily tradability census |
| `/v5/real-world-assets/assets/list` | Listings with tokenised price, value and 24-hour volume |
| `/v5/real-world-assets/info` | Asset profiles, including the underlying company's SEC `cik` |
| `/v5/real-world-assets/quotes/latest` | Every wrapper of an asset, with its issuer: the input to wrapper premiums and picks |
| `/v1/dex/token/pools` | DEX pools for each wrapper deployment: on-chain depth and exit capacity |
| `/v2/cryptocurrency/info` | Wrapper contract deployments per chain |
| `/v2/cryptocurrency/ohlcv/historical` | Daily closes for the reconstructed part of the premium history |
| `/v1/key/info` | Plan and credit headroom, checked before any paid call |

The other endpoints the product calls (markets, derivatives, DEX lanes) are listed in the [appendix](#appendix-other-coinmarketcap-endpoints).

## One real call, with the code that made it

A production `rwaQuotes` call on 2026-09-22 (HTTP 200, 1 credit). The wrapper-premium lane asks for quotes on the assets it is pricing, in `production-source/supabase/functions/_shared/intel/capture-rwa-wrappers.ts` line 411:

```ts
const quotes = await deps.request('rwaQuotes', { rwa_id: candidates.join(',') }, ctx).catch(() => null)
```

`deps.request` is `requestCmc`. After the registry, plan, cache and credit-reservation checks, the request goes out in `production-source/supabase/functions/_shared/market-assets/cmc-transport.ts` lines 232 to 233:

```ts
const res=await fetch(`${BASE}${spec.path}${post?'':`?${query}`}`,{method:post?'POST':'GET',headers:{'X-CMC_PRO_API_KEY':key,Accept:'application/json',...(post?{'Content-Type':'application/json'}:{})},
  ...(post?{body:JSON.stringify(cmcRequestBody(name,params))}:{}),signal:AbortSignal.timeout(8000),redirect:'error'})
```

The response for `rwa_id=2` (Nvidia Corp), trimmed to three of its seven wrapper tokens; every value is as returned:

```json
{
  "status": { "timestamp": "2026-09-22T15:52:16.348Z", "error_code": "0", "error_message": "", "elapsed": 6, "credit_count": 1 },
  "data": {
    "rwa_assets": [
      {
        "rwa_id": 2, "name": "Nvidia Corp", "symbol": "NVDA", "slug": "nvidia",
        "quotes": [
          { "symbol": "USD", "crypto_id": 2781, "last_updated": "2026-09-22T15:50:59.000Z",
            "average_tokenized_price": 228.42255152377902, "tokenized_market_cap": 137247587.75463033, "tokenized_volume_24h": 162232707.3301628 }
        ],
        "tokens": [
          { "name": "NVIDIA tokenized stock (xStock)", "symbol": "NVDAX", "crypto_id": 36992,
            "issuer_id": "6878977dcbbf471de3366e85", "issuer_name": "Backed Assets",
            "price": 228.67674073899389, "market_cap": 42015407.81, "volume_24h": 38764552.78915782 },
          { "name": "NVIDIA tokenized stock (Dinari)", "symbol": "NVDA.D", "crypto_id": 28616,
            "issuer_id": "688c6172abae9b5b9fb30359", "issuer_name": "Dinari Assets",
            "price": null, "market_cap": null, "volume_24h": null },
          { "name": "NVIDIA Tokenized Stock (Ondo)", "symbol": "NVDAon", "crypto_id": 38093,
            "issuer_id": "688ca4ccabae9b5b9fb3167a", "issuer_name": "Ondo Assets",
            "price": 228.72293725652068, "market_cap": 38684494.49, "volume_24h": 3248853.39948144 }
        ]
      }
    ]
  }
}
```

One call returns every wrapper of the asset with its issuer. Against CMC's own `average_tokenized_price` here, xStock sits 11.1 bp above and Ondo 13.2 bp above. The Dinari wrapper has no price, so it is labelled `no_price`: it stays on the page, is kept out of the anchor, and is never counted as zero. [`docs/real-api-call.md`](docs/real-api-call.md) has the call's metadata, the credit reconciliation and a `curl` line to reproduce it with your own key.

## Check it yourself

Every push runs the [test workflow](.github/workflows/test.yml) offline, with no secrets and no CoinMarketCap call: `npm ci`, `npm test` (26 demo tests in fixture mode), `npm run build`, and the standalone production-source Deno tests (475 tests, listed in `production-source/standalone-tests.txt`) without network permission. The same commands work locally with Node.js 24 and Deno 2:

```bash
npm ci
npm test
deno test --allow-read --allow-env --no-check $(cat production-source/standalone-tests.txt)
```

`--no-check` runs the tests without a TypeScript type-check pass, the same way the private repository runs these modules' tests.

## Links

| | |
|---|---|
| Live demo | https://thecontentforge.io/intel/demo (start here; it opens a demo session with no account) |
| Live product | https://thecontentforge.io/intel (free account, no card: https://thecontentforge.io/intel/signup?plan=free) |
| RWA workspace | https://thecontentforge.io/intel/rwa and https://thecontentforge.io/intel/rwa/wrappers (inside a demo session or with a free account) |
| Demo video | https://www.youtube.com/watch?v=DUn6vZ0KKQg |
| DoraHacks BUIDL | https://dorahacks.io/buidl/49075 |

Also in the product: CSV export of each table (provider figures are left blank unless the data licence allows export), and a hosted MCP server with 28 grounded read tools covering all of the above, with scoped, revocable tokens and human-approved writes.

## What is in this repository

| Folder | What it is | How to check it |
|---|---|---|
| `production-source/` | The Investor Intel source under its original paths, with its real development history (`git log -- production-source`). Inside it, a standalone subset runs on its own: the production modules behind the live RWA lane and the CMC transport (wrapper premiums, best-wrapper picks, premium history, on-chain depth and exit capacity, daily universe coverage and issuer concentration, issuers and underlying SEC registrants, yield against NAV, the capability registry, credit reservation and receipts). | `deno test --allow-read --allow-env --no-check $(cat production-source/standalone-tests.txt)` (475 tests, no key, no network permission) |
| everything else | A runnable local demo: three investigations (asset notebook, RWA and issuers, market structure) that run on fixtures with no key, on CoinMarketCap's keyless API, or on your own key. | `npm ci`, `npm test`, `npm run dev` (see Quick start) |
| `docs/real-api-call.md` | One real production call to `/v5/real-world-assets/quotes/latest`: the code that made it and the response. | |
| `evidence/recorded-cmc-calls/` | Recorded keyless probes, with provider status objects kept verbatim, refusals included. | |
| `.github/workflows/test.yml` | The offline test workflow described above. | |

`production-source/` holds all of Investor Intel: the React frontend (`src/intel`), every Intel Edge Function, the shared Intel and market-asset modules, the Intel migrations and the Intel translations. Its git history is the real history of those paths in the private repository, from the first commit on 2026-05-08 (see [`docs/build-timeline.md`](docs/build-timeline.md) for how it was published).

The standalone subset listed in `production-source/standalone-tests.txt` imports only other modules in that subset, which is why its tests run on their own. The rest of Investor Intel imports the parent platform (authentication, the Supabase client and shared helpers), which is not included, so it is there to read rather than to run. The product itself runs on Supabase (Postgres and Deno Edge Functions), with React on Netlify.

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

Investor Intel has been part of TheContentForge since June 2026 (narrative radar and signals). Before the event, the product had a narrow v1 listing and global-metrics adapter (`coinmarketcap-provider.ts`) and v2 quote and map price helpers; both are in `production-source/` and in its history. **The hackathon CMC integration was built during the event: its first commit was 2026-09-14, after submissions opened on 2026-09-09.** That covers the capability registry, credit reservation and receipts, the v3 and v5 consumers, the whole RWA lane (universe, wrappers, depth, issuers, underlyings, yield) and the DEX lanes. The history shows it: `git log --since=2026-09-09 -- production-source/supabase/functions/_shared/market-assets`. The runnable demo was also written for the event. The shared chart code it reuses contains both older and changed code, so including it is not a claim that every line is new. [`docs/build-timeline.md`](docs/build-timeline.md) records the build by day.

## Licence

Copyright 2026 TheContentForge. All rights reserved. This repository is public so the hackathon judges and CoinMarketCap can read, clone and run it. No licence to reuse, modify or redistribute it is granted. CoinMarketCap may feature and showcase the entry under the hackathon rules. Third-party files keep their own licences: TradingView Lightweight Charts (Apache-2.0, `product/src/intel/vendor/` and `production-source/src/intel/vendor/`) and the bundled fonts (SIL OFL 1.1, `public/fonts/`, `public/vsx-fonts/`). CoinMarketCap data is not covered by any licence here. Data provided by CoinMarketCap.com.

No API key is committed. The demo reads `CMC_API_KEY` from a local `.env` that `.gitignore` excludes, and the packaging script refuses to build if any file contains a key-shaped string.

# Quick start

Install Node.js 24 or later, then from the repository root:

```bash
npm ci
npm test
npm run dev
```

Open http://127.0.0.1:5187. The demo has three modes, set in a local `.env` (copy `.env.example`):

| Mode | `.env` | What you see |
|---|---|---|
| Fixture (default) | nothing | All three investigations on labelled synthetic data. No key, no network. |
| **Live, with your own key** | `CMC_MODE=live`, `CMC_API_KEY=<your key>` and, for a hackathon Startup key, `CMC_VERIFIED_PLAN=startup` | **Real RWA listings, profiles, quotes and issuers** from `/v5/real-world-assets/*`, plus live quotes, OHLCV (Startup) and derivatives. The server spends at most 20 credits a month by default (`CMC_DEMO_CREDIT_LIMIT`) and never sends the key to the browser. |
| Keyless | `CMC_MODE=keyless` | CoinMarketCap's anonymous public API, no key at all. It does not cover the RWA family, and the shared pool refuses bursts (HTTP 429). Caveat, verbatim: keyless commercial terms are unstated; keep it to the demo until reviewed. |

The standalone production modules have their own tests (Deno 2):

```bash
deno test --allow-read --allow-env --no-check $(cat production-source/standalone-tests.txt)
```

## More detail

- [`docs/real-api-call.md`](docs/real-api-call.md): a real production call, the code that made it and the response
- [`docs/build-timeline.md`](docs/build-timeline.md): when the CoinMarketCap work was built, by day
- [`docs/demo-guide.md`](docs/demo-guide.md): modes, credit guard, tests, what the demo leaves out, and how this repository is packaged
- [`docs/keyless-demo-mode.md`](docs/keyless-demo-mode.md): keyless probe logs

## Appendix: other CoinMarketCap endpoints

These, with the RWA endpoints above, are every endpoint the production product called in the 24 hours before 2026-09-22 18:00 UTC, taken from its shared response cache. They serve the product's market, derivatives and DEX pages, not the RWA lane.

**Markets, charts and structure:**
`/v3/cryptocurrency/listings/latest`, `/v3/cryptocurrency/quotes/latest`, `/v1/cryptocurrency/listings/historical`, `/v1/cryptocurrency/listings/new`, `/v1/cryptocurrency/categories`, `/v1/cryptocurrency/category`, `/v1/cryptocurrency/trending/latest`, `/v1/cryptocurrency/trending/gainers-losers`, `/v1/cryptocurrency/trending/most-visited`, `/v1/cryptocurrency/airdrops`, `/v1/global-metrics/quotes/latest`, `/v3/fear-and-greed/latest`, `/v1/altcoin-season-index/latest`, `/v3/index/cmc100-latest`, `/v3/index/cmc20-latest`, `/v2/tools/price-conversion`, `/v1/exchange/map`, `/v1/exchange/assets`

**Derivatives:**
`/v5/exchange/derivatives/list`, `/v5/cryptocurrency/derivatives/market-pairs/list/latest`, `/v5/derivatives/liquidations/cryptocurrency/list/latest`

**DEX and on-chain:**
`/v1/k-line/candles`, `/v1/dex/tokens/batch-query`, `/v1/dex/token/price/batch`, `/v1/dex/security/detail`, `/v1/dex/holders/count`, `/v1/dex/meme/list`
