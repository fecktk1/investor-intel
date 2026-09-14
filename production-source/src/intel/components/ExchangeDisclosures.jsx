import React,{useState} from 'react'
import {Link} from 'react-router'
import {useMarketResearch} from '../lib/useMarketResearch'
import {ResearchStatus} from './ResearchEvidence'
import {InvestigationTable,value} from './InvestigationTable'
import SourceResearchNotes from './SourceResearchNotes'
import CmcAssetPosition from './CmcAssetPosition'
const money=v=>v==null?'Unpriced':Number(v).toLocaleString(undefined,{maximumFractionDigits:2})
const exactMoney=v=><span title={v==null?'Unpriced':String(v)}>{money(v)}</span>
const assetColumns=[
 ['Asset',r=><Link className="intel-text-link" to={`/intel/markets/${encodeURIComponent(r.symbol||r.name||r.id)}?provider=coinmarketcap&id=${r.id}`}>{r.name||r.symbol||r.id}</Link>],['Quantity',r=>value(r.quantity)],['Priced subset (USD)',r=>r.unpricedRecords===r.records?'Unpriced':exactMoney(r.pricedUsd)],['Share of priced subset',r=>r.unpricedRecords===r.records?'Unpriced':r.shareOfPricedPercent==null?'No positive denominator':`${money(r.shareOfPricedPercent)}%`],['Unpriced records',r=>r.unpricedRecords],['Reported networks',r=>r.platforms.length]
]
function SelectedDisclosure({selection,assetId}){
 const selected=selection?.subject===`market:coinmarketcap:${assetId}`?selection:null
 return <section aria-label="Selected asset in this disclosure" className="space-y-2">
  {!selected?<p role="status">Selected-asset details are unavailable for this response. No balance has been inferred.</p>:selected.asset?<>
   <InvestigationTable caption="Selected asset across the complete disclosure" rows={[selected.asset]} columns={assetColumns}/>
   {selected.state==='partial'&&<p role="status">This asset has incomplete disclosure coverage: {selected.asset.unpricedRecords} unpriced records, {selected.conflictingRecords} conflicting entries and {selected.invalidRecords} invalid records. Only admitted quantities and priced records contribute to the figures.</p>}
   <details><summary>Reported networks for this asset</summary><InvestigationTable rows={selected.networks} columns={[
    ['Network',r=>r.name||r.id],['Quantity',r=>value(r.quantity)],['Priced subset (USD)',r=>r.unpricedRecords===r.records?'Unpriced':exactMoney(r.pricedUsd)],['Unpriced records',r=>r.unpricedRecords]
   ]}/>{selected.networksTruncated&&<p>Showing 100 of {selected.networkTotal} networks. The asset total includes every admitted network.</p>}</details>
  </>:<p role="status">{selected.state==='excluded'?'Matching records were excluded because their balances or identities conflict or are invalid.':'No matching asset was reported in this response.'} This does not establish a zero balance.</p>}
  <p className="intel-analysis-caption">The selection uses the exact CoinMarketCap asset ID across the full response, independent of this table page. This public disclosure does not establish where your assets are held.</p>
  <CmcAssetPosition assetId={assetId}/>
 </section>
}

function DisclosureInventory({data,page,setPage,loading}){return <>
  <InvestigationTable caption="Reported assets across disclosed wallets" rows={data.rows} columns={assetColumns}/>
  <div className="flex items-center gap-4"><button className="btn btn--quiet" disabled={!page||loading} onClick={()=>setPage(p=>p-1)}>Previous assets</button><span>Page {page+1} · {data.total} assets</span><button className="btn btn--quiet" disabled={!data.hasMore||loading} onClick={()=>setPage(p=>p+1)}>Next assets</button></div>
 </>}

function Disclosure({id,assetId}) {
 const [page,setPage]=useState(0),q=useMarketResearch('exchangeDisclosure',{id,start:page*12+1,limit:12,...(assetId?{assetId}:{})}),data=q.result?.data,summary=data?.summary
 return <div className="space-y-3"><ResearchStatus query={q} showObserved={false}/>{summary&&<>
  <p className="intel-analysis-caption">Reported wallets only. Balance and price observation times are unreported; retrieval time dates this response. These disclosures do not establish solvency.</p>
  <p>{summary.reportedRecords.toLocaleString()} source records · {summary.reportedWallets.toLocaleString()} reported wallets · priced subset ${money(summary.pricedUsd)} · {summary.unpricedRecords} unpriced · {summary.conflictingRecords} conflicting · {summary.invalidRecords} invalid records excluded.</p>
  {assetId&&<SelectedDisclosure selection={data.selectedAsset} assetId={assetId}/>}
  {assetId?<details><summary>All reported assets ({data.total})</summary><DisclosureInventory data={data} page={page} setPage={setPage} loading={q.loading}/></details>:<DisclosureInventory data={data} page={page} setPage={setPage} loading={q.loading}/>}
  <details><summary>Reported blockchain distribution</summary><InvestigationTable rows={data.chains} columns={[
   ['Network',r=>r.name||r.id],['Priced subset (USD)',r=>r.unpricedRecords===r.records?'Unpriced':exactMoney(r.pricedUsd)],['Records',r=>r.records],['Unpriced records',r=>r.unpricedRecords]
  ]}/>{data.chainsTruncated&&<p role="status">Showing 100 of {data.chainTotal} reported networks. The priced denominator still includes every admitted network.</p>}</details>
  <details><summary>Disclosure source and coverage</summary><p>{data.caveat}</p><p>CoinMarketCap /v1/exchange/assets · exchange ID {id}. Balance and price observation times are unreported. Retrieval time above dates this response only.</p><p>{summary.duplicateRecords} identical records deduplicated. Conflicting wallet/network/asset entries are excluded from totals. The denominator spans the full bounded response, not this page.</p></details>
  <SourceResearchNotes reference={data.sourceReference} title={`Exchange ${id}${assetId?` · CMC asset ${assetId}`:''} · CMC disclosure research`}/>
 </>}</div>
}

// The outer disclosure performs no request until explicitly opened. Reused in
// asset, Compare, frozen research and portfolio venue context as current data.
export default function ExchangeDisclosures({venues=[],subject}) {
 const [open,setOpen]=useState(false),[selected,setSelected]=useState('')
 const choices=[...new Map(venues.filter(v=>/^[1-9][0-9]*$/.test(String(v.id))).map(v=>[String(v.id),{...v,id:String(v.id)}])).values()]
 if(!choices.length)return null
 const id=choices.some(v=>v.id===selected)?selected:choices[0].id
 const assetId=typeof subject==='string'?subject.match(/^market:coinmarketcap:([1-9][0-9]{0,11})$/)?.[1]:null
 return <details className="border-y border-[var(--border-default)] py-3" onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open)}}>
  <summary>Explore current exchange disclosures</summary>
  {open&&<><label className="intel-inline-field">Reported exchange<select value={id} onChange={e=>setSelected(e.target.value)}>{choices.map(v=><option key={v.id} value={v.id}>{v.name||v.id}</option>)}</select></label><Disclosure key={`${id}:${assetId||''}`} id={id} assetId={assetId}/></>}
 </details>
}
