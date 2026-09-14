-- Validate newly authored manual identities before ledger recomputation.
-- Existing transactions and imported provider records are preserved.
SET lock_timeout='5s';
SET statement_timeout='60s';
CREATE OR REPLACE FUNCTION public.intel_validate_manual_asset_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $function$
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
    ('moonriver','MOVR','eip155',1285)
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
REVOKE ALL ON FUNCTION public.intel_validate_manual_asset_identity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zzz_intel_manual_asset_identity BEFORE INSERT OR UPDATE
ON public.investor_portfolio_transactions FOR EACH ROW EXECUTE FUNCTION public.intel_validate_manual_asset_identity();
