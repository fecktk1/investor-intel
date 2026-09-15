import {calculateStudies} from '../../../supabase/functions/_shared/intel/chart-analysis'
self.onmessage=({data})=>{
 const {requestId,bars,studies,intervalMs}=data
 try{self.postMessage({requestId,results:calculateStudies(bars,studies,{intervalMs})})}
 catch(error){self.postMessage({requestId,error:error.message})}
}
