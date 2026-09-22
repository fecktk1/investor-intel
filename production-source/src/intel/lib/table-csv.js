import { toCsv, downloadCsv } from './portfolio-api'

// Shared "Download CSV" for Investor Intel tables.
//
// One contract for every table that offers a download:
//
//   downloadTableCsv({ view, asOf, columns, rows, exportAllowed })
//
//   columns: Array<{ key, label, cmcRaw?, value: (row) => any }>
//
// Licence rule, fail closed. A column marked `cmcRaw: true` carries a figure
// CoinMarketCap published (a price, a volume, a market cap). Those cells are
// written blank unless `exportAllowed === true` exactly. Pass the flag straight
// from the read that produced the rows (`exportAllowedFrom(payload)` below reads
// `payload.sourcePolicy.exportAllowed`, which intel-capture op:'read' carries
// from CMC_ALLOW_EXPORT). Anything else, including undefined, a string 'true' or
// a missing policy, blanks them. Ids, states, reasons, counts and our own derived
// figures (premium bps, our 24h change) are never cmcRaw and always export.
//
// Provenance. Every file carries `captured_at` and `source` when the caller's
// rows provide them: put `captured_at` (or `capturedAt`) and `source` on each
// row object and, unless a column with key 'captured_at' / 'source' is already
// declared, the two columns are appended at the end. `source` may be a string
// or an object with `provider`, `name` or `label`.
//
// Cells go through portfolio-api's toCsv, which quotes commas, quotes and line
// breaks and prefixes text starting with = + - @ so a spreadsheet never runs it
// as a formula. Text that begins with a tab or a carriage return is prefixed
// here as well, because toCsv only looks past leading whitespace for those four.
// null and undefined become an empty cell.

const firstNonNull = (row, keys) => {
  for (const key of keys) { const v = row?.[key]; if (v != null) return v }
  return null
}

const sourceText = (value) => {
  if (value == null) return null
  if (typeof value === 'object') return value.provider ?? value.name ?? value.label ?? null
  return value
}

const PROVENANCE_COLUMNS = [
  { key: 'captured_at', label: 'captured_at', rowKeys: ['captured_at', 'capturedAt'], value: (row) => firstNonNull(row, ['captured_at', 'capturedAt']) },
  { key: 'source', label: 'source', rowKeys: ['source'], value: (row) => sourceText(row?.source) },
]

// Tab and CR at the very start are formula openers in some spreadsheets too.
const defuse = (value) => (typeof value === 'string' && /^[\t\r]/.test(value) ? `'${value}` : value)

/** True only when the read's own source policy says CMC figures may be exported. */
export function exportAllowedFrom(payload) {
  return payload?.sourcePolicy?.exportAllowed === true
}

/** Resolve the declared columns plus any provenance columns the rows carry. */
export function tableCsvColumns(columns = [], rows = []) {
  const declared = Array.isArray(columns) ? columns.filter(Boolean) : []
  const list = Array.isArray(rows) ? rows : []
  const extra = PROVENANCE_COLUMNS.filter((col) => !declared.some((c) => c.key === col.key)
    && list.some((row) => col.rowKeys.some((key) => row?.[key] != null)))
  return [...declared, ...extra]
}

/** `<view>-<asOf or today>.csv`, reduced to a safe file name. */
export function tableCsvFilename(view, asOf, now = new Date()) {
  const clean = (value) => String(value ?? '').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)
  const parsed = asOf == null || asOf === '' ? NaN : Date.parse(asOf)
  const stamp = Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 19).replace(/:/g, '-')
    : clean(asOf) || new Date(now).toISOString().slice(0, 10)
  return `${clean(view) || 'table'}-${stamp}.csv`
}

// The toCsv column specs for a table: licence rule, provenance and defusing.
function csvSpecs(columns, rows, exportAllowed) {
  const allowed = exportAllowed === true
  return tableCsvColumns(columns, rows).map((col) => ({
    label: col.label ?? col.key,
    get: (row) => {
      if (col.cmcRaw && !allowed) return null
      const value = typeof col.value === 'function' ? col.value(row) : row?.[col.key]
      return defuse(value === undefined ? null : value)
    },
  }))
}

/** Pure: the CSV text for a table, licence rule and provenance applied. */
export function buildTableCsv({ columns, rows, exportAllowed } = {}) {
  const list = Array.isArray(rows) ? rows : []
  return toCsv(list, csvSpecs(columns, list, exportAllowed))
}

/** Browser download of the table as `<view>-<asOf or today>.csv`. Returns the
 * file name. The text is exactly what buildTableCsv returns. */
export function downloadTableCsv({ view, asOf, columns, rows, exportAllowed } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const filename = tableCsvFilename(view, asOf)
  downloadCsv(filename, list, csvSpecs(columns, list, exportAllowed))
  return filename
}

// ─── Column specs for the two tables this builder owns ──────────────────────

const num = (value) => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** RwaUniverse per-type table. Rows: `{ type, typeLabel, ...latest[type], source }`
 * where latest[type] is the rwa_universe capture entry (it carries capturedAt). */
export const UNIVERSE_TYPE_CSV_COLUMNS = [
  { key: 'asset_type', label: 'Asset type id', value: (r) => r.type },
  { key: 'asset_type_label', label: 'Asset type', value: (r) => r.typeLabel ?? r.type },
  { key: 'asset_count', label: 'Assets', value: (r) => num(r.assetCount) },
  { key: 'assets_scanned', label: 'Assets scanned', value: (r) => num(r.assetsScanned) },
  { key: 'assets_with_tokens', label: 'Assets with tokens', value: (r) => num(r.assetsWithTokens) },
  { key: 'total_market_value_usd', label: 'Value (USD)', cmcRaw: true, value: (r) => num(r.totalMarketValueUsd) },
  { key: 'volume_24h_usd', label: '24h volume (USD)', cmcRaw: true, value: (r) => num(r.volume24hUsd) },
  // Split by origin: a provider figure is CoinMarketCap's; ours is derived from
  // our own consecutive captures and exports under any policy.
  { key: 'change_24h_pct_provider', label: '24h change % (provider)', cmcRaw: true, value: (r) => (r.change24hSource === 'provider' ? num(r.change24hPct) : null) },
  { key: 'change_24h_pct_ours', label: '24h change % (our calculation)', value: (r) => (r.change24hSource === 'provider' ? null : num(r.change24hPct)) },
  { key: 'change_24h_source', label: '24h change source', value: (r) => r.change24hSource ?? null },
  { key: 'change_24h_reason', label: '24h change reason', value: (r) => r.change24hReason ?? null },
  { key: 'change_24h_from_at', label: '24h change from', value: (r) => r.change24hFromAt ?? null },
  { key: 'change_24h_to_at', label: '24h change to', value: (r) => r.change24hToAt ?? null },
]

const quoteOf = (r) => r?.quote || {}

/** intel-research `rwaList` page. Rows are the research rows as shown, plus the
 * optional `captured_at` / `source` the caller attaches. */
export const RWA_LIST_CSV_COLUMNS = [
  { key: 'rwa_id', label: 'RWA id', value: (r) => r.rwa_id ?? null },
  { key: 'name', label: 'Name', value: (r) => r.name ?? r.rwa_name ?? null },
  { key: 'symbol', label: 'Symbol', value: (r) => r.symbol ?? null },
  { key: 'asset_type', label: 'Asset type', value: (r) => r.asset_type ?? null },
  { key: 'has_tokens', label: 'Has tokens', value: (r) => (typeof r.has_tokens === 'boolean' ? String(r.has_tokens) : null) },
  { key: 'tokenized_price_usd', label: 'Tokenized price (USD)', cmcRaw: true, value: (r) => num(r.average_tokenized_price ?? quoteOf(r).average_tokenized_price) },
  { key: 'tokenized_value_usd', label: 'Tokenized value (USD)', cmcRaw: true, value: (r) => num(r.tokenized_market_cap ?? quoteOf(r).tokenized_market_cap) },
  { key: 'tokenized_volume_24h_usd', label: '24h volume (USD)', cmcRaw: true, value: (r) => num(r.tokenized_volume_24h ?? quoteOf(r).tokenized_volume_24h) },
  { key: 'quote_observed_at', label: 'Quote observed', value: (r) => quoteOf(r).last_updated ?? null },
]
