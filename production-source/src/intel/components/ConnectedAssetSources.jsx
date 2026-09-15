import React,{lazy,Suspense,useState} from 'react'
const ReadSources=lazy(()=>import('./ConnectedAssetSourceReader'))
/** Mount only the selected retained reader after a deliberate disclosure click. */
export default function ConnectedAssetSources({assets=[],label='Market and on-chain evidence'}){
 const [open,setOpen]=useState(false),[selected,setSelected]=useState(null)
 const asset=assets.find(a=>a.asset===selected)||assets[0]
 if(!asset)return null
 return <details className="intel-open-section" onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open)}}><summary>{label}</summary>
  <p className="intel-analysis-caption">Inspect retained CoinMarketCap positioning, holder accounts and public liquidity activity. Each source keeps its own observation time. Opening this view does not generate research or synchronize wallets.</p>
  {assets.length>1&&<label>Asset <select className="select" value={asset.asset} onChange={e=>setSelected(e.target.value)}>{assets.slice(0,4).map(a=><option key={a.asset} value={a.asset}>{a.label||a.asset}</option>)}</select></label>}
  {open&&<Suspense fallback={<p role="status">Opening market evidence…</p>}><ReadSources key={asset.asset} asset={asset}/></Suspense>}
 </details>
}
