-- CoinGecko API ID usd-coin identifies the same Circle-issued asset as CMC UCID 3408.
-- Verified https://www.coingecko.com/en/coins/usdc and https://coinmarketcap.com/currencies/usd-coin/ on 2026-09-10.
-- Reviewed Circle mainnet addresses and CMC UCID 3408, 2026-09-10.
-- https://developers.circle.com/stablecoins/usdc-contract-addresses
-- No ticker matching and no mapping from user-editable holding metadata.
CREATE OR REPLACE FUNCTION app_private.intel_issuer_market_keys(p_key text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path='' AS $function$
 SELECT CASE WHEN p_key IN ('eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','eip155:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831','eip155:43114:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e','eip155:10:0x0b2c639c533813f4aa9d7837caf62653d097ff85','eip155:137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') THEN ARRAY['market:coinmarketcap:3408','market:cmc:3408','market:coingecko:usd-coin','market:cg:usd-coin'] ELSE '{}'::text[] END
$function$;
REVOKE ALL ON FUNCTION app_private.intel_issuer_market_keys(text) FROM PUBLIC,anon,authenticated;

