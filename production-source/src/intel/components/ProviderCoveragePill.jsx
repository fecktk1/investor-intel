import React from 'react'

// Which exchanges cover an asset. A confirming provider (its read matches the
// blended direction) is highlighted. A badge means: listed + active + fresh +
// meaningful volume + pair selected — set by the refresh job, not the client.
const LABELS = { binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', kucoin: 'KuCoin' }

export default function ProviderCoveragePill({ providers = [], confirming = [], size }) {
  if (!providers?.length) return null
  const conf = new Set(confirming || [])
  const sz = size === 'sm' ? 'text-[9px]' : 'text-[10px]'
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {providers.map((p) => (
        <span key={p} className={`chip ${sz} ${conf.has(p) ? 'chip--ok' : ''}`} title={conf.has(p) ? 'confirms the read' : 'listed'}>{LABELS[p] || p}</span>
      ))}
    </span>
  )
}
