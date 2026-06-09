// Investor Intel — Portfolio Tracker: read-only wallet sync.
//
// READ-ONLY. Connecting reads only the PUBLIC address. The one optional signature
// proves ownership of a message that explicitly disclaims any transaction — we
// NEVER request a transaction, swap, approval, private key, or seed phrase.
// Self-contained Solana providers (mirrors WalletLinkSection) so the rest of
// Intel needs no Solana deps at the top level.

import React, { useState, useMemo, useCallback, useEffect } from 'react'
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react'
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { isAddress, getAddress } from 'viem'
import { ShieldCheck, Wallet, RefreshCw, Trash2, Pause, Play, ExternalLink, AlertTriangle, Loader2 } from 'lucide-react'
import '../../styles/wallet-adapter.css'
import { addSource, removeSource, pauseSource, syncPortfolio } from '../lib/portfolio-api'
import { CHAINS, getChain, isEvmFamily, explorerAddressUrl, loadChainSupportLevels, supportLevelFor } from '../lib/chains'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://api.eitherway.ai'
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const shortAddr = (a) => a ? `${a.slice(0, 4)}…${a.slice(-4)}` : ''
const IMPORTABLE = new Set(['full_history_pnl', 'beta_history', 'balance_only'])
// Registry-driven explorer link (Solscan/Etherscan-family/HyperEVM/…) — no hardcoding.
const explorerUrl = (s) => explorerAddressUrl(s.chain === 'bsc' ? 'bnb' : s.chain, s.address) || `https://solscan.io/account/${s.address}`

function Panel({ supabase, orgId, userId, portfolioId, sources, onChange, t }) {
  const { publicKey, signMessage, connected } = useWallet()
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const [solInput, setSolInput] = useState('')
  const [evmInput, setEvmInput] = useState('')
  const [evmChain, setEvmChain] = useState('evm')   // 'evm' = scan every EVM chain
  const [supportMap, setSupportMap] = useState({})

  useEffect(() => {
    let on = true
    loadChainSupportLevels(supabase).then((m) => { if (on) setSupportMap(m) }).catch(() => {})
    return () => { on = false }
  }, [supabase])

  // EVM chains grouped by runtime support level (seeded by migration 184 + the
  // capability probe). Only importable levels appear in the picker; HyperEVM /
  // Sei carry clarifying notes.
  const evmGroups = useMemo(() => {
    const groups = { full_history_pnl: [], beta_history: [], balance_only: [], coming_soon: [] }
    for (const c of CHAINS) {
      if (!isEvmFamily(c.id)) continue
      const lvl = supportLevelFor(c.id, supportMap)
      ;(groups[lvl] || groups.coming_soon).push(c)
    }
    return groups
  }, [supportMap])
  const selLevel = supportLevelFor(evmChain, supportMap)
  const selNote = getChain(evmChain)?.note

  const refresh = useCallback(() => { onChange?.() }, [onChange])

  const addConnected = useCallback(async () => {
    if (!publicKey) return
    setBusy('connect'); setErr(null)
    try {
      await addSource(supabase, orgId, userId, portfolioId, { sourceType: 'wallet_connect', provider: 'solflare', address: publicKey.toBase58(), chain: 'solana', connected: true, verified: false })
      await syncPortfolio(supabase, orgId, portfolioId, {})
      refresh()
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }, [publicKey, supabase, orgId, userId, portfolioId])

  const proveOwnership = useCallback(async () => {
    if (!publicKey || !signMessage) return
    setBusy('sign'); setErr(null)
    try {
      const nonce = crypto.randomUUID()
      const message = `Verify ownership of this wallet for Investor Intel (read-only portfolio tracking).\n\nNonce: ${nonce}\nTimestamp: ${Date.now()}\n\nNo transaction. No gas. No permission to move funds.`
      await signMessage(new TextEncoder().encode(message))
      // signature succeeded -> mark the source ownership-signed (informational)
      await supabase.from('investor_portfolio_sources')
        .update({ verified: true, verified_at: new Date().toISOString(), verification_method: 'solflare_message_signature' })
        .eq('portfolio_id', portfolioId).eq('address', publicKey.toBase58())
      refresh()
    } catch (e) {
      if (e?.message?.includes('User rejected') || e?.name === 'WalletSignMessageError') { setBusy(null); return }
      setErr(e.message)
    } finally { setBusy(null) }
  }, [publicKey, signMessage, supabase, portfolioId])

  const importSol = useCallback(async () => {
    const a = solInput.trim()
    if (!SOL_RE.test(a)) { setErr(t('portfolio.invalid_solana', { defaultValue: 'Enter a valid Solana address.' })); return }
    setBusy('sol'); setErr(null)
    try {
      await addSource(supabase, orgId, userId, portfolioId, { sourceType: 'wallet_address', provider: 'solana_address', address: a, chain: 'solana' })
      setSolInput(''); await syncPortfolio(supabase, orgId, portfolioId, {}); refresh()
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }, [solInput, supabase, orgId, userId, portfolioId])

  const importEvm = useCallback(async () => {
    const raw = evmInput.trim()
    if (!isAddress(raw)) { setErr(t('portfolio.invalid_evm', { defaultValue: 'Enter a valid 0x… address.' })); return }
    setBusy('evm'); setErr(null)
    try {
      await addSource(supabase, orgId, userId, portfolioId, { sourceType: 'wallet_address', provider: 'evm_address', address: getAddress(raw).toLowerCase(), chain: evmChain })
      setEvmInput(''); await syncPortfolio(supabase, orgId, portfolioId, {}); refresh()
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }, [evmInput, evmChain, supabase, orgId, userId, portfolioId])

  const onSync = useCallback(async (sourceId) => {
    setBusy(`sync-${sourceId}`); setErr(null)
    try { await syncPortfolio(supabase, orgId, portfolioId, { sourceId }); refresh() }
    catch (e) { setErr(e.message) } finally { setBusy(null) }
  }, [supabase, orgId, portfolioId])

  const onPause = useCallback(async (s) => { try { await pauseSource(supabase, s.id, s.status !== 'paused'); refresh() } catch (e) { setErr(e.message) } }, [supabase])
  const onRemove = useCallback(async (s) => {
    const deactivate = window.confirm(t('portfolio.remove_keep_history', { defaultValue: 'Keep this source\'s historical transactions? OK = deactivate (keep history); Cancel = delete everything from this source.' }))
    try { await removeSource(supabase, s.id, { deactivate }); refresh() } catch (e) { setErr(e.message) }
  }, [supabase])

  const walletSources = (sources || []).filter((s) => s.source_type !== 'manual')

  return (
    <div className="space-y-3">
      <div className="card--flat p-3 text-[12px] text-[var(--fg-3)] flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--ok)]" />
        <span>{t('portfolio.safety', { defaultValue: 'Investor Intel is read-only. We never request transactions, swaps, approvals, or your private keys. Connecting a wallet shares only your public address.' })}</span>
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        {/* Connect Solflare */}
        <div className="card p-3 space-y-2">
          <div className="eyebrow flex items-center gap-1.5"><Wallet className="h-3.5 w-3.5" /> {t('portfolio.connect_solflare', { defaultValue: 'Connect Solflare (read-only)' })}</div>
          <WalletMultiButton style={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', height: '36px', fontSize: '12px', fontWeight: 500, width: '100%' }} />
          {connected && publicKey && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-[var(--fg-4)] font-mono">{shortAddr(publicKey.toBase58())}</div>
              <button onClick={addConnected} disabled={busy === 'connect'} className="btn btn--primary btn--sm w-full">
                {busy === 'connect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('portfolio.track_wallet', { defaultValue: 'Track (read-only)' })}
              </button>
              {signMessage && (
                <button onClick={proveOwnership} disabled={busy === 'sign'} className="btn btn--ghost btn--sm w-full">
                  {busy === 'sign' ? t('portfolio.awaiting_signature', { defaultValue: 'Waiting for signature…' }) : t('portfolio.prove_ownership', { defaultValue: 'Prove ownership (optional)' })}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Solana address */}
        <div className="card p-3 space-y-2">
          <div className="eyebrow">{t('portfolio.import_solana', { defaultValue: 'Import Solana address' })}</div>
          <input className="input w-full text-[12px] font-mono" placeholder="So1…" value={solInput} onChange={(e) => setSolInput(e.target.value)} />
          <button onClick={importSol} disabled={busy === 'sol' || !solInput.trim()} className="btn btn--ghost btn--sm w-full">{busy === 'sol' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('portfolio.import', { defaultValue: 'Import' })}</button>
        </div>

        {/* EVM address */}
        <div className="card p-3 space-y-2">
          <div className="eyebrow">{t('portfolio.import_evm', { defaultValue: 'Import EVM address' })}</div>
          <input className="input w-full text-[12px] font-mono" placeholder="0x…" value={evmInput} onChange={(e) => setEvmInput(e.target.value)} />
          <select className="select w-full text-[12px]" value={evmChain} onChange={(e) => setEvmChain(e.target.value)}>
            <option value="evm">{t('portfolio.support.all_evm', { defaultValue: 'All EVM chains (recommended)' })}</option>
            {[
              ['full_history_pnl', t('portfolio.support.full_history_pnl', { defaultValue: 'Full portfolio support' })],
              ['beta_history', t('portfolio.support.beta_history', { defaultValue: 'Beta history' })],
              ['balance_only', t('portfolio.support.balance_only', { defaultValue: 'Balance only' })],
            ].map(([lvl, label]) => evmGroups[lvl].length ? (
              <optgroup key={lvl} label={label}>{evmGroups[lvl].map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>
            ) : null)}
            {evmGroups.coming_soon.length ? (
              <optgroup label={t('portfolio.support.coming_soon', { defaultValue: 'Coming soon' })}>
                {evmGroups.coming_soon.map((c) => <option key={c.id} value={c.id} disabled>{c.label}</option>)}
              </optgroup>
            ) : null}
          </select>
          <button onClick={importEvm} disabled={busy === 'evm' || !evmInput.trim() || (evmChain !== 'evm' && !IMPORTABLE.has(selLevel))} className="btn btn--ghost btn--sm w-full">{busy === 'evm' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('portfolio.import', { defaultValue: 'Import' })}</button>
          <div className="text-[10px] text-[var(--fg-5)]">
            {evmChain === 'evm' ? t('portfolio.support_note.all_evm', { defaultValue: 'Scans every supported EVM chain for this address and imports balances + history wherever it has activity.' })
              : selNote === 'hyperevm' ? t('portfolio.chain_note.hyperevm', { defaultValue: 'HyperEVM supported; HyperCore trading history needs a later adapter.' })
              : selNote === 'sei_evm' ? t('portfolio.chain_note.sei_evm', { defaultValue: 'Sei here is EVM-style; not Cosmos-native Sei.' })
                : selLevel === 'balance_only' ? t('portfolio.support_note.balance_only', { defaultValue: 'Balances only — cost basis and P&L are not available for this chain.' })
                  : selLevel === 'beta_history' ? t('portfolio.support_note.beta_history', { defaultValue: 'Transaction history is in beta and may be incomplete.' })
                    : t('portfolio.support_note.full', { defaultValue: 'Balances, transactions, prices, and P&L.' })}
          </div>
        </div>
      </div>

      {err && <div className="card--flat p-2.5 text-[12px] text-red-400 flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5" />{err}</div>}

      {walletSources.length > 0 && (
        <div className="space-y-1.5">
          {walletSources.map((s) => (
            <div key={s.id} className="card--flat p-2.5 flex items-center gap-2.5 text-[12px]">
              <span className="chip chip--accent text-[9px] uppercase">{s.provider.replace('_address', '').replace('_connect', '')}</span>
              <span className="font-mono text-[var(--fg-2)]">{shortAddr(s.address)}</span>
              {s.chain && <span className="text-[10px] text-[var(--fg-5)]">{s.chain}</span>}
              {s.verified
                ? <span className="chip chip--ok text-[9px] flex items-center gap-1"><ShieldCheck className="h-3 w-3" />{t('portfolio.verified', { defaultValue: 'Ownership signed' })}</span>
                : <span className="chip text-[9px] text-[var(--fg-4)]">{t('portfolio.unverified', { defaultValue: 'Read-only' })}</span>}
              <span className={`text-[10px] ${s.status === 'error' || s.holdings_sync_status === 'error' ? 'text-red-400' : s.status === 'paused' ? 'text-amber-400' : 'text-[var(--fg-5)]'}`}>
                {s.status === 'paused' ? t('portfolio.status.paused', { defaultValue: 'Paused' }) : t(`portfolio.status.${s.holdings_sync_status || 'ok'}`, { defaultValue: s.holdings_sync_status || 'synced' })}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <a href={explorerUrl(s)} target="_blank" rel="noopener noreferrer" className="p-1 text-[var(--fg-5)] hover:text-[var(--fg-2)]" title="Explorer"><ExternalLink className="h-3.5 w-3.5" /></a>
                <button onClick={() => onSync(s.id)} disabled={busy === `sync-${s.id}`} className="p-1 text-[var(--fg-4)] hover:text-[var(--accent)]" title={t('portfolio.sync_now', { defaultValue: 'Sync now' })}>
                  <RefreshCw className={`h-3.5 w-3.5 ${busy === `sync-${s.id}` ? 'animate-spin' : ''}`} />
                </button>
                <button onClick={() => onPause(s)} className="p-1 text-[var(--fg-4)] hover:text-amber-400" title={t('portfolio.pause', { defaultValue: 'Pause' })}>
                  {s.status === 'paused' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                </button>
                <button onClick={() => onRemove(s)} className="p-1 text-[var(--fg-4)] hover:text-red-400" title={t('portfolio.remove', { defaultValue: 'Remove' })}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function WalletSyncPanel(props) {
  const endpoint = useMemo(() => `${API_BASE_URL}/api/solana/rpc/mainnet`, [])
  const wallets = useMemo(() => [], [])
  const config = useMemo(() => ({ commitment: 'confirmed', wsEndpoint: '', disableRetryOnRateLimit: false }), [])
  return (
    <ConnectionProvider endpoint={endpoint} config={config}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          <Panel {...props} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
