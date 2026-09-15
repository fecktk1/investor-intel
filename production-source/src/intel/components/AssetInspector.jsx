import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import TokenAvatar from './TokenAvatar'
import { marketIdentityParams } from '../lib/asset-identity'
import { fmtPrice, fmtPct, fmtVol } from '../lib/market-format'

// Frozen selection from the authorized, loaded screen. No fetch, AI or hover work.
export default function AssetInspector({ row, onClose }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const location = useLocation(), panel = useRef(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement
    panel.current?.querySelector('button')?.focus()
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); close.current() }
      if (event.key === 'Tab') {
        const nodes = [...panel.current.querySelectorAll('button,a[href]')]
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus() }
      }
    }
    const node = panel.current
    node.addEventListener('keydown', key)
    return () => { node.removeEventListener('keydown', key); previous?.isConnected && previous.focus?.() }
  }, [])
  const fields = [
    [t('markets.priceLabel', { defaultValue: 'Price' }), fmtPrice(row.price)],
    ['24h', fmtPct(row.change24hPct)],
    [t('markets.volLabel', { defaultValue: '24h volume' }), fmtVol(row.volumeQuote24h)],
    [t('markets.marketCap', { defaultValue: 'Market cap' }), fmtVol(row.marketCap)],
  ]
  const time = value => value && Number.isFinite(Date.parse(value)) ? <time dateTime={value}>{new Date(value).toLocaleString(undefined, { timeZoneName: 'short' })}</time> : t('inspector.unknown_time', { defaultValue: 'Unknown' })
  const detailHref = /^\/intel\//.test(row.detailHref || '') ? row.detailHref : row.sourceProvider && row.providerId != null ? `/intel/markets/${encodeURIComponent(row.symbol || row.providerId)}${marketIdentityParams(row)}` : row.canonicalAssetKey ? `/intel/asset/${encodeURIComponent(row.canonicalAssetKey)}` : null
  return createPortal(<div className="intel-inspector-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <aside ref={panel} role="dialog" aria-modal="true" aria-labelledby="intel-inspector-title" className="intel-asset-inspector">
      <header><span>{t('inspector.preview', { defaultValue: 'Asset preview' })}</span><button type="button" onClick={onClose}>{t('common.close', { defaultValue: 'Close' })} <kbd>Esc</kbd></button></header>
      <div className="intel-inspector-body">
        <div className="flex items-center gap-3"><TokenAvatar src={row.imageUrl} symbol={row.symbol} size="lg"/><div><h2 id="intel-inspector-title">{row.displayName || row.symbol}</h2><p>{row.symbol} · {row.chain || t('inspector.market_wide', { defaultValue: 'Market-wide asset' })}</p></div></div>
        <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <h3>{t('inspector.snapshot', { defaultValue: 'Selected screen snapshot' })}</h3>
        <p>{row.sourceProvider || t('inspector.provider_unknown', { defaultValue: 'Source not reported' })}{row.providerId != null ? ` · ID ${row.providerId}` : ''}</p>
        <p>{t('inspector.observed', { defaultValue: 'Observed' })}: {time(row.asOf)}</p>
        <p>{t('inspector.recorded', { defaultValue: 'Last refreshed' })}: {time(row.lastRefreshedAt)}</p>
        <p>{t('inspector.state', { defaultValue: 'Source state' })}: {row.freshness || t('inspector.unknown', { defaultValue: 'Not reported' })}</p>
        <p>{t('inspector.venue', { defaultValue: 'Exchange coverage' })}: {row.cex?.availableCount > 0 ? row.cex.availableCount : row.cex?.coverageState === 'verified_absent' ? t('inspector.no_venue', { defaultValue: 'No covered venue' }) : t('markets.coverage_unknown', { defaultValue: 'Not verified' })}</p>
        <p className="intel-inspector-note">{t('inspector.context', { defaultValue: 'Open the dossier for the price chart, your selected portfolio, thesis history and evidence. This preview retains the screen observation you selected.' })}</p>
        {row.canonicalAssetKey && <details><summary>{t('asset.identity', { defaultValue: 'Asset identity' })}</summary><p className="break-all">{row.canonicalAssetKey}</p></details>}
      </div>
      <footer>{detailHref ? <Link className="btn btn--primary" to={detailHref} state={{ from: `${location.pathname}${location.search}` }} onClick={onClose}>{t('inspector.open', { defaultValue: 'Open asset dossier' })} →</Link> : <p>{t('inspector.identity_unavailable', { defaultValue: 'A verified asset identity is required to open the dossier.' })}</p>}</footer>
    </aside>
  </div>, document.querySelector('.intel-root') || document.body)
}
