import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { ChartFrame, ChartTable, markProps, useChartText } from '../charts/frame'
import { TONES, gridStroke, useReducedMotion } from '../charts/theme'
import { fraction } from '../charts/geometry'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { fmtNum } from '../lib/market-format'

// Category agreement (CMC plan proposal 22, second figure). One cell per
// CoinMarketCap category; the darker the cell the more of that category's
// members carry a tag matching the category on their own catalogue row.
//
// WHAT IS ACTUALLY COMPARED. Each member of a CoinMarketCap category is joined
// to its OWN CoinMarketCap catalogue row and checked against that row's tags.
// That is a consistency check between the category list and the tag list of one
// catalogue — it is NOT a comparison with a CoinGecko row, and the caption says
// so in those words. A figure that let a reader believe two catalogues had been
// reconciled would be the whole value of the figure, inverted.
//
// The read returns the rows already ordered worst agreement first (nulls last),
// which is the order this figure is read in; that order is preserved rather than
// re-sorted by size.
//
// Built here rather than with the shared HeatStrip because a category with
// nothing comparable must NOT render as a pale cell: the shared strip maps a
// missing share onto the same faint accent as a real zero, and "no member could
// be compared" and "no member agreed" are different readings. The cell geometry,
// tokens and table twin are otherwise the strip's.

const CELL = 26, GAP = 4, PAD = 2, MAX_COLS = 10

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** One cell per category, in the order the read returned them. `share` is null
 *  whenever nothing in the category could be compared; that cell is drawn as a
 *  distinct outlined mark rather than as a faint one. */
export function disagreementCells(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && (row.categoryId != null || row.name))
    .map((row, index) => ({
      key: row.categoryId ?? row.name ?? index,
      label: row.name || String(row.categoryId ?? '—'),
      members: num(row.members),
      agreeing: num(row.agreeing),
      disagreeing: num(row.disagreeing),
      unknown: num(row.unknown),
      share: num(row.share),
      comparable: num(row.share) != null,
    }))
}

const sharePct = share => (share == null ? '—' : `${(share * 100).toFixed(1)}%`)

export default function CategoryDisagreement() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const text = useChartText()
  const reduced = useReducedMotion()
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })
  const [active, setActive] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('category_disagreement', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const payload = read.payload
  const cells = useMemo(() => disagreementCells(payload?.rows), [payload])
  // An empty member table answers with no rows and NO reason — an empty reading.
  // A reason on a successful read is a failed query behind it.
  const stated = read.status === 'unavailable' ? read.reason : (read.status === 'ready' ? (payload?.reason || null) : null)
  const state = stated ? 'error' : (read.status === 'ready' && cells.length) ? 'ready' : 'empty'
  const reason = stated ? captureReasonText(t, stated) : undefined

  const cols = Math.max(1, Math.min(MAX_COLS, cells.length || 1))
  const rowCount = Math.max(1, Math.ceil(cells.length / cols))
  const w = PAD * 2 + cols * CELL + (cols - 1) * GAP
  const h = PAD * 2 + rowCount * CELL + (rowCount - 1) * GAP

  const title = t('categories.agree_title', { defaultValue: 'Category tag agreement' })
  // The exact sentence about what is joined to what. Never shorten this to
  // "agreement between catalogues": nothing here crosses a catalogue boundary.
  const caption = t('categories.agree_caption', {
    defaultValue: 'Each category member is joined to its own CoinMarketCap catalogue row and compared with that row\'s tags. This is a consistency check between the category list and the tag list of one catalogue, not a comparison with a CoinGecko row.',
  })
  // What the comparison actually reached, so a thin catalogue is visible rather
  // than silently lowering every share.
  const scope = state === 'ready'
    ? t('categories.agree_scope', {
        categories: cells.length,
        compared: fmtNum(num(payload?.comparedAssets)),
        catalogue: fmtNum(num(payload?.catalogueRows)),
        min: num(payload?.minMembers) ?? 5,
        normaliser: payload?.normaliser || 'v1',
        defaultValue: '{{categories}} categories with at least {{min}} members; {{compared}} member assets were looked up and {{catalogue}} carried a catalogue row. Name normaliser {{normaliser}}.',
      })
    : ''

  const focused = cells.find(cell => cell.key === active) || null
  const readout = focused
    ? (focused.comparable
        ? t('categories.agree_readout', {
            name: focused.label, share: sharePct(focused.share),
            agreeing: fmtNum(focused.agreeing), disagreeing: fmtNum(focused.disagreeing),
            defaultValue: '{{name}} · {{share}} agree · {{agreeing}} tagged, {{disagreeing}} not',
          })
        : t('categories.agree_readout_none', { name: focused.label, defaultValue: '{{name}} · no member could be compared' }))
    : ''

  return (
    <section className="intel-category-agreement space-y-3" aria-label={title}>
      <ChartFrame
        t={text}
        title={title}
        description={`${t('categories.agree_sub', {
          defaultValue: 'One cell per category, least agreement first. A darker cell means more of that category\'s members carry a matching tag; an outlined cell had nothing that could be compared at all.',
        })} ${caption} ${t('categories.agree_clock', { defaultValue: 'The category member capture runs once a day at 01:35 UTC.' })}${scope ? ` ${scope}` : ''}`}
        state={state}
        reason={reason}
        readout={<p className="intel-chart-kit-readout" aria-live="polite">{readout}</p>}
        table={
          <ChartTable
            t={text}
            caption={`${title}. ${caption}`}
            columns={[
              t('categories.agree_col_category', { defaultValue: 'Category' }),
              t('categories.agree_col_members', { defaultValue: 'Members' }),
              t('categories.agree_col_agreeing', { defaultValue: 'Agreeing' }),
              t('categories.agree_col_disagreeing', { defaultValue: 'Disagreeing' }),
              t('categories.agree_col_unknown', { defaultValue: 'Unknown' }),
              t('categories.agree_col_share', { defaultValue: 'Share' }),
            ]}
            rows={cells.map(cell => [
              cell.label,
              fmtNum(cell.members),
              fmtNum(cell.agreeing),
              fmtNum(cell.disagreeing),
              fmtNum(cell.unknown),
              sharePct(cell.share),
            ])}
          />
        }
      >
        <svg viewBox={`0 0 ${w} ${h}`} role="img" style={{ maxWidth: `${w * 1.5}px` }}
          aria-label={`${title}. ${cells.length}. ${text('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
          {cells.map((cell, i) => {
            const col = i % cols
            const row = Math.floor(i / cols)
            const x = PAD + col * (CELL + GAP)
            const y = PAD + row * (CELL + GAP)
            const label = cell.comparable
              ? `${cell.label} ${sharePct(cell.share)}`
              : `${cell.label} ${t('categories.agree_not_comparable', { defaultValue: 'not comparable' })}`
            return (
              <g key={cell.key}
                {...markProps({ label, onActivate: () => setActive(cell.key), reduced })}
                onMouseEnter={() => setActive(cell.key)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(cell.key)}
                onBlur={() => setActive(null)}
                data-comparable={cell.comparable ? 'true' : 'false'}
              >
                <title>{label}</title>
                <rect
                  x={x} y={y} width={CELL} height={CELL}
                  fill={cell.comparable ? TONES.accent : 'none'}
                  fillOpacity={cell.comparable ? 0.08 + fraction(cell.share, 0, 1) * 0.87 : 0}
                  stroke={gridStroke} strokeWidth="1"
                />
                {/* Not-comparable is a different reading from zero agreement, so
                    it gets its own mark instead of the palest fill. */}
                {cell.comparable ? null : (
                  <line x1={x + 4} y1={y + CELL - 4} x2={x + CELL - 4} y2={y + 4} stroke={TONES.muted} strokeWidth="1.5" />
                )}
              </g>
            )
          })}
        </svg>
      </ChartFrame>
    </section>
  )
}
