# Evidence of a real API call

One real call from the production RWA lane, with the code that made it and the response that came back. It was recorded on 2026-09-22 from the shared response cache in production. The response is trimmed to three of its seven wrapper tokens; nothing else was changed.

## The call

Capability `rwaQuotes`, endpoint `GET /v5/real-world-assets/quotes/latest`, parameters `rwa_id=2` (Nvidia Corp).

| Field | Value |
|---|---|
| HTTP status | 200 |
| Fetched at | 2026-09-22 15:52:16 UTC |
| Provider observation time (`last_updated`) | 2026-09-22 15:50:59 UTC |
| `status.credit_count` (charged, as reported by CMC) | 1 |
| `status.elapsed` | 6 ms |

## The code that made it

The wrapper-premium lane asks for quotes on the assets it is pricing
(`production-source/supabase/functions/_shared/intel/capture-rwa-wrappers.ts`, line 411):

```ts
const quotes = await deps.request('rwaQuotes', { rwa_id: candidates.join(',') }, ctx).catch(() => null)
```

`deps.request` is `requestCmc` in `production-source/supabase/functions/_shared/market-assets/cmc-transport.ts`. Before any request goes out, it looks the capability up in a reviewed registry (`cmc-capabilities.ts`, line 75), checks the plan allows it, checks the shared cache, and reserves the estimated credits in the database. Only then does it make the call (lines 231 to 232):

```ts
const res=await fetch(`${BASE}${spec.path}${post?'':`?${query}`}`,{method:post?'POST':'GET',headers:{'X-CMC_PRO_API_KEY':key,Accept:'application/json',...(post?{'Content-Type':'application/json'}:{})},
  ...(post?{body:JSON.stringify(cmcRequestBody(name,params))}:{}),signal:AbortSignal.timeout(8000),redirect:'error'})
```

After the response arrives, the transport reconciles the reservation against the provider's own `status.credit_count` (line 251) and writes a receipt. That receipt (capability, endpoint, parameters, HTTP status, credits, elapsed time, cache age) is what the product shows next to each figure.

The key is read from the server environment and travels only in the request header. It never appears in a response, a receipt, a log or this repository.

## The response (trimmed)

```json
{
  "status": {
    "timestamp": "2026-09-22T15:52:16.348Z",
    "error_code": "0",
    "error_message": "",
    "elapsed": 6,
    "credit_count": 1
  },
  "data": {
    "rwa_assets": [
      {
        "rwa_id": 2,
        "name": "Nvidia Corp",
        "symbol": "NVDA",
        "slug": "nvidia",
        "quotes": [
          {
            "symbol": "USD",
            "crypto_id": 2781,
            "last_updated": "2026-09-22T15:50:59.000Z",
            "average_tokenized_price": 228.42255152377902,
            "tokenized_market_cap": 137247587.75463033,
            "tokenized_volume_24h": 162232707.3301628
          }
        ],
        "tokens": [
          {
            "name": "NVIDIA tokenized stock (xStock)",
            "symbol": "NVDAX",
            "crypto_id": 36992,
            "issuer_id": "6878977dcbbf471de3366e85",
            "issuer_name": "Backed Assets",
            "price": 228.67674073899389,
            "market_cap": 42015407.81,
            "volume_24h": 38764552.78915782
          },
          {
            "name": "NVIDIA tokenized stock (Dinari)",
            "symbol": "NVDA.D",
            "crypto_id": 28616,
            "issuer_id": "688c6172abae9b5b9fb30359",
            "issuer_name": "Dinari Assets",
            "price": null,
            "market_cap": null,
            "volume_24h": null
          },
          {
            "name": "NVIDIA Tokenized Stock (Ondo)",
            "symbol": "NVDAon",
            "crypto_id": 38093,
            "issuer_id": "688ca4ccabae9b5b9fb3167a",
            "issuer_name": "Ondo Assets",
            "price": 228.72293725652068,
            "market_cap": 38684494.49,
            "volume_24h": 3248853.39948144
          }
        ]
      }
    ]
  }
}
```

## What the product does with it

One call returns every wrapper of one asset, along with each wrapper's issuer. The wrapper page (`/intel/rwa/wrappers`) measures each wrapper against an anchor and shows the premium or discount in basis points. The anchor is the volume-weighted median of the wrappers that pass a liquidity floor, or a fresh published NAV where a fund has one (`rwa-wrapper-spread.ts`). For comparison, against CMC's own `average_tokenized_price` in this response, xStock sits 11.1 bp above and Ondo 13.2 bp above. The Dinari wrapper has no price, so it is labelled `no_price`: it stays on the page but is kept out of the anchor and never counted as zero. The `issuer_id` on each token starts the issuer lane, which reads SEC EDGAR, GLEIF and OFAC (`capture-rwa-issuer.ts`, `rwa-sources/`).

## Reproduce it

With your own key, from any shell:

```bash
curl -s -H "X-CMC_PRO_API_KEY: $CMC_API_KEY" "https://pro-api.coinmarketcap.com/v5/real-world-assets/quotes/latest?rwa_id=2"
```

The runnable demo in this repository makes the same call in live mode (`CMC_MODE=live`, see the README). Its fixture mode makes no calls at all.

A second, keyless artefact is in `evidence/recorded-cmc-calls/`. It records probes against CoinMarketCap's anonymous public API, including the refusals, with each provider status object kept verbatim.
