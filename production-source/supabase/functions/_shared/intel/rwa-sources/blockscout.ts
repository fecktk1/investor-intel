// Investor Intel: holder concentration from Blockscout.
//
// LICENSING WARNING, AND IT SHAPES THE CODE. Blockscout's redistribution terms
// COULD NOT BE VERIFIED on 2026-09-16. This source is therefore treated as
// display-with-attribution only: `sourceExportAllowed('blockscout')` is false,
// every observation derived here must carry `exportAllowed:false`, and no
// redistributable derived dataset may be built from it. The scope string on
// each figure says so.
//
// PRIVACY. The `/holders` payload carries SEVEN fields that could name or
// characterise a party: ens_domain_name, name, public_tags, private_tags,
// watchlist_names, metadata and reputation (probed 2026-09-16). This lane keeps
// the ADDRESS and the BALANCE and nothing else. An address is not a person, no
// clustering happens here, and there is no field on `HolderRow` that could
// carry an identity. This mirrors _shared/intel/holder-tags.ts.
//
// Verified 2026-09-16 against BUIDL 0x7712c34205737192402172409a8F7ccef8aA2AEc:
//   holders_count 58, total_supply 212143220660349, decimals 6
//   top1 25.82%, top5 68.46%, top10 81.81%
// `concentration()` reproduces those three figures exactly in its test.
//
// ONE PAGE ONLY. `/holders` returned 50 rows with a `next_page_params` cursor,
// which this lane deliberately does NOT follow. The stored figure is therefore
// "the top N of the first page the provider returned", and the read view says
// exactly that. A top-10 share is still exact whenever the page is longer than
// ten rows, which it is here.

import { fetchSource, sourceExportAllowed, type SourceDeps } from './http.ts'

export const BLOCKSCOUT_CHAINS = {
  ethereum: 'eth.blockscout.com',
  base: 'base.blockscout.com',
  arbitrum: 'arbitrum.blockscout.com',
  polygon: 'polygon.blockscout.com',
} as const
export type BlockscoutChain = keyof typeof BLOCKSCOUT_CHAINS

/** Fields the provider sends about a holder that this lane refuses to read.
 * Named so the test can assert none of them survives normalisation. */
export const HOLDER_FIELDS_DROPPED = ['ens_domain_name', 'name', 'public_tags', 'private_tags', 'watchlist_names', 'metadata', 'reputation'] as const

/** One page of holders, as the provider returns it. Not the holder base. */
export const HOLDER_PAGE_SIZE = 50
export const CONCENTRATION_TIERS = [1, 5, 10] as const

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

const str = (v: unknown, max = 200): string | null => {
  const s = v == null ? '' : String(v).trim()
  return s ? s.slice(0, max) : null
}
/** Token balances exceed Number.MAX_SAFE_INTEGER, so quantities are carried as
 * BigInt and only the SHARE becomes a float. */
const big = (v: unknown): bigint | null => {
  const s = String(v ?? '').trim()
  if (!/^\d+$/.test(s)) return null
  try { return BigInt(s) } catch { return null }
}

export interface TokenSummary {
  address: string
  name: string | null
  symbol: string | null
  decimals: number | null
  /** A reported count. Zero is a real answer and stays zero. */
  holdersCount: number | null
  totalSupply: bigint | null
}

/** An address and what it holds. There is deliberately no other field. */
export interface HolderRow { address: string; value: bigint }

export interface ConcentrationTier { topN: number; share: number | null }
export interface Concentration {
  tiers: ConcentrationTier[]
  /** How many rows the share was computed from. */
  holdersRead: number
  /** True when the provider had more rows than this one page. */
  truncated: boolean
  totalSupply: bigint | null
}

export const blockscoutTokenUrl = (chain: BlockscoutChain, address: string): string =>
  `https://${BLOCKSCOUT_CHAINS[chain]}/token/${address}`

const apiBase = (chain: BlockscoutChain, address: string): string | null =>
  BLOCKSCOUT_CHAINS[chain] && EVM_ADDRESS.test(address) ? `https://${BLOCKSCOUT_CHAINS[chain]}/api/v2/tokens/${address}` : null

export interface TokenSummaryResult {
  state: 'known' | 'not_found' | 'unavailable'
  summary: TokenSummary | null
  reason: string | null
  fetchedAt: string
  sourceUrl: string
}

export async function fetchTokenSummary(chain: BlockscoutChain, address: unknown, deps: SourceDeps = {}): Promise<TokenSummaryResult> {
  const addr = String(address ?? '').trim()
  const url = apiBase(chain, addr)
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString()
  if (!url) return { state: 'unavailable', summary: null, reason: 'invalid_contract_identity', fetchedAt, sourceUrl: 'https://blockscout.com/' }
  // deno-lint-ignore no-explicit-any
  const response = await fetchSource<any>('blockscout', url, deps)
  if (!response.ok) {
    const notFound = response.status === 404
    return { state: notFound ? 'not_found' : 'unavailable', summary: null, reason: notFound ? null : response.reason, fetchedAt: response.fetchedAt, sourceUrl: url }
  }
  const payload = response.data ?? {}
  const holders = Number(payload?.holders_count)
  const decimals = Number(payload?.decimals)
  return {
    state: 'known',
    summary: {
      address: addr.toLowerCase(),
      name: str(payload?.name, 200),
      symbol: str(payload?.symbol, 40),
      decimals: Number.isFinite(decimals) && decimals >= 0 ? Math.trunc(decimals) : null,
      holdersCount: Number.isFinite(holders) && holders >= 0 ? Math.trunc(holders) : null,
      totalSupply: big(payload?.total_supply),
    },
    reason: null,
    fetchedAt: response.fetchedAt,
    sourceUrl: url,
  }
}

export interface HoldersResult {
  state: 'known' | 'not_found' | 'unavailable'
  holders: HolderRow[]
  truncated: boolean
  reason: string | null
  fetchedAt: string
  sourceUrl: string
}

/** One page of holders, ADDRESSES AND BALANCES ONLY. */
export async function fetchTopHolders(chain: BlockscoutChain, address: unknown, deps: SourceDeps = {}): Promise<HoldersResult> {
  const addr = String(address ?? '').trim()
  const base = apiBase(chain, addr)
  const url = base ? `${base}/holders` : null
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString()
  if (!url) return { state: 'unavailable', holders: [], truncated: false, reason: 'invalid_contract_identity', fetchedAt, sourceUrl: 'https://blockscout.com/' }
  // deno-lint-ignore no-explicit-any
  const response = await fetchSource<any>('blockscout', url, deps)
  if (!response.ok) {
    const notFound = response.status === 404
    return { state: notFound ? 'not_found' : 'unavailable', holders: [], truncated: false, reason: notFound ? null : response.reason, fetchedAt: response.fetchedAt, sourceUrl: url }
  }
  const items = Array.isArray(response.data?.items) ? response.data.items : []
  const holders: HolderRow[] = []
  for (const item of items.slice(0, HOLDER_PAGE_SIZE)) {
    // Read ONLY the hash and the value. Every other key on `item.address` is
    // ignored by construction, not filtered afterwards.
    const hash = str(item?.address?.hash, 100)
    const value = big(item?.value)
    if (!hash || !EVM_ADDRESS.test(hash) || value == null) continue
    holders.push({ address: hash.toLowerCase(), value })
  }
  return { state: 'known', holders, truncated: !!response.data?.next_page_params, reason: null, fetchedAt: response.fetchedAt, sourceUrl: url }
}

/**
 * Top-N share of total supply.
 *
 * A share of 0 is a REAL measurement and is returned as 0, never as null and
 * never as a dash. Null means the share could not be computed at all, which
 * happens only when supply is absent or zero, or when there are no rows.
 */
export function concentration(holders: readonly HolderRow[], totalSupply: bigint | null, options: { truncated?: boolean; tiers?: readonly number[] } = {}): Concentration {
  const tiers = (options.tiers ?? CONCENTRATION_TIERS).filter((n) => Number.isInteger(n) && n > 0)
  const sorted = [...holders].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0))
  const usable = totalSupply != null && totalSupply > 0n
  return {
    tiers: tiers.map((topN) => {
      if (!usable || !sorted.length) return { topN, share: null }
      const held = sorted.slice(0, topN).reduce((sum, row) => sum + row.value, 0n)
      // Scale before dividing so a small share does not floor to zero, then
      // convert once. A genuinely zero holding yields exactly 0.
      const scaled = Number((held * 1_000_000n) / (totalSupply as bigint)) / 10_000
      return { topN, share: Number.isFinite(scaled) ? scaled : null }
    }),
    holdersRead: sorted.length,
    truncated: options.truncated === true,
    totalSupply: totalSupply ?? null,
  }
}

/** The scope every concentration figure is rendered with. */
export const concentrationScope = (truncated: boolean): string =>
  `Share of reported total supply held by the largest addresses on ONE page of holders the explorer returned${truncated ? ', which is not the whole holder base' : ''}. An address is not a person, and no address here is resolved to a name, an exchange or an owner. Concentration describes a distribution at a moment; it does not establish control, coordination or risk. Source figures are shown with attribution and are not redistributed, because this explorer's redistribution terms could not be verified.`

/** False for this source: its terms are unverified. Re-exported so a caller
 * cannot forget which side of the licence line a figure came from. */
export const blockscoutExportAllowed = (): boolean => sourceExportAllowed('blockscout')
