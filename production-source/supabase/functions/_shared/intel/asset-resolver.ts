// Investor Intel — universal contract resolver.
//
// One entry point for "the user pasted something; what asset is it and where do
// we send them?". detectIdentifier() decides the format; this module walks a
// fixed ladder of sources, records what each one answered, and returns either a
// single identity, a chain chooser, or an honest "valid address, nothing
// answered" — never a fabricated identity and never a dead end.
//
// The ladder, in order:
//   1 catalogue      market_assets.platforms         (already-known asset, no provider call)
//   2 entities       org-scoped entities row         (the org already tracks it)
//   3 memecoin       memecoin_latest_tokens          (recent DEX snapshot we already hold)
//   4 cmc_metadata   CMC /v2/cryptocurrency/info     (canonical id + EVERY deployment)
//   5 cmc_dex        CMC /v1/dex/token               (four verified DEX platforms only)
//   6 dexscreener    token-pairs / multichain search (also resolves EVM chain ambiguity)
//   7 geckoterminal  token info                      (logo / description)
//   8 birdeye        token metadata                  (symbol / name / logo / decimals)
//   9 rpc            eth_call, getAccountInfo or a   (last resort: the chain itself)
//                    per-namespace adapter
//
// Step 9 covers EVM (a batched eth_call for name/symbol/decimals/totalSupply)
// and Solana (getAccountInfo) inline; TON, Tron, XRPL, Stellar, NEAR, Cardano
// and Injective are one module each under rpc-adapters/. A namespace with no
// adapter is `no_rpc_adapter`: a skipped step with a reason, never a guess.
//
// Steps never throw: each appends { step, outcome, ms, detail? } to provenance.
// The ladder stops as soon as an identity carries symbol AND name and at least
// one market source answered — except that step 4 always runs once for a
// namespace CoinMarketCap lists, so the canonical id and the full deployment set
// are known even when a cheaper source already answered.
//
// A chain that answers with a complete identity while no market source does is
// reported as `identity_only`, not `resolved`: the asset is real, searchable and
// indexed, and nothing on the platform prices it. That is the honest end state
// for the long tail — the namespaces with an RPC adapter and no market provider.
//
// Demand is recorded once per resolved asset. Who searched is never stored.
//
// A resolved asset is then indexed: the first successful resolution by anyone
// creates the shared market_assets record and puts the asset on the demand
// cadence (see on-demand-index.ts). That step is recorded as a tenth provenance
// entry, `index`, which exists only in the server result — the nine ladder steps
// are the ladder.

import { CHAIN_PROVIDERS, CHAINS, getChain } from '../chains.ts'
import { indexResolvedAsset as indexResolvedAssetLive } from './on-demand-index.ts'
import { normalizeEntity } from '../entity-resolver.ts'
import { marketChain, marketPlatformSlugs } from './market-read-quality.ts'
import { CMC_DEX_NETWORKS } from '../market-assets/cmc-dex.ts'
import { requestCmc as requestCmcLive } from '../market-assets/cmc-transport.ts'
import { searchTokens as searchTokensLive, getTokenPairs as getTokenPairsLive } from '../memecoin/dexscreener.ts'
import { getTokenInfo as getTokenInfoLive } from '../memecoin/geckoterminal.ts'
import { getTokenMetadata as getTokenMetadataLive } from '../birdeye-client.ts'
import { canonicalAddress, detectIdentifier, MAX_IDENTIFIER_LENGTH, type DetectedIdentifier, type IdentifierCandidate } from './asset-identifier.ts'
import { rpcAdapterFor } from './rpc-adapters/index.ts'
import { decodeAbiString, decodeAbiUint } from './rpc-adapters/evm-abi.ts'
import { readBoundedText } from './bounded-request.ts'

// Re-exported from their own module so an adapter can decode TRC-20 returns
// without importing the resolver back. The surface is unchanged.
export { decodeAbiString, decodeAbiUint }

/** The longest identifier any supported namespace produces. */
export const MAX_QUERY_LENGTH = MAX_IDENTIFIER_LENGTH

// ── Contract ─────────────────────────────────────────────────────────────────

export type ResolveStep =
  | 'catalogue' | 'entities' | 'memecoin' | 'cmc_metadata' | 'cmc_dex'
  | 'dexscreener' | 'geckoterminal' | 'birdeye' | 'rpc'
  // Not a ladder step: the record creation that follows a resolved identity.
  | 'index'

export type StepOutcome = 'hit' | 'miss' | 'skipped' | 'error'

export type ProvenanceEntry = { step: ResolveStep; outcome: StepOutcome; ms: number; detail?: string }

export type Deployment = { chain: string | null; address: string; source: string }

export type AssetIdentity = {
  kind: 'cmc' | 'contract'
  provider: 'coinmarketcap' | 'contract'
  providerId: string
  symbol: string | null
  name: string | null
  chain: string | null
  address: string | null
  canonicalKey: string | null
  logoUrl: string | null
  decimals: number | null
  deployments: Deployment[]
  route: string
}

export type ChainCandidate = {
  chain: string
  address: string
  symbol: string | null
  name: string | null
  liquidityUsd: number | null
  route: string
}

/** `identity_only`: the chain answered with an identity and no market source
 *  did. The asset is indexed and searchable; nothing prices it. */
export type ResolveStatus = 'resolved' | 'identity_only' | 'ambiguous' | 'unresolved' | 'invalid' | 'rate_limited'

export type ResolveResult = {
  status: ResolveStatus
  query: string
  kind: string
  identity: AssetIdentity | null
  candidates: ChainCandidate[]
  provenance: ProvenanceEntry[]
  reason: string | null
  demandRecorded: boolean
  /** `inserted` is true only when this resolution created the shared record;
   *  `demanded` is true when the quote snapshot was put on the demand cadence. */
  indexed: { inserted: boolean; demanded: boolean }
}

export type ResolverDeps = {
  requestCmc: typeof requestCmcLive
  searchTokens: typeof searchTokensLive
  getTokenPairs: typeof getTokenPairsLive
  getTokenInfo: typeof getTokenInfoLive
  getTokenMetadata: typeof getTokenMetadataLive
  /** One chain request. `body === null` is a GET (Horizon, the Injective LCD
   *  and toncenter's decoded reads are GET endpoints); anything else is a JSON
   *  POST. Injected so tests never reach a public endpoint. */
  rpcCall: (url: string, body: unknown, timeoutMs: number) => Promise<unknown>
  /** Optional per-adapter endpoint overrides. Reads the function's environment
   *  by default and never throws when the permission is not granted. */
  env: (key: string) => string | undefined
  /** Record creation + quote demand for a resolved identity. */
  indexAsset: typeof indexResolvedAssetLive
  now: () => number
}

export type ResolveInput = {
  query: string
  chain?: string | null
  orgId?: string | null
  userId?: string | null
  // deno-lint-ignore no-explicit-any
  ctx?: any
  deps?: Partial<ResolverDeps>
}

// ── Public RPC endpoints (keyless, last resort only) ─────────────────────────
// Reached only when every catalogue, entity, cache and provider step missed, so
// these carry request volume measured in "a user pasted an unknown contract".
export const PUBLIC_EVM_RPC: Record<string, string> = {
  ethereum: 'https://eth.llamarpc.com',
  base: 'https://mainnet.base.org',
  bnb: 'https://bsc-dataseed.binance.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
  polygon: 'https://polygon-rpc.com',
  avalanche: 'https://api.avax.network/ext/bc/C/rpc',
  gnosis: 'https://rpc.gnosischain.com',
  celo: 'https://forno.celo.org',
  linea: 'https://rpc.linea.build',
  scroll: 'https://rpc.scroll.io',
  mantle: 'https://rpc.mantle.xyz',
  zksync: 'https://mainnet.era.zksync.io',
  blast: 'https://rpc.blast.io',
  sonic: 'https://rpc.soniclabs.com',
  opbnb: 'https://opbnb-mainnet-rpc.bnbchain.org',
  metis: 'https://andromeda.metis.io/?owner=1088',
  moonbeam: 'https://rpc.api.moonbeam.network',
  moonriver: 'https://rpc.api.moonriver.moonbeam.network',
  taiko: 'https://rpc.mainnet.taiko.xyz',
  xdc: 'https://rpc.xinfin.network',
}
export const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
const RPC_TIMEOUT_MS = 4000

/** Namespaces CoinMarketCap lists contracts for. */
const CMC_NAMESPACES = new Set([
  'eip155', 'solana', 'sui', 'aptos', 'ton', 'tron', 'near', 'stellar', 'xrpl', 'cardano', 'injective',
])
// ── Best-effort per-instance rate limit ──────────────────────────────────────
// One Edge isolate only. Documented as best effort: a user spread across several
// isolates can exceed 30/h. It is a brake on a loop, not an entitlement.
export const RESOLUTIONS_PER_HOUR = 30
const WINDOW_MS = 3600_000
const attempts = new Map<string, number[]>()

export function __resetResolverRateLimitForTests(): void { attempts.clear() }

function rateLimited(userId: string | null | undefined, now: number): boolean {
  const key = String(userId || '').trim()
  if (!key) return false
  const recent = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= RESOLUTIONS_PER_HOUR) { attempts.set(key, recent); return true }
  recent.push(now)
  attempts.set(key, recent)
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((t) => now - t < WINDOW_MS)) attempts.delete(k)
  return false
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
  return s ? s.slice(0, 120) : null
}
const numeric = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e || 'unknown')).slice(0, 140)

export function assetRoute(identity: Pick<AssetIdentity, 'kind' | 'providerId' | 'symbol' | 'chain' | 'address'>): string {
  if (identity.kind === 'cmc') {
    return `/intel/markets/${encodeURIComponent(identity.symbol || identity.providerId)}?provider=coinmarketcap&id=${encodeURIComponent(identity.providerId)}`
  }
  // With no confirmed chain the id is the bare address: the contract page still
  // opens and says which chain is unknown, rather than asserting one.
  const address = identity.address || ''
  const id = identity.chain ? `${identity.chain}:${address}` : address
  return `/intel/markets/${encodeURIComponent(identity.symbol || address)}?provider=contract&id=${encodeURIComponent(id)}`
}

function entityKey(chain: string | null, address: string | null, symbol: string | null): string | null {
  if (!chain || !address) return null
  try {
    return normalizeEntity({ kind: 'asset', chain, value: address, symbol: symbol || undefined }).canonical_ref_key
  } catch {
    return null
  }
}

function addressVariants(address: string): string[] {
  const raw = String(address || '').trim()
  return [...new Set([raw, raw.toLowerCase()].filter(Boolean))]
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** A provider's platform label (CoinGecko asset-platform id, CMC platform slug
 *  or CMC platform name) to an app chain id — or null when we do not carry that
 *  chain, which is recorded as a deployment with an unknown chain rather than
 *  being dropped or guessed. */
function appChainForPlatform(platform: unknown): string | null {
  const key = String(platform || '').trim().toLowerCase()
  if (!key) return null
  const direct = marketChain(key)
  if (getChain(direct)) return direct
  for (const def of CHAINS) if (marketPlatformSlugs(def.id).includes(key)) return def.id
  return null
}

// ── Resolver state ───────────────────────────────────────────────────────────

type State = {
  detection: DetectedIdentifier
  candidates: IdentifierCandidate[]
  hinted: boolean
  provenance: ProvenanceEntry[]
  chain: string | null
  address: string | null
  symbol: string | null
  name: string | null
  logoUrl: string | null
  decimals: number | null
  cmcId: string | null
  deployments: Map<string, Deployment>
  marketAnswered: boolean
  ambiguous: ChainCandidate[] | null
  cmcMetadataRan: boolean
}

function addDeployment(state: State, chain: string | null, address: string, source: string): void {
  const value = String(address || '').trim()
  if (!value) return
  const key = `${chain || 'unknown'}:${value.toLowerCase()}`
  if (!state.deployments.has(key)) state.deployments.set(key, { chain, address: value, source })
}

function absorb(state: State, fields: { symbol?: unknown; name?: unknown; logoUrl?: unknown; decimals?: unknown }): void {
  state.symbol ??= text(fields.symbol)
  state.name ??= text(fields.name)
  state.logoUrl ??= text(fields.logoUrl)
  state.decimals ??= numeric(fields.decimals)
}

function candidateChains(state: State): string[] {
  return [...new Set(state.candidates.map((c) => c.chain).filter((c): c is string => !!c))]
}

function selectedChain(state: State): string | null {
  if (state.chain) return state.chain
  const chains = candidateChains(state)
  return chains.length === 1 ? chains[0] : null
}

function sufficient(state: State): boolean {
  return !!state.symbol && !!state.name && state.marketAnswered && !state.ambiguous
}

// ── The ladder ───────────────────────────────────────────────────────────────

export async function resolveAsset(
  // deno-lint-ignore no-explicit-any
  admin: any,
  input: ResolveInput,
): Promise<ResolveResult> {
  const deps: ResolverDeps = {
    requestCmc: requestCmcLive,
    searchTokens: searchTokensLive,
    getTokenPairs: getTokenPairsLive,
    getTokenInfo: getTokenInfoLive,
    getTokenMetadata: getTokenMetadataLive,
    rpcCall: defaultRpcCall,
    env: defaultEnv,
    indexAsset: indexResolvedAssetLive,
    now: () => Date.now(),
    ...(input.deps || {}),
  }
  const rawQuery = typeof input.query === 'string' ? input.query.trim().slice(0, 240) : ''
  const detection = detectIdentifier(input.query, { chainHint: input.chain || null })

  // An unrecognised string never reaches a provider, a cache or the database.
  if (detection.invalid || !detection.candidates.length) {
    return {
      status: 'invalid', query: rawQuery, kind: detection.kind, identity: null, candidates: [],
      provenance: [], reason: detection.invalid || 'unrecognized_identifier', demandRecorded: false, indexed: NOT_INDEXED,
    }
  }

  if (rateLimited(input.userId, deps.now())) {
    return {
      status: 'rate_limited', query: rawQuery, kind: detection.kind, identity: null, candidates: [],
      provenance: [], reason: 'rate_limited', demandRecorded: false, indexed: NOT_INDEXED,
    }
  }

  const state: State = {
    detection,
    candidates: detection.candidates,
    hinted: !!input.chain,
    provenance: [],
    chain: detection.candidates.length === 1 ? detection.candidates[0].chain : null,
    address: detection.kind === 'cmc_id' ? null : detection.candidates[0].address,
    symbol: null, name: null, logoUrl: null, decimals: null, cmcId: null,
    deployments: new Map(), marketAnswered: false, ambiguous: null, cmcMetadataRan: false,
  }
  if (detection.kind === 'cmc_id') state.cmcId = detection.candidates[0].address

  const ladder: { step: ResolveStep; run: () => Promise<{ outcome: StepOutcome; detail?: string }> }[] = [
    { step: 'catalogue', run: () => stepCatalogue(admin, state) },
    { step: 'entities', run: () => stepEntities(admin, state, input.orgId || null) },
    { step: 'memecoin', run: () => stepMemecoin(admin, state) },
    { step: 'cmc_metadata', run: () => stepCmcMetadata(state, deps, input) },
    { step: 'cmc_dex', run: () => stepCmcDex(state, deps, input) },
    { step: 'dexscreener', run: () => stepDexscreener(state, deps, input) },
    { step: 'geckoterminal', run: () => stepGeckoterminal(state, deps, input) },
    { step: 'birdeye', run: () => stepBirdeye(state, deps, input) },
    { step: 'rpc', run: () => stepRpc(state, deps) },
  ]

  for (const entry of ladder) {
    const cmcMandatory = entry.step === 'cmc_metadata' && !state.cmcMetadataRan && cmcListable(state)
    if (sufficient(state) && !cmcMandatory) {
      state.provenance.push({ step: entry.step, outcome: 'skipped', ms: 0, detail: 'sufficient_identity' })
      continue
    }
    const started = deps.now()
    try {
      const outcome = await entry.run()
      state.provenance.push({
        step: entry.step, outcome: outcome.outcome, ms: Math.max(0, deps.now() - started),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      })
    } catch (e) {
      state.provenance.push({ step: entry.step, outcome: 'error', ms: Math.max(0, deps.now() - started), detail: message(e) })
    }
  }

  return await finish(admin, state, rawQuery, deps, input)
}

function cmcListable(state: State): boolean {
  if (state.detection.kind === 'cmc_id') return true
  return state.candidates.some((c) => CMC_NAMESPACES.has(c.namespace))
}

// 1 ── catalogue: an asset we already carry. No provider call.
// deno-lint-ignore no-explicit-any
async function stepCatalogue(admin: any, state: State): Promise<{ outcome: StepOutcome; detail?: string }> {
  if (!admin?.from) return { outcome: 'skipped', detail: 'no_database' }
  const columns = 'source_provider,provider_id,symbol,name,image_url,cached_image_url,platforms,in_current_catalog'

  if (state.detection.kind === 'cmc_id') {
    const { data, error } = await admin.from('market_assets').select(columns)
      .eq('source_provider', 'coinmarketcap').eq('provider_id', state.cmcId).limit(1)
    if (error) return { outcome: 'error', detail: 'catalogue_unavailable' }
    const row = (data || [])[0]
    if (!row) return { outcome: 'miss' }
    applyCatalogueRow(state, row)
    return { outcome: 'hit', detail: `coinmarketcap:${row.provider_id}` }
  }

  const chains = candidateChains(state).slice(0, 24)
  const variants = addressVariants(state.address || '')
  const clauses: string[] = []
  for (const chain of chains) {
    for (const slug of marketPlatformSlugs(chain)) {
      for (const variant of variants) {
        if (clauses.length >= 80) break
        clauses.push(`platforms->>${slug}.eq.${variant}`)
      }
    }
  }
  if (!clauses.length) return { outcome: 'skipped', detail: 'no_platform_keys' }

  const { data, error } = await admin.from('market_assets').select(columns).or(clauses.join(',')).limit(8)
  if (error) return { outcome: 'error', detail: 'catalogue_unavailable' }
  const rows = data || []
  if (!rows.length) return { outcome: 'miss' }
  // deno-lint-ignore no-explicit-any
  const rank = (r: any) => (r.source_provider === 'coinmarketcap' ? (r.in_current_catalog === false ? 1 : 0) : 2)
  // deno-lint-ignore no-explicit-any
  const row = [...rows].sort((a: any, b: any) => rank(a) - rank(b))[0]
  applyCatalogueRow(state, row)
  return { outcome: 'hit', detail: `${row.source_provider}:${row.provider_id}` }
}

// deno-lint-ignore no-explicit-any
function applyCatalogueRow(state: State, row: any): void {
  absorb(state, { symbol: row.symbol, name: row.name, logoUrl: row.cached_image_url || row.image_url })
  if (row.source_provider === 'coinmarketcap') state.cmcId ??= String(row.provider_id)
  const variants = addressVariants(state.address || '').map((v) => v.toLowerCase())
  for (const [platform, address] of Object.entries(row.platforms || {})) {
    if (typeof address !== 'string' || !address.trim()) continue
    const known = appChainForPlatform(platform)
    addDeployment(state, known, address, 'catalogue')
    if (!state.chain && variants.includes(address.trim().toLowerCase()) && known && candidateChains(state).includes(known)) {
      state.chain = known
      state.address = address.trim()
    }
  }
  state.marketAnswered = true
}

// 2 ── entities: this org already tracks the contract.
// deno-lint-ignore no-explicit-any
async function stepEntities(admin: any, state: State, orgId: string | null): Promise<{ outcome: StepOutcome; detail?: string }> {
  if (!orgId) return { outcome: 'skipped', detail: 'no_org' }
  if (!admin?.from) return { outcome: 'skipped', detail: 'no_database' }
  if (state.detection.kind === 'cmc_id' || !state.address) return { outcome: 'skipped', detail: 'not_a_contract' }
  const refs = [...new Set(candidateChains(state).map((c) => getChain(c)?.caip2Ref).filter((r): r is string => !!r))].slice(0, 24)
  if (!refs.length) return { outcome: 'skipped', detail: 'no_chain_reference' }

  const { data, error } = await admin.from('entities')
    .select('chain_namespace,chain_id,contract_address,display_symbol,asset_id,provider_ids')
    .eq('org_id', orgId).in('chain_id', refs).in('contract_address', addressVariants(state.address)).limit(8)
  if (error) return { outcome: 'error', detail: 'entities_unavailable' }
  const row = (data || [])[0]
  if (!row) return { outcome: 'miss' }

  const chain = candidateChains(state).find((c) => {
    const def = getChain(c)
    return def?.caip2Ref === row.chain_id && def?.namespace === row.chain_namespace
  }) || null
  if (chain && !state.chain) { state.chain = chain; state.address = row.contract_address || state.address }
  absorb(state, { symbol: row.display_symbol })
  const cmcFromEntity = row.provider_ids?.coinmarketcap ?? row.provider_ids?.cmc
  if (cmcFromEntity != null) state.cmcId ??= String(cmcFromEntity)
  if (row.contract_address) addDeployment(state, chain, row.contract_address, 'entities')
  // An org's own row proves the contract exists for this workspace but is not a
  // market quote: it never satisfies the "a market source answered" stop rule.
  return { outcome: 'hit', detail: chain ? `entity:${chain}` : 'entity' }
}

// 3 ── memecoin: the DEX snapshot we already hold.
// deno-lint-ignore no-explicit-any
async function stepMemecoin(admin: any, state: State): Promise<{ outcome: StepOutcome; detail?: string }> {
  if (!admin?.from) return { outcome: 'skipped', detail: 'no_database' }
  if (state.detection.kind === 'cmc_id' || !state.address) return { outcome: 'skipped', detail: 'not_a_contract' }
  const chains = candidateChains(state).slice(0, 24)
  if (!chains.length) return { outcome: 'skipped', detail: 'no_chain_candidates' }

  const { data, error } = await admin.from('memecoin_latest_tokens')
    .select('chain,token_address,symbol,name,image_url,cached_image_url,price_usd,liquidity_usd,market_cap,fdv')
    .in('chain', chains).in('token_address', addressVariants(state.address)).limit(8)
  if (error) return { outcome: 'error', detail: 'memecoin_unavailable' }
  const rows = data || []
  if (!rows.length) return { outcome: 'miss' }

  // deno-lint-ignore no-explicit-any
  const sorted = [...rows].sort((a: any, b: any) => (numeric(b.liquidity_usd) || 0) - (numeric(a.liquidity_usd) || 0))
  // deno-lint-ignore no-explicit-any
  const distinct = [...new Set(sorted.map((r: any) => r.chain))]
  if (distinct.length > 1 && !state.chain) {
    // deno-lint-ignore no-explicit-any
    state.ambiguous = sorted.map((r: any) => chainCandidate(r.chain, r.token_address, text(r.symbol), text(r.name), numeric(r.liquidity_usd)))
    return { outcome: 'hit', detail: `ambiguous:${distinct.length}` }
  }
  const row = sorted[0]
  state.chain ??= row.chain
  state.address = row.token_address || state.address
  absorb(state, { symbol: row.symbol, name: row.name, logoUrl: row.cached_image_url || row.image_url })
  addDeployment(state, row.chain, row.token_address, 'memecoin')
  state.marketAnswered = true
  return { outcome: 'hit', detail: `memecoin:${row.chain}` }
}

// 4 ── cmc_metadata: the canonical CMC id, logo and EVERY deployment.
async function stepCmcMetadata(state: State, deps: ResolverDeps, input: ResolveInput): Promise<{ outcome: StepOutcome; detail?: string }> {
  state.cmcMetadataRan = true
  if (!cmcListable(state)) return { outcome: 'skipped', detail: 'namespace_not_listed_by_cmc' }

  let params: Record<string, string>
  if (state.detection.kind === 'cmc_id') {
    params = { id: String(state.cmcId) }
  } else if (state.cmcId) {
    params = { id: state.cmcId }
  } else {
    params = { address: state.address || '' }
  }

  // The transport's own parameter check (cmcParams) accepts an EVM hex address
  // or a base58 32-44 address and rejects every other shape by throwing. A TON,
  // Stellar, NEAR, Cardano or Injective identifier therefore cannot reach the
  // endpoint today: that is a skipped step, not a resolver error.
  let result
  try {
    result = await deps.requestCmc('metadata', params, cmcContext(input))
  } catch (e) {
    const reason = message(e)
    if (/invalid_contract_address|invalid_parameter|invalid_identifier/.test(reason)) {
      return { outcome: 'skipped', detail: 'cmc_address_format_unsupported' }
    }
    throw e
  }
  if (!result?.payload) return { outcome: 'miss', detail: result?.reason || 'no_payload' }

  // deno-lint-ignore no-explicit-any
  const data: any = (result.payload as any)?.data ?? result.payload
  const rows = Array.isArray(data) ? data : Object.values(data || {}).flat()
  const deployedHere = (entries: unknown): boolean =>
    Array.isArray(entries) && entries.some((c) => sameAddress((c as { contract_address?: unknown })?.contract_address, state.address))
  // deno-lint-ignore no-explicit-any
  const row = rows.find((r: any) => r && (state.detection.kind === 'cmc_id'
    ? String(r.id) === state.cmcId
    : deployedHere(r.contract_address) || String(r.id) === state.cmcId))
    || (rows.length === 1 ? rows[0] : null)
  if (!row) return { outcome: 'miss', detail: 'no_matching_asset' }

  state.cmcId = String(row.id)
  absorb(state, { symbol: row.symbol, name: row.name, logoUrl: row.logo })
  // deno-lint-ignore no-explicit-any
  for (const entry of (row.contract_address || []) as any[]) {
    const address = text(entry?.contract_address)
    if (!address) continue
    const known = appChainForPlatform(entry?.platform?.coin?.slug)
      ?? appChainForPlatform(entry?.platform?.slug)
      ?? appChainForPlatform(entry?.platform?.name)
    addDeployment(state, known, address, 'cmc_metadata')
    if (!state.chain && known && sameAddress(address, state.address) && candidateChains(state).includes(known)) {
      state.chain = known
      state.address = address
    }
  }
  state.marketAnswered = true
  return { outcome: 'hit', detail: `cmc:${state.cmcId}` }
}

// 5 ── cmc_dex: only the four DEX platforms verified against live responses.
async function stepCmcDex(state: State, deps: ResolverDeps, input: ResolveInput): Promise<{ outcome: StepOutcome; detail?: string }> {
  if (state.detection.kind === 'cmc_id' || !state.address) return { outcome: 'skipped', detail: 'not_a_contract' }
  const chains = state.chain ? [state.chain] : candidateChains(state)
  const platform = chains.map(dexPlatformFor).find((p) => !!p)
  if (!platform) return { outcome: 'skipped', detail: 'platform_not_verified' }

  const result = await deps.requestCmc('dexToken', { platform: platform.platform, address: state.address }, cmcContext(input))
  // deno-lint-ignore no-explicit-any
  const data: any = (result?.payload as any)?.data
  if (!data || Array.isArray(data)) return { outcome: 'miss', detail: result?.reason || 'no_payload' }
  state.chain ??= platform.chain
  absorb(state, { symbol: data.symbol ?? data.sym, name: data.name ?? data.nm, logoUrl: data.logo, decimals: data.decimals ?? data.dec })
  addDeployment(state, platform.chain, String(data.addr || state.address), 'cmc_dex')
  state.marketAnswered = true
  return { outcome: 'hit', detail: `dex:${platform.platform}` }
}

function dexPlatformFor(chainId: string): { platform: string; chain: string } | null {
  const def = getChain(chainId)
  if (!def) return null
  const key = def.namespace === 'eip155' ? `eip155:${def.caip2Ref}` : def.id
  const network = CMC_DEX_NETWORKS.find((n) => n.chain === key)
  return network ? { platform: network.platform, chain: chainId } : null
}

// 6 ── dexscreener: token pairs, and the resolver for EVM chain ambiguity.
async function stepDexscreener(state: State, deps: ResolverDeps, input: ResolveInput): Promise<{ outcome: StepOutcome; detail?: string }> {
  if (state.detection.kind === 'cmc_id' || !state.address) return { outcome: 'skipped', detail: 'not_a_contract' }
  const ctx = degenContext(input)
  const chain = selectedChain(state)

  if (chain) {
    if (!CHAIN_PROVIDERS[chain]?.dexscreener) return { outcome: 'skipped', detail: 'no_dexscreener_chain' }
    const token = await deps.getTokenPairs(chain, state.address, ctx)
    if (!token) return { outcome: 'miss' }
    state.chain = chain
    absorb(state, { symbol: token.symbol, name: token.name, logoUrl: token.imageUrl })
    addDeployment(state, chain, token.tokenAddress || state.address, 'dexscreener')
    state.marketAnswered = true
    return { outcome: 'hit', detail: `pairs:${chain}` }
  }

  // Chain-ambiguous paste: one multichain search, best pair per chain.
  const allowed = new Set(candidateChains(state).filter((c) => CHAIN_PROVIDERS[c]?.dexscreener))
  if (!allowed.size) return { outcome: 'skipped', detail: 'no_dexscreener_chain' }
  const rows = await deps.searchTokens(state.address, ctx)
  const byChain = new Map<string, ChainCandidate>()
  for (const row of rows || []) {
    if (!row?.tokenAddress || !sameAddress(row.tokenAddress, state.address)) continue
    if (!allowed.has(row.chain)) continue
    const liquidity = numeric(row.liquidityUsd) || 0
    const previous = byChain.get(row.chain)
    if (previous && (previous.liquidityUsd || 0) >= liquidity) continue
    byChain.set(row.chain, chainCandidate(row.chain, row.tokenAddress, text(row.symbol), text(row.name), liquidity))
  }
  const found = [...byChain.values()].sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0))
  if (!found.length) return { outcome: 'miss' }
  if (found.length > 1) { state.ambiguous = found; return { outcome: 'hit', detail: `ambiguous:${found.length}` } }
  const only = found[0]
  state.chain = only.chain
  state.address = only.address
  absorb(state, { symbol: only.symbol, name: only.name })
  addDeployment(state, only.chain, only.address, 'dexscreener')
  state.marketAnswered = true
  return { outcome: 'hit', detail: `search:${only.chain}` }
}

function chainCandidate(chain: string, address: string, symbol: string | null, name: string | null, liquidityUsd: number | null): ChainCandidate {
  const namespace = getChain(chain)?.namespace || ''
  const canonical = canonicalAddress(namespace, address)
  return {
    chain, address: canonical, symbol, name, liquidityUsd,
    route: assetRoute({ kind: 'contract', providerId: `${chain}:${canonical}`, symbol, chain, address: canonical }),
  }
}

// 7 ── geckoterminal: logo and project info for tokens nothing else describes.
async function stepGeckoterminal(state: State, deps: ResolverDeps, input: ResolveInput): Promise<{ outcome: StepOutcome; detail?: string }> {
  const chain = selectedChain(state)
  if (!chain || !state.address) return { outcome: 'skipped', detail: 'chain_unresolved' }
  if (!CHAIN_PROVIDERS[chain]?.geckoterminal) return { outcome: 'skipped', detail: 'no_geckoterminal_network' }
  const info = await deps.getTokenInfo(chain, state.address, degenContext(input))
  if (!info) return { outcome: 'miss' }
  absorb(state, { logoUrl: info.imageUrl })
  return { outcome: 'hit', detail: info.imageUrl ? 'info_with_logo' : 'info' }
}

// 8 ── birdeye: symbol / name / logo / decimals on the chains it covers.
async function stepBirdeye(state: State, deps: ResolverDeps, input: ResolveInput): Promise<{ outcome: StepOutcome; detail?: string }> {
  const chain = selectedChain(state)
  if (!chain || !state.address) return { outcome: 'skipped', detail: 'chain_unresolved' }
  if (!CHAIN_PROVIDERS[chain]?.birdeye) return { outcome: 'skipped', detail: 'no_birdeye_chain' }
  const meta = await deps.getTokenMetadata(chain, state.address, degenContext(input))
  if (!meta) return { outcome: 'miss' }
  absorb(state, { symbol: meta.symbol, name: meta.name, logoUrl: meta.logo_url, decimals: meta.decimals })
  return { outcome: 'hit', detail: `birdeye:${chain}` }
}

// 9 ── rpc: ask the chain itself. Only reached when everything above missed.
async function stepRpc(state: State, deps: ResolverDeps): Promise<{ outcome: StepOutcome; detail?: string }> {
  const chain = selectedChain(state)
  if (!chain || !state.address) return { outcome: 'skipped', detail: 'chain_unresolved' }
  const def = getChain(chain)
  if (def?.namespace === 'eip155') {
    const url = PUBLIC_EVM_RPC[chain]
    if (!url) return { outcome: 'skipped', detail: 'no_rpc_adapter' }
    const address = canonicalAddress('eip155', state.address)
    const selectors = ['0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd'] // name, symbol, decimals, totalSupply
    const body = selectors.map((data, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{ to: address, data }, 'latest'] }))
    // deno-lint-ignore no-explicit-any
    const raw: any = await deps.rpcCall(url, body, RPC_TIMEOUT_MS)
    const rows = Array.isArray(raw) ? raw : [raw]
    // deno-lint-ignore no-explicit-any
    const at = (id: number) => rows.find((r: any) => Number(r?.id) === id)?.result
    const name = decodeAbiString(at(1))
    const symbol = decodeAbiString(at(2))
    const decimals = decodeAbiUint(at(3))
    const supply = decodeAbiUint(at(4))
    if (!name && !symbol && decimals == null && supply == null) return { outcome: 'miss', detail: 'no_contract_response' }
    absorb(state, { symbol, name, decimals })
    addDeployment(state, chain, address, 'rpc')
    return { outcome: 'hit', detail: symbol ? `erc20:${symbol}` : 'contract_exists' }
  }
  if (chain === 'solana') {
    const body = { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [state.address, { encoding: 'jsonParsed' }] }
    // deno-lint-ignore no-explicit-any
    const raw: any = await deps.rpcCall(PUBLIC_SOLANA_RPC, body, RPC_TIMEOUT_MS)
    const info = raw?.result?.value
    if (!info) return { outcome: 'miss', detail: 'mint_not_found' }
    const parsed = info?.data?.parsed?.info
    absorb(state, { decimals: parsed?.decimals })
    addDeployment(state, 'solana', state.address, 'rpc')
    return { outcome: 'hit', detail: 'mint_exists' }
  }

  // Every other namespace: one adapter module, dispatched by namespace. The
  // adapter answers null for "not a token here" and may throw only for a
  // transport failure, which is recorded as an error rather than being allowed
  // to end the ladder.
  const adapter = rpcAdapterFor(def?.namespace)
  if (!adapter) return { outcome: 'skipped', detail: 'no_rpc_adapter' }
  let meta
  try {
    meta = await adapter({ address: state.address, rpcCall: deps.rpcCall, timeoutMs: RPC_TIMEOUT_MS, env: deps.env })
  } catch (e) {
    return { outcome: 'error', detail: message(e) }
  }
  if (!meta) return { outcome: 'miss', detail: 'no_chain_metadata' }
  absorb(state, { symbol: meta.symbol, name: meta.name, decimals: meta.decimals })
  addDeployment(state, chain, state.address, 'rpc')
  // An RPC answer is an identity, never a market: marketAnswered stays false, so
  // finish() reports identity_only unless a market source also answered.
  return { outcome: 'hit', detail: meta.symbol ? `${def?.namespace}:${meta.symbol}` : 'contract_exists' }
}

/** The maximum body any chain endpoint may return. Metadata reads are small;
 *  this stops one endpoint from spending the isolate's memory. */
const MAX_RPC_BYTES = 512_000

async function defaultRpcCall(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    ...(body == null
      ? { method: 'GET', headers: { Accept: 'application/json' } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  if (!res.ok) throw new Error(`rpc_http_${res.status}`)
  const text = await readBoundedText(res, MAX_RPC_BYTES)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('rpc_invalid_json')
  }
}

/** Deno.env is not readable under every permission set; an unreadable variable
 *  is simply unset, which leaves the adapter on its keyless default. */
function defaultEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key) || undefined
  } catch {
    return undefined
  }
}

function cmcContext(input: ResolveInput) {
  return {
    supabase: input.ctx?.supabase,
    kind: 'request' as const,
    caller: 'intel-asset-resolve',
    orgId: input.orgId || null,
    userId: input.userId || null,
    maxCalls: 2,
    waitForFresh: true,
    ...(input.ctx || {}),
  }
}

function degenContext(input: ResolveInput) {
  return { supabase: input.ctx?.supabase, kind: 'request' as const, caller: 'intel-asset-resolve', jobName: 'intel-asset-resolve', maxCalls: 3 }
}

// ── Result assembly + demand + indexing ──────────────────────────────────────

const NOT_INDEXED = { inserted: false, demanded: false }

// deno-lint-ignore no-explicit-any
async function finish(admin: any, state: State, query: string, deps: ResolverDeps, input: ResolveInput): Promise<ResolveResult> {
  const base = { query, kind: state.detection.kind, provenance: state.provenance }

  if (state.ambiguous?.length) {
    return { ...base, status: 'ambiguous', identity: null, candidates: state.ambiguous, reason: 'chain_selection_required', demandRecorded: false, indexed: NOT_INDEXED }
  }

  const deployments = [...state.deployments.values()].slice(0, 64)
  const chain = selectedChain(state)
  const namespace = chain ? getChain(chain)?.namespace || '' : ''
  const address = state.address ? canonicalAddress(namespace, state.address) : null
  const useCmc = !!state.cmcId && (state.detection.kind === 'cmc_id' || !!state.symbol || !!state.name)

  const identity: AssetIdentity = useCmc
    ? {
      kind: 'cmc', provider: 'coinmarketcap', providerId: String(state.cmcId),
      symbol: state.symbol, name: state.name, chain, address,
      canonicalKey: entityKey(chain, address, state.symbol) || `coinmarketcap:${state.cmcId}`,
      logoUrl: state.logoUrl, decimals: state.decimals, deployments,
      route: assetRoute({ kind: 'cmc', providerId: String(state.cmcId), symbol: state.symbol, chain, address }),
    }
    : {
      kind: 'contract', provider: 'contract', providerId: `${chain || ''}:${address || ''}`,
      symbol: state.symbol, name: state.name, chain, address,
      canonicalKey: entityKey(chain, address, state.symbol),
      logoUrl: state.logoUrl, decimals: state.decimals, deployments,
      route: assetRoute({ kind: 'contract', providerId: `${chain || ''}:${address || ''}`, symbol: state.symbol, chain, address }),
    }

  const answered = state.provenance.some((p) => p.outcome === 'hit')
  const identified = !!state.cmcId || (!!chain && !!address)
  if (!answered || !identified) {
    return { ...base, status: 'unresolved', identity, candidates: [], reason: 'no_source_answered', demandRecorded: false, indexed: NOT_INDEXED }
  }

  // A contract identity that no market source answered for: the chain (or a
  // metadata-only provider) named it, and nothing prices it. It is still a real
  // asset, so it is indexed, demanded and searchable — it simply must not be
  // reported as `resolved`, which the app reads as "this asset has a market".
  // A CoinMarketCap identity is never identity-only: a CMC id always has a
  // canonical market route, whichever step supplied it.
  const identityOnly = identity.kind === 'contract' && !state.marketAnswered && !!chain && !!address && !!state.symbol

  const demandKey = identity.kind === 'cmc' ? `cmc:${identity.providerId}` : `${chain}:${address}`
  const demandRecorded = await recordDemand(admin, demandKey, identity)

  // The record every user gets. It never changes the resolution: a failure is a
  // provenance entry, and the identity above is returned either way.
  const started = deps.now()
  const indexed = await deps.indexAsset(admin, identity, {
    logoUrl: identity.logoUrl, orgId: input.orgId || null, userId: input.userId || null,
  }).catch((e: unknown) => ({ indexed: false, demanded: false, reasons: [`index_failed:${message(e)}`] }))
  const failed = indexed.reasons.some((r) => /^(index_failed|no_database|cache_unavailable|demand_stamp_failed|demand_failed)/.test(r))
  state.provenance.push({
    step: 'index',
    outcome: indexed.indexed ? 'hit' : failed ? 'error' : indexed.reasons.includes('identity_incomplete') ? 'skipped' : 'miss',
    ms: Math.max(0, deps.now() - started),
    ...(indexed.reasons.length ? { detail: indexed.reasons.join(',').slice(0, 140) } : {}),
  })

  return {
    ...base,
    status: identityOnly ? 'identity_only' : 'resolved',
    identity,
    candidates: [],
    reason: identityOnly ? 'no_market_source' : null,
    demandRecorded,
    indexed: { inserted: indexed.indexed, demanded: indexed.demanded },
  }
}

// deno-lint-ignore no-explicit-any
async function recordDemand(admin: any, assetKey: string, identity: AssetIdentity): Promise<boolean> {
  if (!admin?.rpc || !assetKey || assetKey.length > 200) return false
  try {
    // public.intel_record_asset_demand is a service-role-only SECURITY DEFINER
    // wrapper; app_private is not an exposed PostgREST schema.
    const { error } = await admin.rpc('intel_record_asset_demand', {
      p_asset_key: assetKey,
      p_provider: identity.provider,
      p_provider_id: identity.providerId,
    })
    return !error
  } catch {
    return false
  }
}
