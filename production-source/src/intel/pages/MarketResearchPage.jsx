import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { useMarketResearch } from '../lib/useMarketResearch'
import { EvidenceRecord, ResearchStatus,SharedResearchRefresh } from '../components/ResearchEvidence'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import IntelSurfaceGate from '../components/IntelSurfaceGate'
import { saveResearch } from '../lib/intel-data'
import { fmtPrice, fmtVol, fmtPct } from '../lib/market-format'
import TokenChart from '../components/TokenChart'
import RwaRelationships from '../components/RwaRelationships'
import MarketPairsEvidence from '../components/MarketPairsEvidence'
import {MarketContextHistory} from '../components/MarketContextHistory'
import ExchangeDisclosures from '../components/ExchangeDisclosures'
import DexDiscoveryTable from '../components/DexDiscoveryTable'
import {isDexDiscovery,CMC_DEX_NETWORKS} from '../../../supabase/functions/_shared/market-assets/cmc-dex.ts'

const VIEWS = {
  rwa: { title: 'Real-world assets', subtitle: 'Investigate tokenized assets, their issuers and available market evidence.', options: [['rwaList','Assets'],['issuers','Issuers']] },
  structure: { title: 'Market structure', subtitle: 'Examine derivatives venues, open interest, trading pairs and liquidations alongside existing liquidity research.', options: [['derivativeExchanges','Derivatives venues'],['derivativePairs','Derivatives pairs'],['liquidations','Global liquidations'],['liquidationAssets','Liquidations by asset'],['liquidationExchanges','Liquidations by exchange'],['marketPairs','Spot market pairs'],['dexPlatforms','CMC network coverage']] },
  discovery: { title: 'Market discovery', subtitle: 'Screen current listings, investigate attention and connect the evidence to your research.', options: [['listings','Listings'],['newListings','New listings'],['trending','Trending'],['gainers','Gainers and losers'],['mostVisited','Most visited'],['dexTrending','DEX trending'],['dexNew','DEX new contracts'],['dexMeme','DEX meme discovery'],['dexGainers','DEX gainers and losers'],['categories','Sectors and narratives'],['airdrops','Airdrops'],['content','Source content'],['community','Community attention']] },
  context: { title: 'Market context', subtitle: 'Compare broad market conditions, sentiment, dominance and index composition.', options: [['global','Global market'],['fearGreed','Fear and greed'],['fearGreedHistory','Sentiment history'],['altcoinSeason','Altcoin season'],['altcoinSeasonHistory','Altcoin season history'],['cmc100','CMC 100'],['cmc20','CMC 20'],['globalHistory','Historical market regime'],['cmc100History','CMC 100 history'],['cmc20History','CMC 20 history']] },
}
const PAGE = 25
const fmt = v => v == null ? '—' : typeof v === 'number' ? v.toLocaleString() : String(v)
const rowName = row => row.name || row.issuer_name || row.exchange_name || row.rwa_name || row.title || row.symbol || row.market_pair_symbol || row.market_pair || row.n || 'Record'
const rowId = row => row.rwa_id || row.issuer_id || row.id || row.crypto_id || row.exchange_id
const marketRow = row => row.id || row.crypto_id ? `/intel/markets/${encodeURIComponent(row.symbol || row.name)}?provider=coinmarketcap&id=${row.id || row.crypto_id}` : null
export function ResearchTable({ rows, capability, onOpen, t }) {
  const q = row => row.quote || {}
  const observed = row => { const time = row.last_updated || row.quote?.last_updated; return time ? new Date(time).toLocaleString() : '—' }
  const column = (key, label, read, numeric = true) => ({ key, label: t(`research.column_${key}`, { defaultValue: label }), read, numeric })
  let columns
  if (capability === 'derivativeExchanges') columns = [column('oi', 'Open interest (USD)', r => fmtVol(q(r).open_interest)), column('derivatives_volume', '24h derivatives volume (USD)', r => fmtVol(q(r).derivative_volume_usd ?? q(r).derivative_volume)), column('observed', 'Observed', observed, false)]
  else if (capability === 'liquidationExchanges') columns = ['1h','4h','24h'].map(period => column(`liquidations_${period}`, `${period} liquidations (USD)`, r => fmtVol(q(r)[`total_liquidations_${period}`]))).concat([column('observed','Observed',r => q(r).last_updated ? new Date(q(r).last_updated).toLocaleString() : 'Unreported',false)])
  else if (capability === 'derivativePairs') columns = [column('venue', 'Venue', r => r.exchange?.name || r.exchange?.exchange_name || '—', false), column('oi', 'Open interest (USD)', r => fmtVol(q(r).open_interest ?? r.exchangeReportedQuote?.open_interest)), column('funding', 'Reported funding rate', r => fmt(r.exchangeReportedQuote?.funding_rate)), column('observed', 'Observed', observed, false)]
  else if (capability === 'dexPlatforms') columns = [column('network_alias','Network alias',r=>r.dn||'Unreported',false),column('integration','Contract research',r=>CMC_DEX_NETWORKS.some(n=>n.platformId===r.id)?'Verified contract integration':'CMC network; product integration pending',false)]
  else if (capability === 'issuers') columns = [column('tokens', 'Linked tokens', r => fmt(r.num_tokens ?? r.num_assets ?? r.asset_count))]
  else if (capability === 'categories') columns = [column('assets', 'Assets', r => fmt(r.num_tokens)), column('market_cap', 'Market cap (USD)', r => fmtVol(r.market_cap)), column('volume', '24h volume (USD)', r => fmtVol(r.volume)), column('change', '24h change', r => fmtPct(r.avg_price_change))]
  else if (capability.startsWith('rwa')) columns = [column('type', 'Asset type', r => String(r.asset_type || '—').replaceAll('_',' '), false), column('tokenized_price', 'Tokenized price (USD)', r => fmtPrice(r.average_tokenized_price ?? q(r).average_tokenized_price)), column('value', 'Tokenized value (USD)', r => fmtVol(r.tokenized_market_cap ?? q(r).tokenized_market_cap)), column('volume', '24h volume (USD)', r => fmtVol(r.tokenized_volume_24h ?? q(r).tokenized_volume_24h)), column('quote_observed', 'Quote observed', r => q(r).last_updated ? new Date(q(r).last_updated).toLocaleString() : 'No dated quote', false)]
  else if (['content','community','airdrops'].includes(capability)) columns = [column('status', 'Status', r => r.status || '—', false), column('observed', 'Observed', observed, false)]
  else columns = [column('price', 'Price (USD)', r => fmtPrice(q(r).price)), column('market_cap', 'Market cap (USD)', r => fmtVol(q(r).market_cap)), column('volume', '24h volume (USD)', r => fmtVol(q(r).volume_24h)), column('change', '24h change', r => fmtPct(q(r).percent_change_24h))]
  return <div className="intel-table-scroll"><table><thead><tr><th scope="col">{t('research.name', { defaultValue: 'Name' })}</th>{columns.map(c => <th key={c.key} scope="col" className={c.numeric ? 'intel-number' : ''}>{c.label}</th>)}<th scope="col">{t('research.open', { defaultValue: 'Investigate' })}</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={`${rowId(row) || ''}:${index}`}>
      <th scope="row"><button type="button" className="text-left text-[var(--fg-1)]" onClick={() => onOpen(row)}><span className="block text-sm">{rowName(row)}</span><span className="block text-xs text-[var(--fg-4)]">{row.symbol || row.category || ''}</span></button></th>
      {columns.map(c => <td key={c.key} className={c.numeric ? 'intel-number' : ''}>{c.read(row)}</td>)}
      <td><button className="underline underline-offset-4 text-xs" onClick={() => onOpen(row)}>{t('research.evidence', { defaultValue: 'Evidence' })}</button>{['listings','newListings','trending','gainers','mostVisited'].includes(capability) && marketRow(row) && <Link className="block text-xs underline underline-offset-4 mt-2" to={marketRow(row)}>{t('research.asset_workspace', { defaultValue: 'Asset workspace' })}</Link>}</td>
    </tr>)}</tbody></table></div>
}

function Investigation({ row, capability, onClose, t }) {
  const { supabase, user } = useSupabase(), { org } = useProfile()
  const [note, setNote] = useState(''), [saved, setSaved] = useState(false), [error, setError] = useState(null), [saving, setSaving] = useState(false)
  const savingRef = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const rwa = capability.startsWith('rwa'), issuer = capability === 'issuers', category = capability === 'categories'
  const isCrypto = ['listings','newListings','trending','gainers','mostVisited'].includes(capability)
  const cryptoId = isCrypto ? row.id || row.crypto_id : null
  const exchangeId = ['derivativeExchanges','liquidationExchanges'].includes(capability) ? row.exchange_id : null
  const [venueInfoOpen,setVenueInfoOpen]=useState(false),[venueMarketsOpen,setVenueMarketsOpen]=useState(false)
  const venueInfo = useMarketResearch('exchangeInfo', { id: exchangeId }, !!exchangeId&&venueInfoOpen)
  const [venuePage,setVenuePage] = useState(0)
  const venuePairs = useMarketResearch('exchangeDerivativePairs', { exchange_id: exchangeId, start: venuePage * PAGE + 1, limit: PAGE }, !!exchangeId&&venueMarketsOpen)
  const rwaPairs = useMarketResearch('rwaPairs', { rwa_id: row.rwa_id, limit: PAGE }, rwa && !!row.rwa_id)
  const info = useMarketResearch(rwa ? 'rwaInfo' : issuer ? 'issuer' : category ? 'category' : 'metadata', rwa ? { rwa_id: row.rwa_id } : issuer ? { issuer_id: row.issuer_id || row.id } : { id: category ? row.id : cryptoId }, !!(rwa ? row.rwa_id : issuer ? row.issuer_id || row.id : category ? row.id : cryptoId))
  const quotes = useMarketResearch(rwa ? 'rwaQuotes' : 'quotes', rwa ? { rwa_id: row.rwa_id } : { id: cryptoId }, !!(rwa ? row.rwa_id : cryptoId && !category && !issuer))
  const [detailView, setDetailView] = useState('evidence')
  const [selectedIssuer, setSelectedIssuer] = useState(null)
  const issuerEvidence = useMarketResearch('issuer', { issuer_id: selectedIssuer, limit: PAGE }, !!selectedIssuer)
  const history = useMarketResearch(detailView === 'performance' ? 'performance' : detailView === 'ohlcv' ? 'ohlcv' : 'history', { id: cryptoId, ...(detailView === 'performance' ? { time_period: 'all_time' } : { count: 90 }) }, !!(cryptoId && !rwa && !issuer && !category && detailView !== 'evidence'))
  const candles = (history.result?.data?.rows || []).flatMap(item => (item.quotes || []).map(point => ({ t: point.timestamp || point.time_close, c: point.quote?.USD?.price ?? point.quote?.find?.(q => q.symbol === 'USD')?.price ?? point.quote?.USD?.close })))
  const pane = useRef(null)
  useEffect(() => { const previous = document.activeElement; const dialog = pane.current; dialog?.showModal(); return () => { dialog?.close(); previous?.focus?.() } }, [])
  const save = async () => { if(savingRef.current)return; savingRef.current=true;setSaving(true);setError(null); const savedNote=note; try { await saveResearch(supabase, org.id, user.id, { artifactId: null, title: rowName(row), snapshot: { summary: savedNote, source: 'CoinMarketCap', source_ref: { capability, id: rowId(row) }, recorded_at: new Date().toISOString() }, tags: ['investigation', capability], privateOwner: true }); if(mounted.current)setSaved(true) } catch (e) { if(mounted.current)setError(e.message) } finally { savingRef.current=false;if(mounted.current)setSaving(false) } }
  return <dialog className="intel-investigation" aria-label={`${rowName(row)} evidence`} ref={pane} onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="flex items-start justify-between gap-5"><div><p className="eyebrow">{t('research.evidence', { defaultValue: 'Evidence' })}</p><h2 className="page-title">{rowName(row)}</h2></div><button className="btn btn--quiet" onClick={onClose}>{t('common.close', { defaultValue: 'Close' })}</button></div>
    <details className="intel-source-record"><summary>{t('research.asset_background',{defaultValue:'Asset background and source record'})}</summary>{(rwa || issuer || category || isCrypto) && <ResearchStatus query={info}/>}{(info.result?.data?.rows?.length ? info.result.data.rows : [row]).map((item, index) => <EvidenceRecord key={index} record={item}/>)}</details>
    {(rwa || isCrypto) && <ResearchStatus query={quotes}/>}{quotes.result?.data?.rows?.map((item, index) => rwa ? <div key={item.rwa_id || index}><RwaRelationships record={item} onIssuer={setSelectedIssuer}/><details className="py-3"><summary className="cursor-pointer text-sm">{t('research.all_quote_evidence', { defaultValue: 'All quote evidence' })}</summary><EvidenceRecord record={item}/></details></div> : <EvidenceRecord key={index} record={item}/>)}
    {selectedIssuer && <section><h3>{t('research.issuer_evidence', { defaultValue: 'Issuer evidence' })}</h3><ResearchStatus query={issuerEvidence}/>{issuerEvidence.result?.data?.rows?.map((item, index) => <EvidenceRecord key={index} record={item}/>)}</section>}
    {exchangeId && <ExchangeDisclosures venues={[{id:exchangeId,name:rowName(row)}]}/>}
    {exchangeId && <><h3>{t('research.venue_metadata', { defaultValue: 'Venue and derivatives markets' })}</h3><details className="intel-source-record" onToggle={e=>setVenueInfoOpen(e.currentTarget.open)}><summary>Venue background and source record</summary><ResearchStatus query={venueInfo}/>{venueInfo.result?.data?.rows?.map((item, index) => <EvidenceRecord key={index} record={item}/>)}</details><details onToggle={e=>setVenueMarketsOpen(e.currentTarget.open)}><summary>Derivative markets at this venue</summary><ResearchStatus query={venuePairs}/><MarketPairsEvidence key={venuePage} rows={venuePairs.result?.data?.rows} venueName={rowName(row)}/><div className="flex gap-4 items-center text-xs py-3"><button className="btn btn--quiet" disabled={!venuePage||venuePairs.loading} onClick={()=>setVenuePage(p=>p-1)}>Previous markets</button><span>Page {venuePage+1}</span><button className="btn btn--quiet" disabled={venuePairs.loading||!(venuePairs.result?.data?.hasMore||(venuePairs.result?.data?.total!=null?(venuePage+1)*PAGE<venuePairs.result.data.total:venuePairs.result?.data?.rows?.length===PAGE))} onClick={()=>setVenuePage(p=>p+1)}>Next markets</button></div></details></>}
    {rwa && row.rwa_id && <><h3>{t('research.rwa_markets', { defaultValue: 'Markets for this asset' })}</h3><ResearchStatus query={rwaPairs}/>{rwaPairs.result?.data?.rows?.map((item, index) => <EvidenceRecord key={index} record={item}/>)}</>}
    {cryptoId && !rwa && !issuer && !category && <><label className="text-sm">{t('research.price_evidence', { defaultValue: 'Price evidence' })}<select className="select ml-3" value={detailView} onChange={e => setDetailView(e.target.value)}><option value="evidence">{t('research.current', { defaultValue: 'Current' })}</option><option value="history">{t('research.daily_history', { defaultValue: 'Daily observations' })}</option><option value="performance">{t('research.performance', { defaultValue: 'Performance statistics' })}</option><option value="ohlcv">{t('research.candles', { defaultValue: 'Daily OHLCV' })}</option></select></label>{detailView !== 'evidence' && <><ResearchStatus query={history}/>{candles.length > 1 ? <TokenChart candles={candles}/> : history.result?.data?.rows?.map((item, index) => <EvidenceRecord key={index} record={item}/>)}</>}</>}
    <div className="border-t border-[var(--border-default)] pt-5 space-y-3"><label htmlFor="investigation-note" className="text-sm">{t('research.your_notes', { defaultValue: 'Your research notes' })}</label><textarea disabled={saving} id="investigation-note" className="textarea w-full min-h-28" value={note} maxLength={20000} onChange={e => { setNote(e.target.value); setSaved(false) }}/><button className="btn btn--primary" onClick={save} disabled={!note.trim() || saved || saving}>{saving ? 'Saving…' : saved ? t('research.saved', { defaultValue: 'Saved' }) : t('research.save_notes', { defaultValue: 'Save notes to research' })}</button>{error && <p role="alert">{error}</p>}</div>
  </dialog>
}

export default function MarketResearchPage({ workspace = 'discovery' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile(), { user } = useSupabase()
  const view = VIEWS[workspace]
  const [search, setSearch] = useSearchParams()
  const capability = view.options.some(([key]) => key === search.get('view')) ? search.get('view') : view.options[0][0]
  const page = Math.max(0, Math.min(99, Number(search.get('page')) || 0))
  const [selection, setSelection] = useState(null)
  const [sourceDraft,setSourceDraft]=useState(false)
  useEffect(() => setSelection(null), [org?.id, user?.id])
  const closeInvestigation = useCallback(() => setSelection(null), [])
  const needsAsset = ['derivativePairs','liquidationAssets','marketPairs'].includes(capability)
  const assetCatalog = useMarketResearch('listings', { limit: 100 }, needsAsset)
  const asset = search.get('asset') || '1'
  const paged = !isDexDiscovery(capability) && !['global','fearGreed','altcoinSeason','altcoinSeasonHistory','cmc100','cmc20','globalHistory','cmc100History','cmc20History','dexPlatforms','liquidations','community'].includes(capability)
  const dexNetwork=CMC_DEX_NETWORKS.some(n=>String(n.platformId)===search.get('network'))?search.get('network'):'1'
  const params = isDexDiscovery(capability)?{platformIds:dexNetwork,interval:'24h',pageSize:25,...(search.get('cursor')?{nextPageIndex:search.get('cursor')}:{})}:{ ...(['globalHistory','cmc100History','cmc20History'].includes(capability)?{count:capability==='globalHistory'?30:10,interval:'daily'}:{}), ...(paged ? { start: page * PAGE + 1, limit: PAGE } : capability === 'community' ? { limit: 5 } : {}), ...(capability === 'derivativePairs' || capability === 'liquidationAssets' ? { crypto_id: asset } : capability === 'marketPairs' ? { id: asset } : {}), ...(capability === 'rwaList' && search.get('type') ? { asset_type: search.get('type') } : {}) }
  const query = useMarketResearch(capability, params,true,!selection&&!sourceDraft)
  const rows = query.result?.data?.rows || []
  const setParam = (key, value) => { const next = new URLSearchParams(search); value ? next.set(key, value) : next.delete(key); if (key !== 'page') next.delete('page'); if(key==='view'||key==='network')next.delete('cursor'); setSelection(null); setSearch(next, { replace: true }) }
  return <IntelPageShell>
    <IntelPageHeader eyebrow={t('research.market_research', { defaultValue: 'Market research' })} title={t(`research.${workspace}_title`, { defaultValue: view.title })} subtitle={t(`research.${workspace}_subtitle`, { defaultValue: view.subtitle })}/>
    <div className="flex gap-4 flex-wrap items-center border-y border-[var(--border-default)] py-4">
      <label className="text-xs">{t('research.investigation', { defaultValue: 'Investigation' })}<select className="select ml-3" value={capability} onChange={e => setParam('view', e.target.value)}>{view.options.map(([key, label]) => <option key={key} value={key}>{t(`research.view_${key}`, { defaultValue: label })}</option>)}</select></label>
      {workspace === 'rwa' && capability === 'rwaList' && <label className="text-xs">{t('research.asset_type', { defaultValue: 'Asset type' })}<select className="select ml-3" value={search.get('type') || ''} onChange={e => setParam('type', e.target.value)}>{[['','All assets'],['stock','Stocks'],['government_security','Government securities'],['commodity','Commodities'],['etf','ETFs'],['currency','Currencies'],['real_estate','Real estate']].map(([value,label]) => <option key={value} value={value}>{t(`research.type_${value || 'all'}`, { defaultValue: label })}</option>)}</select></label>}
      {needsAsset && <label className="text-xs">{t('research.asset', { defaultValue: 'Asset' })}<select className="select ml-3" value={asset} onChange={e => setParam('asset', e.target.value)}>{(assetCatalog.result?.data?.rows?.length ? assetCatalog.result.data.rows : [{ id: 1, name: 'Bitcoin', symbol: 'BTC' }, { id: 1027, name: 'Ethereum', symbol: 'ETH' }, { id: 5426, name: 'Solana', symbol: 'SOL' }]).map(row => <option key={row.id} value={String(row.id)}>{row.name} · {row.symbol}</option>)}{asset && !(assetCatalog.result?.data?.rows || [{id:1},{id:1027},{id:5426}]).some(row => String(row.id) === asset) && <option value={asset}>{t('research.selected_asset', { defaultValue: 'Selected asset' })} · {asset}</option>}</select></label>}
      {workspace === 'structure' && <><Link className="text-xs underline underline-offset-4" to="/intel/execution">{t('nav.execution', { defaultValue: 'Execution research' })}</Link><Link className="text-xs underline underline-offset-4" to="/intel/markets">{t('research.spread_watch', { defaultValue: 'Spreads and liquidity' })}</Link></>}
    </div>
    {/* Every read below calls the provider for the asking member, so this is
        the part that belongs to a paid plan. The workspace heading and its own
        selectors stay: the member sees the page they came to, with the costly
        panel locked in its place rather than an error or a blank. */}
    <IntelSurfaceGate surface="research_on_demand" title={t('access.surface_research_on_demand', { defaultValue: 'On demand research' })}>
    <ResearchStatus query={query} showObserved={!["globalHistory","cmc100History","cmc20History"].includes(capability)}/>
    <SharedResearchRefresh query={query}/>
    {sourceDraft&&<p className="intel-analysis-caption">Automatic updates paused while your source notes are unsaved.</p>}
    {isDexDiscovery(capability)&&<DexDiscoveryTable query={query} capability={capability} network={dexNetwork} onNetwork={v=>setParam('network',v)} cursor={search.get('cursor')} onNext={v=>setParam('cursor',v)} onFirst={()=>setParam('cursor',null)} onDraftChange={setSourceDraft}/>}
    {!!rows.length && !isDexDiscovery(capability) && (['globalHistory','cmc100History','cmc20History'].includes(capability)?<MarketContextHistory rows={rows} capability={capability}/>:workspace === 'context' || ['liquidations','liquidationAssets','marketPairs'].includes(capability) ? rows.map((row,index) => <EvidenceRecord key={index} record={row}/>) : <ResearchTable rows={rows} capability={capability} onOpen={row => setSelection(row)} t={t}/>)}
    {paged && <div className="flex items-center justify-between text-xs text-[var(--fg-4)]"><span>{t('research.page', { defaultValue: 'Page' })} {page + 1}{query.result?.data?.total != null ? ` · ${query.result.data.total} ${t('research.records', { defaultValue: 'records' })}` : ''}</span><span className="flex gap-3"><button className="btn btn--quiet" disabled={page === 0 || query.loading} onClick={() => setParam('page', String(page - 1))}>{t('markets.prev', { defaultValue: 'Previous' })}</button><button className="btn btn--quiet" disabled={query.loading || !(query.result?.data?.hasMore || (query.result?.data?.total != null ? (page + 1) * PAGE < query.result.data.total : rows.length === PAGE))} onClick={() => setParam('page', String(page + 1))}>{t('markets.next', { defaultValue: 'Next' })}</button></span></div>}
    {selection && <Investigation key={`${org?.id}:${user?.id}:${workspace}:${capability}:${rowId(selection)}`} row={selection} capability={capability} onClose={closeInvestigation} t={t}/>}
    </IntelSurfaceGate>
  </IntelPageShell>
}
