// Investor Intel — market logo cache (pure helpers).
//
// Provider logo URLs (CoinMarketCap / CoinGecko / Dexscreener) are hotlinked
// today, so a provider outage, a rate limit or a hotlink block shows up as a
// broken avatar in Markets + Degen. This module is the decision layer for the
// market-asset-logo-verify job that mirrors those images into the public
// `public-assets` bucket: which rows to re-check, where each one is stored,
// what counts as a usable image, and how a failure ages a row toward the
// initials fallback. Everything here is deterministic and side-effect free so
// the policy can be unit-tested without network or database access.
//
// Row shapes: `market_assets` (catalogue; keyed source_provider + provider_id)
// and `memecoin_latest_tokens` (keyed chain + token_address).

export type LogoRowKind = 'catalogue' | 'memecoin'

export interface LogoRow {
  source_provider?: string | null
  provider_id?: string | null
  chain?: string | null
  token_address?: string | null
  symbol?: string | null
  market_cap_rank?: number | null
  image_url?: string | null
  cached_image_url?: string | null
  image_source?: string | null
  image_fallback_type?: string | null
  image_last_checked_at?: string | null
  image_verified_at?: string | null
  image_error_count?: number | null
}

export interface SelectLogoOptions { maxErrors?: number; recheckDays?: number }

export type LogoValidation =
  | { ok: true; contentType: string; ext: string }
  | { ok: false; reason: string }

export interface LogoErrorState { image_error_count: number; image_fallback_type: string | null }

export const LOGO_BUCKET = 'public-assets'
export const MAX_LOGO_BYTES = 512 * 1024
export const DEFAULT_MAX_ERRORS = 3
export const DEFAULT_RECHECK_DAYS = 7

// Raster formats every browser renders; svg is accepted only from the vetted
// catalogue providers (an svg is executable markup — a memecoin image_url is
// attacker-supplied metadata and must never be re-served from our origin).
const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}
const EXT_ALIAS: Record<string, string> = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', svg: 'svg' }

const DAY_MS = 86_400_000

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && value.trim()) return Date.parse(value)
  return NaN
}

export function isHttpsUrl(value: unknown): boolean {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value.trim())
}

export function logoRowKind(row: LogoRow | null | undefined): LogoRowKind {
  return row?.chain && row?.token_address ? 'memecoin' : 'catalogue'
}

function normalizeContentType(contentType: unknown): string {
  if (typeof contentType !== 'string') return ''
  return contentType.split(';')[0].trim().toLowerCase()
}

// Storage object keys must stay predictable: a provider id or token address is
// external input, so anything outside the safe set collapses to '-'. Runs of
// dots collapse too, so no traversal-looking '..' segment ever reaches storage.
function pathSegment(value: unknown, fallback = 'unknown'): string {
  const raw = String(value ?? '').trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  return raw ? raw.slice(0, 120) : fallback
}

function extFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const match = /\.([A-Za-z0-9]{2,5})(?:[?#].*)?$/.exec(url.trim())
  const ext = match ? match[1].toLowerCase() : ''
  return EXT_ALIAS[ext] || null
}

export function logoExtension(contentType?: unknown, url?: unknown): string {
  return CONTENT_TYPE_EXT[normalizeContentType(contentType)] || extFromUrl(url) || 'png'
}

/**
 * Rows worth fetching this run. Eligible when the provider gave us an https
 * image_url, we have not mirrored it yet (or the mirror is older than
 * `recheckDays`), and the row has not already failed `maxErrors` times.
 * Ordered by market-cap rank so the visible top of the table is cached first,
 * then by least-recently-checked so a bounded nightly run still walks the tail.
 */
export function selectLogoCandidates(
  rows: LogoRow[] | null | undefined,
  now: Date | number | string = Date.now(),
  options: SelectLogoOptions = {},
): LogoRow[] {
  const maxErrors = Number.isFinite(Number(options.maxErrors)) ? Number(options.maxErrors) : DEFAULT_MAX_ERRORS
  const recheckDays = Number.isFinite(Number(options.recheckDays)) ? Number(options.recheckDays) : DEFAULT_RECHECK_DAYS
  const nowMs = toMs(now)
  const cutoff = (Number.isFinite(nowMs) ? nowMs : Date.now()) - recheckDays * DAY_MS

  const eligible = (rows || []).filter((row) => {
    if (!row || !isHttpsUrl(row.image_url)) return false
    if ((Number(row.image_error_count) || 0) >= maxErrors) return false
    if (!row.cached_image_url) return true
    const verifiedMs = toMs(row.image_verified_at)
    return !Number.isFinite(verifiedMs) || verifiedMs < cutoff
  })

  const rankOf = (row: LogoRow) => {
    const rank = Number(row.market_cap_rank)
    return Number.isFinite(rank) && rank > 0 ? rank : Number.POSITIVE_INFINITY
  }
  // Never checked sorts first — those rows have no cached image at all.
  const checkedOf = (row: LogoRow) => {
    const checked = toMs(row.image_last_checked_at)
    return Number.isFinite(checked) ? checked : Number.NEGATIVE_INFINITY
  }
  const cmp = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1)

  return eligible.slice().sort((a, b) => cmp(rankOf(a), rankOf(b)) || cmp(checkedOf(a), checkedOf(b)))
}

/**
 * Deterministic storage key. Catalogue assets live under their provider
 * namespace; memecoins under their chain, address lowercased so the same token
 * always upserts over the same object instead of accumulating variants.
 */
export function logoObjectPath(row: LogoRow, contentType?: unknown): string {
  const ext = logoExtension(contentType, row?.image_url)
  if (logoRowKind(row) === 'memecoin') {
    const chain = pathSegment(String(row.chain ?? '').toLowerCase(), 'unknown-chain')
    const address = pathSegment(String(row.token_address ?? '').toLowerCase(), 'unknown-token')
    return `market-logos/memecoin/${chain}/${address}.${ext}`
  }
  const provider = pathSegment(String(row?.source_provider ?? '').toLowerCase(), 'unknown-provider')
  return `market-logos/${provider}/${pathSegment(row?.provider_id, 'unknown-id')}.${ext}`
}

/** Gate on what came back from the provider before anything is re-served from our origin. */
export function validateLogoResponse(contentType: unknown, byteLength: unknown, kind: LogoRowKind = 'catalogue'): LogoValidation {
  const mime = normalizeContentType(contentType)
  if (!mime) return { ok: false, reason: 'missing_content_type' }
  if (!(mime in CONTENT_TYPE_EXT)) return { ok: false, reason: `unsupported_content_type:${mime}` }
  if (mime === 'image/svg+xml' && kind === 'memecoin') return { ok: false, reason: 'svg_not_allowed_for_memecoin' }
  const bytes = Number(byteLength)
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, reason: 'empty_body' }
  if (bytes > MAX_LOGO_BYTES) return { ok: false, reason: `too_large:${bytes}` }
  return { ok: true, contentType: mime, ext: CONTENT_TYPE_EXT[mime] }
}

export function publicLogoUrl(supabaseUrl: string, path: string): string {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  const key = String(path || '').replace(/^\/+/, '')
  return `${base}/storage/v1/object/public/${LOGO_BUCKET}/${key}`
}

/**
 * Failure ageing. Each miss increments the counter; once the row has burned
 * through `maxErrors` attempts it is pinned to the initials monogram so the UI
 * stops asking for an image that is never going to load.
 */
export function nextErrorState(row: LogoRow | null | undefined, options: SelectLogoOptions = {}): LogoErrorState {
  const maxErrors = Number.isFinite(Number(options.maxErrors)) ? Number(options.maxErrors) : DEFAULT_MAX_ERRORS
  const count = (Number(row?.image_error_count) || 0) + 1
  return {
    image_error_count: count,
    image_fallback_type: count >= maxErrors ? 'initials' : (row?.image_fallback_type ?? null),
  }
}
