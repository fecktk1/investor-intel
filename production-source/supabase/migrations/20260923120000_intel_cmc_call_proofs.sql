-- Investor Intel: the proof a scheduled CoinMarketCap capture call leaves behind.
--
-- A capture receipt (the capture_receipts read view, source-receipt.ts) is read
-- later from provider_call_logs, which keeps the endpoint, status and credit
-- count of each call but no request parameters and no response body. So a
-- capture receipt could not show the call to reproduce or what CoinMarketCap
-- actually returned. From this migration on, the transport (cmc-transport.ts,
-- recordCaptureProof) writes that proof for every call a scheduled capture lane
-- (caller intel-capture-*) makes:
--
--   * the request it sent: capability, path and the canonical parameters
--     (never the key: the key travels in a request header and is never stored);
--   * the provider's own status fields: timestamp, error_code, credit_count;
--   * a bounded, trimmed JSON excerpt of the body (the status block and the
--     first rows of the data member, each cut list named with its real total,
--     long text shortened), never the whole payload.
--
-- One row per caller and endpoint, overwritten by each run, so the table holds
-- a few dozen rows and never a history. Readers' own calls do not write here:
-- their body is already the shared response cache row.
--
-- Service role only: RLS on with no policy, and no grants to anon or
-- authenticated (REVOKE FROM PUBLIC alone does not remove Supabase's default
-- grants, so each role is named).

CREATE TABLE IF NOT EXISTS public.intel_cmc_call_proofs (
  caller          text NOT NULL CHECK (caller LIKE 'intel-capture-%' AND length(caller) <= 120),
  endpoint        text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 200),
  capability      text NOT NULL CHECK (length(capability) BETWEEN 1 AND 60),
  request         jsonb NOT NULL,
  http_status     integer,
  credit_count    numeric CHECK (credit_count IS NULL OR credit_count >= 0),
  error_code      text CHECK (error_code IS NULL OR length(error_code) <= 40),
  responded_at    timestamptz,
  retrieved_at    timestamptz,
  excerpt         jsonb,
  excerpt_missing text CHECK (excerpt_missing IS NULL OR excerpt_missing IN ('failure_body_not_kept', 'body_not_json', 'not_recorded', 'withheld')),
  key_mode        text NOT NULL DEFAULT 'keyed' CHECK (key_mode IN ('keyed', 'keyless')),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, endpoint),
  CONSTRAINT intel_cmc_call_proofs_request_shape CHECK (jsonb_typeof(request) = 'object' AND pg_column_size(request) <= 4096),
  CONSTRAINT intel_cmc_call_proofs_excerpt_size CHECK (excerpt IS NULL OR (jsonb_typeof(excerpt) = 'object' AND pg_column_size(excerpt) <= 16384))
);

ALTER TABLE public.intel_cmc_call_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_cmc_call_proofs FROM PUBLIC;
REVOKE ALL ON public.intel_cmc_call_proofs FROM anon;
REVOKE ALL ON public.intel_cmc_call_proofs FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.intel_cmc_call_proofs TO service_role;

COMMENT ON TABLE public.intel_cmc_call_proofs IS
  'Investor Intel: the request and a bounded trimmed response excerpt of the newest call per scheduled CoinMarketCap capture caller and endpoint, shown on capture receipts. Overwritten each run; no history. Service role only.';
