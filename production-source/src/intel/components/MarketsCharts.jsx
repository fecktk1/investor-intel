import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RadialGauge, RadialBars, HeatStrip } from '../charts'
import { formatPct } from '../lib/market-format'

// Market context figures for the Markets screen rail: breadth, dominance and
// chain heat. Plain figures — no cards, no chips, no boxes — laid out in one
// row that stacks on a phone. Every figure is a selector as well as a reading:
// activating a mark changes the screen below it rather than opening a dialog.

// The three figures share one row until the viewport can no longer hold a
// readable chart; auto-fit then drops to two and finally to one column at
// roughly 480px. Declared here because it is this row's only layout rule.
const ROW = { display: 'grid', gap: '1.5rem 2.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 17rem), 1fr))', alignItems: 'start' }

const BTC_ROUTE = '/intel/markets/BTC?provider=coinmarketcap&id=1'
const ETH_ROUTE = '/intel/markets/ETH?provider=coinmarketcap&id=1027'

// null / '' / booleans / NaN stay null. A reported 0 stays 0: zero assets up on
// the day is a reading, not a gap.
const num = value => { if (value == null || value === '' || typeof value === 'boolean') return null; const n = Number(value); return Number.isFinite(n) ? n : null }
// Unsigned percent: a share is never "+58.9%".
const share = value => formatPct(value).replace(/^\+/, '')

// Share of tracked market cap held by stablecoins, from the same macro row the
// dominance figures use. Returns null when either side is missing so the
// remainder is computed from what was actually observed.
export function stablecoinSharePct(macro) {
  const cap = num(macro?.stablecoin_market_cap_usd), total = num(macro?.total_market_cap_usd)
  if (cap == null || total == null || total <= 0) return null
  return (cap / total) * 100
}

// Breadth as a percentage of the assets that actually moved. Assets with no
// 24h observation are excluded from both sides rather than counted as flat.
export function breadthPct(snapshot) {
  const up = num(snapshot?.up24h), down = num(snapshot?.down24h)
  if (up == null || down == null) return null
  const moved = up + down
  if (moved <= 0) return null
  return (up / moved) * 100
}

// Depth bands for the drawdown figure. A shallow pullback and a collapse are
// different readings, so they are different tones rather than one ramp.
export const drawdownTone = depth => depth == null ? 'muted' : depth >= 25 ? 'red' : depth >= 10 ? 'yellow' : 'green'

// The deepest recorded drawdowns on the page a reader is actually looking at.
// Rows with no reading are left out rather than drawn as zero, and a zero stays
// zero: an asset sitting at its recorded high is a reading, not a gap.
export function deepestDrawdowns(rows = [], limit = 8) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ row, pct: num(row?.drawdownPct) }))
    .filter(entry => entry.pct != null && entry.pct <= 0)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, Math.max(0, limit))
}

export default function MarketsCharts({ snapshot = null, macro = null, macroError = null, macroLoading = false, rows = [], chains = [], categories = [], onChain, onCategory, onOpenAsset }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [note, setNote] = useState('')

  const up = num(snapshot?.up24h), down = num(snapshot?.down24h)
  const tracked = num(snapshot?.trackedAssets)
  const breadth = breadthPct(snapshot)

  const btc = num(macro?.btc_dominance_pct), eth = num(macro?.eth_dominance_pct)
  const stable = stablecoinSharePct(macro)
  // "Other" is the remainder of the same 100%, so the four readings always add
  // up to the whole rather than to whatever the provider happened to report.
  const other = Math.max(0, 100 - (btc ?? 0) - (eth ?? 0) - (stable ?? 0))
  const dominanceSeries = [
    { key: 'btc', label: t('markets.dominance_btc', { defaultValue: 'BTC' }), value: btc, max: 100, tone: 'accent' },
    { key: 'eth', label: t('markets.dominance_eth', { defaultValue: 'ETH' }), value: eth, max: 100, tone: 'blue' },
    ...(stable == null ? [] : [{ key: 'stablecoins', label: t('markets.dominance_stablecoins', { defaultValue: 'Stablecoins' }), value: stable, max: 100, tone: 'muted' }]),
    { key: 'other', label: t('markets.dominance_other', { defaultValue: 'Other' }), value: other, max: 100, tone: 'fourth' },
  ]
  // A failed read says why; a read that returned nothing says it is empty; a
  // read that returned a row without the two dominance figures is a failure
  // with its own reason rather than a ring of silent zeros.
  const dominanceState = macroError ? 'error' : macroLoading && !macro ? 'empty' : !macro ? 'empty' : (btc == null || eth == null) ? 'error' : 'ready'
  const dominanceReason = macroError
    ? (typeof macroError === 'string' ? macroError : t('markets.macro_failed', { defaultValue: 'Global observations could not be read.' }))
    : t('markets.dominance_incomplete', { defaultValue: 'The latest global observation did not report BTC and ETH dominance.' })

  const cells = chains.map(row => ({ t: row.chain, value: num(row.avg_change_24h_pct), label: row.chain }))

  // Arcs carry the MAGNITUDE of the fall, on one scale shared by the whole
  // figure, so the deepest row fills its ring and the rest are read against it.
  // The floor keeps a quiet page (everything within a few percent) from drawing
  // one full ring and seven empty ones.
  const drawdowns = deepestDrawdowns(rows, 8)
  const drawdownMax = Math.max(10, ...drawdowns.map(entry => Math.abs(entry.pct)))
  // The value handed to the ring is unsigned; the label re-signs it, so a row
  // sitting exactly at its recorded high reads "0.00%" and not "-0.00%".
  const drawdownSeries = drawdowns.map(({ row, pct }) => ({
    key: `${row.sourceProvider || 'unknown'}:${row.providerId || row.symbol}`,
    label: row.symbol || row.normalizedSymbol || row.displayName || row.providerId,
    value: Math.abs(pct), max: drawdownMax, tone: drawdownTone(Math.abs(pct)), href: row.detailHref || null,
    windowDays: num(row.recordedWindowDays), highDate: row.recordedHighDate || null,
  }))
  // One window sentence for the whole figure: the shortest recorded window on
  // the page, because a claim that holds for every row is the only honest one.
  const drawdownWindow = drawdownSeries.map(s => s.windowDays).filter(days => days != null).sort((a, b) => a - b)[0] ?? null

  const openDominance = series => {
    setNote('')
    if (series?.key === 'btc') { onOpenAsset?.(BTC_ROUTE); return }
    if (series?.key === 'eth') { onOpenAsset?.(ETH_ROUTE); return }
    if (series?.key === 'stablecoins') {
      const category = (categories || []).find(value => /stablecoin/i.test(String(value)))
      if (category) { onCategory?.(category); return }
      setNote(t('markets.dominance_no_stablecoin_category', { defaultValue: 'This catalogue does not publish a stablecoin category, so the screen was left unchanged.' }))
      return
    }
    setNote(t('markets.dominance_other_note', { defaultValue: 'Everything outside BTC, ETH and stablecoins. Use the filters to narrow the screen.' }))
  }

  return (
    <section className="intel-markets-figures space-y-2" aria-label={t('markets.figures', { defaultValue: 'Market figures' })}>
      <div style={ROW}>
        <RadialGauge
          title={t('markets.breadth_title', { defaultValue: 'Market breadth' })}
          description={up == null || down == null
            ? t('markets.breadth_unknown', { defaultValue: 'The screen has not reported a 24h up/down split yet.' })
            : t('markets.breadth_sub', { up, down, tracked: tracked ?? up + down, defaultValue: '{{up}} up · {{down}} down of {{tracked}} tracked' })}
          value={breadth ?? 0}
          min={0}
          max={100}
          zones={[
            { to: 35, label: t('markets.breadth_weak', { defaultValue: 'Weak' }), tone: 'red' },
            { to: 65, label: t('markets.breadth_mixed', { defaultValue: 'Mixed' }), tone: 'yellow' },
            { to: 100, label: t('markets.breadth_broad', { defaultValue: 'Broad' }), tone: 'green' },
          ]}
          formatValue={share}
          state={breadth == null ? 'empty' : 'ready'}
        />
        <RadialBars
          title={t('markets.dominance_title', { defaultValue: 'Dominance' })}
          description={t('markets.dominance_sub', { defaultValue: 'Share of total market capitalisation. Select a ring to open that asset or screen.' })}
          series={dominanceSeries}
          formatValue={share}
          state={dominanceState}
          reason={dominanceReason}
          onSelect={openDominance}
        />
        <HeatStrip
          title={t('markets.chains_title', { defaultValue: 'Chains' })}
          description={t('markets.chains_sub', { defaultValue: 'Average 24h move per chain. Select a chain to filter the screen.' })}
          cells={cells}
          columns={6}
          formatValue={formatPct}
          state={cells.length ? 'ready' : 'empty'}
          onSelect={cell => { setNote(''); if (cell?.t) onChain?.(cell.t) }}
        />
        <RadialBars
          title={t('markets.drawdown_title_figure', { defaultValue: 'Deepest drawdowns on this screen' })}
          description={!drawdownSeries.length
            ? t('markets.drawdown_empty', { defaultValue: 'No asset on this page has two recorded days yet, so no distance from a high can be measured.' })
            : drawdownWindow == null
              ? t('markets.drawdown_sub_unknown', { defaultValue: 'How far the assets on this page have fallen from the highest price this workspace has recorded. Select a ring to open that asset.' })
              : t('markets.drawdown_sub', { days: drawdownWindow, defaultValue: 'How far the assets on this page have fallen from their high over the last {{days}} recorded days. Select a ring to open that asset.' })}
          series={drawdownSeries}
          formatValue={value => formatPct(-(num(value) ?? 0))}
          state={drawdownSeries.length ? 'ready' : 'empty'}
          onSelect={series => { setNote(''); if (series?.href) onOpenAsset?.(series.href) }}
        />
      </div>
      <p role="status" className="text-[12px] text-[var(--fg-4)] min-h-[1.2em]">{note}</p>
    </section>
  )
}
