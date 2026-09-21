import React from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Trash2, Briefcase, Check } from 'lucide-react'
import TokenAvatar from './TokenAvatar'
import CopyAddress from './CopyAddress'
import MarketSignalBadge from './MarketSignalBadge'
import { entityDisplay } from '../lib/entity-display'

// One tracked item, read as a person reads it: a logo, a name, a symbol and a
// chain. The contract address is kept beside them as a shortened, copyable
// label — it is how you carry the token somewhere else, never the row's title.
// Before this the row printed entity.canonical_ref_key, which for a token is
// the raw mint or contract, so a list read as a wall of addresses.

export const HAS_HOLDING = new Set(['token', 'defi'])

export default function WatchlistRow({
  item, index, total, identities, ctxMap, ordering, promoted,
  fallbackHref, onMove, onPin, onRemove, onAddToPortfolio, holdingEditor,
}) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const entity = item.entity || {}
  const display = entityDisplay(item, identities)
  const title = display.name || display.symbol || entity.asset_id || entity.canonical_ref_key
  const ctxKey = String(display.symbol || '').toUpperCase()
  const href = display.href || fallbackHref || '/intel'
  const previous = index > 0 ? total[index - 1] : null
  const next = index < total.length - 1 ? total[index + 1] : null

  return (
    <div className="intel-watchlist-row border-b border-[var(--border-default)] py-3 flex items-center gap-3 flex-wrap">
      <div className="flex gap-1">
        <button className="btn btn--quiet btn--sm" aria-label={`Move ${title} up`}
          disabled={ordering || index === 0 || !!previous?.is_pinned !== !!item.is_pinned} onClick={() => onMove(index, -1)}>↑</button>
        <button className="btn btn--quiet btn--sm" aria-label={`Move ${title} down`}
          disabled={ordering || index === total.length - 1 || !!next?.is_pinned !== !!item.is_pinned} onClick={() => onMove(index, 1)}>↓</button>
        <button className="intel-text-link" aria-label={`${item.is_pinned ? 'Unpin' : 'Pin'} ${title}`}
          disabled={ordering} onClick={() => onPin(item)}>{item.is_pinned ? 'Unpin' : 'Pin'}</button>
      </div>
      <span className="text-[10px] uppercase text-[var(--fg-4)]">{t(`watchlist.types.${item.item_type}`, { defaultValue: item.item_type })}</span>
      <TokenAvatar src={display.logo} symbol={display.symbol} name={display.name} size="sm" />
      <Link to={href} className="flex-1 min-w-0">
        <div className="text-sm text-[var(--fg-1)] truncate flex items-center gap-1.5">
          <span>{title}</span>
          {display.symbol && display.name && <span className="text-[11px] uppercase text-[var(--fg-4)]">{display.symbol}</span>}
          <ExternalLink className="h-3 w-3 text-[var(--fg-5)]" />
        </div>
        {/* An empty identity says why in words rather than leaving a bare row. */}
        {display.unnamed && (
          <div className="text-[11px] text-[var(--fg-4)]">
            {t('watchlist.unnamed', { defaultValue: 'No source we hold has named this token yet. Its contract address is beside it.' })}
          </div>
        )}
      </Link>
      {display.address && <CopyAddress value={display.address} className="text-[11px]" />}
      {ctxMap?.[ctxKey]?.direction && <MarketSignalBadge direction={ctxMap[ctxKey].direction} size="sm" />}
      {HAS_HOLDING.has(item.item_type) && holdingEditor}
      {HAS_HOLDING.has(item.item_type) && Number(item.holding_amount) > 0 && (
        <button onClick={() => onAddToPortfolio(item)} aria-label="add to portfolio"
          title={t('watchlist.add_to_portfolio', { defaultValue: 'Add to Portfolio (creates a manual transaction)' })}
          className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-[var(--accent)] hover:bg-[var(--bg-2)]">
          {promoted ? <Check className="h-4 w-4 text-[var(--ok)]" /> : <Briefcase className="h-4 w-4" />}
        </button>
      )}
      {display.chainLabel && <span className="text-[11px] text-[var(--fg-4)]">{display.chainLabel}</span>}
      <button onClick={() => onRemove(item.id)} aria-label="remove"
        className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-red-400 hover:bg-[var(--bg-2)]">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}
