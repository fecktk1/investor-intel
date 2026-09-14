import React,{lazy,Suspense,useMemo,useState} from 'react'
import {Link} from 'react-router'
import {alignedBenchmark} from '../../../supabase/functions/_shared/intel/benchmark-comparison.ts'
const Comparison=lazy(()=>import('./BenchmarkComparison'))
// Loading chart code does not refresh or replace the supplied evidence.
export function BenchmarkComparison(props){return <Suspense fallback={<p role="status">Opening benchmark comparison…</p>}><Comparison {...props}/></Suspense>}
export function BenchmarkLens({observations,subject,benchmark='100',at,from,onSelect,onPrepareReceipt}){
 const comparison=useMemo(()=>alignedBenchmark(observations.filter(o=>Date.parse(o.observedAt)>=from),subject,benchmark,at),[observations,subject,benchmark,at,from])
 return <BenchmarkComparison comparison={comparison} onSelect={onSelect} onPrepareReceipt={onPrepareReceipt}/>
}
export default function BenchmarkEvidence({evidence,asset}){
 const [index,setIndex]=useState('100'),[open,setOpen]=useState(false),comparison=evidence?.comparisons?.find(c=>c.index===index)
 if(!evidence)return null
 return <details className="my-3" onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open)}}><summary>Retained CMC benchmark comparison</summary><p role={evidence.status==='error'?'alert':undefined}>{evidence.status} · {evidence.reason}</p>
  <label>Benchmark <select className="select" value={index} onChange={e=>setIndex(e.target.value)}><option value="100">CMC 100</option><option value="20">CMC 20</option></select></label>
  {open&&comparison&&<BenchmarkComparison key={index} comparison={comparison}/>}
  {asset&&<Link className="intel-text-link" to={`/intel/investigate?asset=${encodeURIComponent(asset)}&lens=benchmark&benchmark=${index}&range=1M`}>Refresh and investigate the matching source history</Link>}
 </details>
}
