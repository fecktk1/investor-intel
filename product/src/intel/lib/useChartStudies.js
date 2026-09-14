import {useEffect,useRef,useState} from 'react'
const EMPTY=[]
export function useChartStudies(bars,studies,intervalMs=null) {
 const sequence=useRef(0),[state,setState]=useState({results:[],loading:false,error:null})
 useEffect(()=>{
  const requestId=++sequence.current;let active=true,worker
  if(!studies.length){setState({bars,studies,intervalMs,results:EMPTY,loading:false,error:null});return}
  setState({bars,studies,intervalMs,results:EMPTY,loading:true,error:null})
  try {
  worker=new Worker(new URL('./chart-study.worker.js',import.meta.url),{type:'module'})
  worker.onmessage=({data})=>{if(active&&data.requestId===sequence.current)setState({bars,studies,intervalMs,results:data.results||EMPTY,error:data.error||null,loading:false})}
  worker.onerror=()=>{if(active&&requestId===sequence.current)setState({bars,studies,intervalMs,results:EMPTY,error:'Indicator calculations could not start. Retry the study.',loading:false})}
  worker.postMessage({requestId,bars,studies,intervalMs})
  } catch { worker?.terminate();setState({bars,studies,intervalMs,results:EMPTY,error:'Indicator calculations could not start. Remove and re-add the study to retry.',loading:false}) }
  return()=>{active=false;worker?.terminate()}
 },[bars,studies,intervalMs])
 return state.bars===bars&&state.studies===studies&&state.intervalMs===intervalMs?state:{results:EMPTY,loading:studies.length>0,error:null}
}
