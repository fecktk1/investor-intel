import React, {useState} from 'react'
import {Link} from 'react-router'
import {EvidenceRecord} from './ResearchEvidence'
import {fmtPrice,fmtVol} from '../lib/market-format'

/** Venue contracts stay comparable in one table; a selected source record
 * retains every original provider field without expanding the whole response. */
export default function MarketPairsEvidence({rows=[],venueName}) {
 const [selected,setSelected]=useState(null)
 if(!rows.length)return null
 return <div className="intel-table-scroll"><table aria-label="Reported market pairs"><thead><tr><th scope="col">Market</th><th scope="col">Venue</th><th scope="col" className="intel-number">Price (USD)</th><th scope="col" className="intel-number">Open interest (USD)</th><th scope="col" className="intel-number">24h volume (USD)</th><th scope="col">Observed</th></tr></thead><tbody>{rows.map((row,index)=>{
  const key=String(row.market_id??row.id??index),quote=row.quote||{},time=quote.last_updated,assetId=Number(row.market_pair_base?.crypto_id)
  return <React.Fragment key={key}><tr><th scope="row"><button className="intel-text-link" aria-expanded={selected===key} onClick={()=>setSelected(selected===key?null:key)}>{row.market_pair_symbol||row.market_pair||row.symbol||'Market'}</button><small className="block text-[var(--fg-3)] font-normal">{row.category||'Category not reported'}</small>{Number.isSafeInteger(assetId)&&assetId>0&&<Link className="block text-xs underline underline-offset-4 mt-1" to={`/intel/investigate?asset=market%3Acoinmarketcap%3A${assetId}&lens=fragility`}>Research {row.market_pair_base?.symbol||'asset'}</Link>}</th><td>{row.exchange?.name||row.exchange?.exchange_name||venueName||'—'}</td><td className="intel-number">{fmtPrice(quote.price)}</td><td className="intel-number">{fmtVol(quote.open_interest)}</td><td className="intel-number">{fmtVol(quote.volume_24h)}</td><td>{time?<time dateTime={time}>{new Date(time).toLocaleString()}</time>:'Not reported'}</td></tr>{selected===key&&<tr><td colSpan={6}><p className="text-xs text-[var(--fg-3)]">Provider-reported contract data. Funding rates retain their source interval; missing intervals are not annualized.</p><EvidenceRecord record={row}/></td></tr>}</React.Fragment>
 })}</tbody></table></div>
}
