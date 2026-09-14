-- Keep Solana base58 identities case-sensitive and cover the full registered EVM set.
-- No historical ledger or holdings rows are rewritten.
SET lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.canonical_asset_key(p_chain text, p_native_symbol text, p_address text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_chain text := lower(trim(coalesce(p_chain, '')));
  v_addr  text := trim(coalesce(p_address, ''));
  v_evm   int;
  v_ns    text;
  v_sym   text;
BEGIN
  IF v_chain = '' THEN RETURN NULL; END IF;

  -- EVM chainId map (eip155 namespace). Sei + Hyperliquid are treated as EVM
  -- (HyperEVM / Sei-EVM) for the portfolio tracker.
  v_evm := CASE v_chain
    WHEN 'ethereum' THEN 1     WHEN 'base'       THEN 8453   WHEN 'arbitrum' THEN 42161
    WHEN 'optimism' THEN 10    WHEN 'bnb'        THEN 56     WHEN 'polygon'  THEN 137
    WHEN 'avalanche' THEN 43114 WHEN 'hyperliquid' THEN 999  WHEN 'sei'      THEN 1329
    WHEN 'sonic'    THEN 146   WHEN 'metis'      THEN 1088   WHEN 'linea'    THEN 59144
    WHEN 'scroll'   THEN 534352 WHEN 'mantle'    THEN 5000   WHEN 'gnosis'   THEN 100
    WHEN 'celo'     THEN 42220 WHEN 'zksync'     THEN 324    WHEN 'blast'    THEN 81457
    WHEN 'opbnb'    THEN 204
    WHEN 'taiko' THEN 167000 WHEN 'xdc' THEN 50 WHEN 'moonbeam' THEN 1284 WHEN 'moonriver' THEN 1285
    ELSE NULL END;

  -- WSOL -> native SOL merge (belt-and-suspenders on top of Helius solMode merged)
  IF v_chain = 'solana'
     AND v_addr = 'So11111111111111111111111111111111111111112' THEN
    RETURN 'solana:native:SOL';
  END IF;

  -- Token (has a contract/mint)
  IF v_addr <> '' THEN
    IF v_evm IS NOT NULL THEN
      RETURN 'eip155:' || v_evm::text || ':' || lower(v_addr);
    END IF;
    -- non-EVM: namespace is the chain id except Bitcoin (bip122)
    v_ns := CASE v_chain WHEN 'bitcoin' THEN 'bip122' ELSE v_chain END;
    RETURN v_ns || ':' || v_addr;        -- case-preserved (base58 / typed ids)
  END IF;

  -- Native
  IF v_evm IS NOT NULL THEN
    RETURN 'eip155:' || v_evm::text || ':native';
  END IF;

  v_sym := upper(nullif(trim(coalesce(p_native_symbol, '')), ''));
  IF v_sym IS NULL THEN
    v_sym := CASE v_chain
      WHEN 'solana' THEN 'SOL'  WHEN 'sui'    THEN 'SUI'  WHEN 'aptos' THEN 'APT'
      WHEN 'bitcoin' THEN 'BTC' WHEN 'tron'   THEN 'TRX'  WHEN 'injective' THEN 'INJ'
      WHEN 'near'   THEN 'NEAR' WHEN 'ton'    THEN 'TON'  WHEN 'xrpl'  THEN 'XRP'
      WHEN 'zcash'  THEN 'ZEC'  WHEN 'stellar' THEN 'XLM'
      ELSE upper(v_chain) END;
  END IF;
  v_ns := CASE v_chain WHEN 'bitcoin' THEN 'bip122' ELSE v_chain END;
  RETURN v_ns || ':native:' || v_sym;
END; $function$;
