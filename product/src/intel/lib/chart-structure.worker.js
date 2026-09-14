import {chartOutcome} from '../../../supabase/functions/_shared/intel/chart-outcome'
import {chartResearchRead} from '../../../supabase/functions/_shared/intel/chart-read'
import {chartPatterns} from '../../../supabase/functions/_shared/intel/chart-patterns'
import {chartTimeframeAlignment} from '../../../supabase/functions/_shared/intel/chart-timeframes'
import {chartStructureReview} from '../../../supabase/functions/_shared/intel/chart-levels'
self.onmessage=({data})=>{
 const {requestId,bars,options}=data
 try{self.postMessage({requestId,result:options.analysis==='outcome'?{outcome:chartOutcome(bars,options.spec,options)}:options.analysis==='read'?{researchRead:chartResearchRead(bars,options)}:options.analysis==='alignment'?{alignment:chartTimeframeAlignment(bars,options)}:options.analysis==='patterns'?{patternRead:chartPatterns(bars,options)}:chartStructureReview(bars,options)})}
 catch(error){self.postMessage({requestId,error:error.message})}
}
