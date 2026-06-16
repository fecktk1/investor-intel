export interface DataCoverage {
  used_sources: string[]
  checked_sources: string[]
  unavailable_sources: string[]
  material_gaps: string[]
  optional_gaps: string[]
  confidence_impact: 'none' | 'low' | 'medium' | 'high'
  should_show_warning: boolean
}

// deno-lint-ignore no-explicit-any
type Structured = Record<string, any>

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v || '').trim()).filter(Boolean)
}

function uniq(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const s = String(value || '').trim()
    const key = s.toLowerCase()
    if (!s || seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

function norm(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const COVERAGE_KEYWORDS: Array<{ source: RegExp; gap: RegExp }> = [
  { source: /asset evidence pack|market assets|exchange|cex|ticker|market cap|orderbook|order book/i, gap: /market|profile|price|volume|cex|exchange|spread|depth|liquidity/i },
  { source: /dex|dexscreener|geckoterminal|ohlcv/i, gap: /dex|pair|ohlcv/i },
  { source: /alchemy|transfer|flow|wallet|whale|on chain|on-chain/i, gap: /flow|wallet|whale|transfer|on chain|on-chain/i },
  { source: /defillama|kamino|defi|protocol|tvl/i, gap: /defi|protocol|pool|vault|tvl/i },
  { source: /macro|chain tvl|chain/i, gap: /chain|macro|regime/i },
  { source: /news|curated|signal layer|rss|source/i, gap: /news|headline|source|official/i },
  { source: /narrative|signal|memory|platform intelligence/i, gap: /narrative|memory|profile|context/i },
  { source: /social|link/i, gap: /social|community|link/i },
]

export function gapCoveredBySources(gap: string, sources: string[]): boolean {
  const g = norm(gap)
  if (!g) return true
  for (const source of sources) {
    const s = norm(source)
    if (!s) continue
    if (g.includes(s) || s.includes(g)) return true
    for (const rule of COVERAGE_KEYWORDS) {
      if (rule.source.test(source) && rule.gap.test(gap)) return true
    }
  }
  return false
}

export function normalizeDataCoverage(value: unknown): Partial<DataCoverage> {
  if (!value || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    used_sources: strings(v.used_sources),
    checked_sources: strings(v.checked_sources),
    unavailable_sources: strings(v.unavailable_sources),
    material_gaps: strings(v.material_gaps),
    optional_gaps: strings(v.optional_gaps),
    confidence_impact: ['none', 'low', 'medium', 'high'].includes(String(v.confidence_impact))
      ? v.confidence_impact as DataCoverage['confidence_impact']
      : undefined,
    should_show_warning: typeof v.should_show_warning === 'boolean' ? v.should_show_warning : undefined,
  }
}

export function reconcileCoverage(
  structured: Structured,
  sourcesUsed: string[] = [],
  packCoverage?: unknown,
): Structured {
  if (!structured || typeof structured !== 'object') return structured
  const modelCoverage = normalizeDataCoverage(structured.data_coverage)
  const pack = normalizeDataCoverage(packCoverage)
  const used = uniq([
    ...strings(structured.sources),
    ...sourcesUsed,
    ...(modelCoverage.used_sources || []),
    ...(pack.used_sources || []),
  ])
  const checked = uniq([
    ...(modelCoverage.checked_sources || []),
    ...(pack.checked_sources || []),
    ...used,
  ])
  const unavailable = uniq([
    ...(modelCoverage.unavailable_sources || []),
    ...(pack.unavailable_sources || []),
  ]).filter((gap) => !gapCoveredBySources(gap, used))

  const packOptional = pack.optional_gaps || []
  const optional = uniq([
    ...(modelCoverage.optional_gaps || []),
    ...packOptional,
  ]).filter((gap) => !gapCoveredBySources(gap, used))

  const materialBase = uniq([
    ...(modelCoverage.material_gaps || []),
    ...strings(structured.missing_context),
    ...(pack.material_gaps || []),
  ])
  const optionalKeys = new Set(optional.map(norm))
  const material = materialBase
    .filter((gap) => !optionalKeys.has(norm(gap)))
    .filter((gap) => !gapCoveredBySources(gap, used))

  const confidence = String(structured.confidence || '').toLowerCase()
  const shouldShowWarning = material.length > 0 && confidence !== 'high'
  const confidenceImpact: DataCoverage['confidence_impact'] = material.length
    ? 'high'
    : optional.length > 4
      ? 'medium'
      : optional.length
        ? 'low'
        : 'none'

  structured.data_coverage = {
    used_sources: used,
    checked_sources: checked,
    unavailable_sources: unavailable,
    material_gaps: material,
    optional_gaps: optional,
    confidence_impact: modelCoverage.confidence_impact || pack.confidence_impact || confidenceImpact,
    should_show_warning: shouldShowWarning,
  }
  structured.missing_context = material
  return structured
}
