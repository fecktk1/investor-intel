import {useEffect,useRef,useState} from 'react'
export function useChartStructure(bars,options){
 const key=JSON.stringify(options),sequence=useRef(0),[state,setState]=useState({result:null,error:null,loading:true})
 useEffect(()=>{
  const requestId=++sequence.current;let active=true,worker
  if(options.enabled===false){setState({bars,key,result:null,error:null,loading:false});return}
  setState({bars,key,result:null,error:null,loading:true})
  try{
   worker=new Worker(new URL('./chart-structure.worker.js',import.meta.url),{type:'module'})
   worker.onmessage=({data})=>{if(active&&sequence.current===data.requestId)setState({bars,key,result:data.result??null,error:data.error??null,loading:false})}
   worker.onerror=()=>{if(active)setState({bars,key,result:null,error:'Structure calculations could not start. Close and reopen Structure to retry.',loading:false})}
   worker.postMessage({requestId,bars,options:JSON.parse(key)})
  }catch{worker?.terminate();setState({bars,key,result:null,error:'Structure calculations could not start. Close and reopen Structure to retry.',loading:false})}
  return()=>{active=false;worker?.terminate()}
 },[bars,key])
 return state.bars===bars&&state.key===key?state:{result:null,error:null,loading:true}
}
