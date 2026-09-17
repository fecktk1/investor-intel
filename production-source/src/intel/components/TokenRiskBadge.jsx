import React, { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, ShieldX, Loader2 } from 'lucide-react'
import { useSupabase } from '../../lib/useSupabase'

// v3.1 lazy risk badge. Reads the cached deterministic risk score
// (token_risk_scores, global-read). When given a contract {chain,address} and no
// fresh score exists, it calls intel-token-risk-enrich to score THIS token on
// demand (Birdeye security + CoinGecko GT), showing "Scanning…" until it lands.
// Symbol-only (e.g. a native-asset Markets page) reads cache but never enriches.
// Renders nothing when unrated / not a contract token.
const CHAIN_MAP = {
  sol: 'solana', solana: 'solana', eth: 'ethereum', ethereum: 'ethereum', bnb: 'bsc', bsc: 'bsc',
  'binance-smart-chain': 'bsc', matic: 'polygon', polygon: 'polygon', 'polygon-pos': 'polygon',
  arbitrum: 'arbitrum', 'arbitrum-one': 'arbitrum', base: 'base', avax: 'avalanche', avalanche: 'avalanche', optimism: 'optimism',
}
const normChain = (c) => { const x = String(c || '').toLowerCase().trim(); return CHAIN_MAP[x] || x }
const SEL = 'symbol, score, hard_fail, hard_fail_flags, penalties, cross_provider_confidence, stale_after, computed_at'

export default function TokenRiskBadge({ chain, address, symbol, source = 'lookup' }) {
  const { supabase } = useSupabase()
  const [row, setRow] = useState(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    let alive = true
    const ch = normChain(chain)
    const sym = symbol ? String(symbol).toUpperCase() : null
    if (!supabase || (!address && !sym)) return
    ;(async () => {
      let cached = null
      try {
        if (ch && address) {
          const { data } = await supabase.from('token_risk_scores').select(SEL).eq('chain', ch).eq('token_address', address).maybeSingle()
          cached = data
        } else if (sym) {
          const { data } = await supabase.from('token_risk_scores').select(SEL).eq('symbol', sym).order('computed_at', { ascending: false }).limit(1).maybeSingle()
          cached = data
        }
      } catch { /* global-read miss → no badge */ }
      if (!alive) return
      if (cached) setRow(cached)
      const fresh = cached && cached.stale_after && new Date(cached.stale_after).getTime() > Date.now()
      // Lazy enrich only when we have a contract address and no fresh score.
      if (ch && address && (!cached || !fresh)) {
        setScanning(true)
        try {
          const { data } = await supabase.functions.invoke('intel-token-risk-enrich', { body: { chain: ch, address, symbol: sym, source } })
          if (!alive) return
          if (data?.score && typeof data.score.score === 'number') setRow((p) => ({ ...(p || {}), ...data.score }))
          else if ((data?.enrichable === false || data?.rated === false) && !cached) setRow(null)
        } catch { /* keep any cached */ }
        finally { if (alive) setScanning(false) }
      }
    })()
    return () => { alive = false }
  }, [supabase, chain, address, symbol, source])

  if (scanning && !row) {
    return (
      <span className="chip text-[11px] inline-flex items-center" title="Scanning the token contract for risk…">
        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />Scanning risk…
      </span>
    )
  }
  if (!row || typeof row.score !== 'number') return null
  const danger = row.hard_fail || row.score < 40
  const warn = !danger && row.score < 70
  const cls = danger ? 'chip chip--err' : warn ? 'chip chip--info' : 'chip chip--ok'
  const Icon = danger ? ShieldX : warn ? ShieldAlert : ShieldCheck
  const flags = (row.hard_fail_flags || []).join(', ')
  const concerns = Object.keys(row.penalties || {}).join(', ')
  const conf = row.cross_provider_confidence != null ? ` · confidence ${row.cross_provider_confidence}` : ''
  const title = `Token risk ${row.score}/100${row.hard_fail && flags ? ` (HIGH RISK: ${flags})` : ''}${concerns ? ` · concerns: ${concerns}` : ''}${conf}. Deterministic (Birdeye security + CoinGecko GT). Not advice.`

  return (
    <span className={`${cls} text-[11px] inline-flex items-center`} title={title}>
      <Icon className="h-3.5 w-3.5 mr-1" />
      {row.hard_fail ? 'High risk' : `Risk ${row.score}/100`}
    </span>
  )
}
