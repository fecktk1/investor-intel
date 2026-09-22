import React,{useState} from 'react'
export const value=v=>{
 if(v==null)return '—'
 if(typeof v!=='number')return String(v)
 // Small token prices, ratios and quantities must not become a displayed zero.
 if(v!==0&&Math.abs(v)<0.0001)return Math.abs(v)<0.000001?v.toExponential(3):v.toLocaleString(undefined,{maximumSignificantDigits:4})
 return v.toLocaleString(undefined,{maximumFractionDigits:4})
}
export const time=v=>v==null?'Time unavailable':new Date(v).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'})
export function InvestigationTable({columns,rows,caption,pageSize=12,page:controlledPage,onPageChange}) {
  const size=Number.isInteger(pageSize)?Math.max(1,Math.min(50,pageSize)):12
  const [localPage,setLocalPage]=useState(0),last=Math.max(0,Math.ceil(rows.length/size)-1)
  const current=Math.max(0,Math.min(Math.floor(Number(controlledPage??localPage)||0),last)),setPage=onPageChange||setLocalPage
  return <><div className="intel-table-scroll" tabIndex={0} role="region" aria-label={typeof caption==='string'?caption:'Analysis data'}><table>{caption&&<caption className="text-left text-sm pb-3">{caption}</caption>}<thead><tr>{columns.map(c=><th scope="col" key={c[0]}>{c[0]}</th>)}</tr></thead><tbody>{rows.slice(current*size,current*size+size).map((r,i)=><tr key={r.id||r.subject||i}>{columns.map(([label,read],j)=>j===0?<th scope="row" key={label}>{read(r)}</th>:<td key={label}>{read(r)}</td>)}</tr>)}</tbody></table></div>{rows.length>size&&<div className="intel-investigation-pagination"><button className="btn" disabled={!current} onClick={()=>setPage(current-1)}>Previous</button><span>{current+1} / {last+1} · {rows.length} records</span><button className="btn" disabled={current===last} onClick={()=>setPage(current+1)}>Next</button></div>}</>
}
