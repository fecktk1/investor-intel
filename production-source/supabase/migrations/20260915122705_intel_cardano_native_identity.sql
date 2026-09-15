-- Cardano native identity (CMC plan Stage 4, proposal 31, follow-up found by the
-- release re-test on 2026-09-15).
--
-- 20260915034247_intel_long_tail_chains added 'cardano' to the on-demand chain
-- array and the shared registry names its native asset ADA, but the two SQL
-- identity functions kept their own chain tables: canonical_asset_key fell
-- through to upper(chain) and answered 'cardano:native:CARDANO', and the manual
-- asset validator refused Cardano outright ('Choose a supported network').
-- scripts/test-intel-manual-asset.mjs walks the registry and caught the first.
--
-- Both functions are restated from their live definitions (md5 guarded below)
-- with exactly one addition each: the Cardano row. Nothing else changes.

DO $$
DECLARE k text; v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO k FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='canonical_asset_key';
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='intel_validate_manual_asset_identity';
  -- Production carries the text the dashboard editor saved (CRLF, md5 79daaa2d... and 0c843b07...);
  -- a test database builds the same functions from the migration files (LF). The lineage is checked
  -- structurally so both pass and any other definition stops here for review.
  IF k IS NOT NULL AND (k NOT LIKE '%WHEN ''zcash''  THEN ''ZEC''  WHEN ''stellar'' THEN ''XLM''%' OR k NOT LIKE '%WHEN ''taiko'' THEN 167000 WHEN ''xdc'' THEN 50 WHEN ''moonbeam'' THEN 1284 WHEN ''moonriver'' THEN 1285%')
    THEN RAISE EXCEPTION 'canonical_asset_key differs from the reviewed definition; review before applying'; END IF;
  IF v IS NOT NULL AND (v NOT LIKE '%(''moonriver'',''MOVR'',''eip155'',1285)%' OR v NOT LIKE '%Native asset mismatch; tokens require a contract or mint%')
    THEN RAISE EXCEPTION 'intel_validate_manual_asset_identity differs from the reviewed definition; review before applying'; END IF;
END $$;

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
      WHEN 'zcash'  THEN 'ZEC'  WHEN 'stellar' THEN 'XLM' WHEN 'cardano' THEN 'ADA'
      ELSE upper(v_chain) END;
  END IF;
  v_ns := CASE v_chain WHEN 'bitcoin' THEN 'bip122' ELSE v_chain END;
  RETURN v_ns || ':native:' || v_sym;
END; $function$;

CREATE OR REPLACE FUNCTION public.intel_validate_manual_asset_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE native_symbol text; ns text; evm_id integer; addr text; sym text; kind text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id=NEW.source_id AND s.source_type='manual') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.chain IS NOT DISTINCT FROM OLD.chain
  AND NEW.asset_symbol IS NOT DISTINCT FROM OLD.asset_symbol
  AND NEW.contract_address IS NOT DISTINCT FROM OLD.contract_address
  AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
  AND NEW.raw_metadata->>'manual_asset_kind' IS NOT DISTINCT FROM OLD.raw_metadata->>'manual_asset_kind'
 THEN NEW.canonical_asset_key:=OLD.canonical_asset_key; RETURN NEW; END IF;
 SELECT r.symbol,r.namespace,r.evm INTO native_symbol,ns,evm_id FROM (VALUES
    ('solana','SOL','solana',NULL),
    ('ethereum','ETH','eip155',1),
    ('base','ETH','eip155',8453),
    ('arbitrum','ETH','eip155',42161),
    ('optimism','ETH','eip155',10),
    ('bnb','BNB','eip155',56),
    ('polygon','POL','eip155',137),
    ('avalanche','AVAX','eip155',43114),
    ('hyperliquid','HYPE','hyperliquid',999),
    ('sei','SEI','sei',1329),
    ('sonic','S','eip155',146),
    ('metis','METIS','eip155',1088),
    ('linea','ETH','eip155',59144),
    ('scroll','ETH','eip155',534352),
    ('mantle','MNT','eip155',5000),
    ('gnosis','XDAI','eip155',100),
    ('celo','CELO','eip155',42220),
    ('zksync','ETH','eip155',324),
    ('blast','ETH','eip155',81457),
    ('opbnb','BNB','eip155',204),
    ('sui','SUI','sui',NULL),
    ('aptos','APT','aptos',NULL),
    ('bitcoin','BTC','bip122',NULL),
    ('tron','TRX','tron',NULL),
    ('injective','INJ','injective',NULL),
    ('stellar','XLM','stellar',NULL),
    ('near','NEAR','near',NULL),
    ('ton','TON','ton',NULL),
    ('xrpl','XRP','xrpl',NULL),
    ('zcash','ZEC','zcash',NULL),
    ('taiko','ETH','eip155',167000),
    ('xdc','XDC','eip155',50),
    ('moonbeam','GLMR','eip155',1284),
    ('moonriver','MOVR','eip155',1285),
    ('cardano','ADA','cardano',NULL)
 ) r(chain,symbol,namespace,evm) WHERE r.chain=NEW.chain;
 IF native_symbol IS NULL THEN RAISE EXCEPTION 'Choose a supported network' USING ERRCODE='23514'; END IF;
 addr:=trim(coalesce(NEW.contract_address,'')); sym:=upper(trim(coalesce(NEW.asset_symbol,'')));
 kind:=coalesce(nullif(NEW.raw_metadata->>'manual_asset_kind',''),CASE WHEN addr='' THEN 'native' ELSE 'token' END);
 IF kind NOT IN ('native','token') THEN RAISE EXCEPTION 'Choose native asset or token' USING ERRCODE='23514'; END IF;
 IF kind='native' THEN
   IF addr<>'' OR sym<>native_symbol THEN RAISE EXCEPTION 'Native asset mismatch; tokens require a contract or mint' USING ERRCODE='23514'; END IF;
 ELSE
   IF addr='' OR length(addr)>240 OR addr~'[[:space:]]' THEN RAISE EXCEPTION 'Enter a token contract or mint' USING ERRCODE='23514'; END IF;
   IF evm_id IS NOT NULL AND addr!~*'^0x[0-9a-f]{40}$' THEN RAISE EXCEPTION 'Invalid EVM token contract' USING ERRCODE='23514'; END IF;
   IF NEW.chain='solana' AND addr!~'^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN RAISE EXCEPTION 'Invalid Solana mint address' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.asset_symbol:=sym; NEW.normalized_symbol:=sym;
 NEW.contract_address:=CASE WHEN addr='' THEN NULL WHEN evm_id IS NOT NULL THEN lower(addr) ELSE addr END;
 NEW.canonical_asset_key:=CASE
   WHEN NEW.chain='solana' AND addr='So11111111111111111111111111111111111111112' THEN 'solana:native:SOL'
   WHEN evm_id IS NOT NULL THEN 'eip155:'||evm_id::text||':'||CASE WHEN addr='' THEN 'native' ELSE lower(addr) END
   WHEN addr='' THEN ns||':native:'||native_symbol ELSE ns||':'||addr END;
 RETURN NEW;
END;
$function$;
