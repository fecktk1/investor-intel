import { useEffect, useRef, useState, useCallback } from 'react'
import { useSupabase } from '../../lib/useSupabase'
import { useProfile } from '../../lib/profile-context'

/** The longest a research read may keep a panel in its loading state. A read
 * that has not answered by then is stopped and the panel ENDS on a stated
 * failure with a retry, never a spinner that stays. Generous on purpose: a
 * member's live provider read with its own retries finishes well inside it. */
export const RESEARCH_READ_TIMEOUT_MS = 30000
export const RESEARCH_READ_TIMEOUT = 'read_timeout'

export function useMarketResearch(capability, params = {}, enabled = true, watch = false) {
  const { supabase, user } = useSupabase()
  const { org } = useProfile()
  const scope = JSON.stringify([user?.id, org?.id, capability, params])
  const [state, setState] = useState({ scope: null, result: null, loading: false, error: null })
  const [revision, setRevision] = useState(0)
  const [pause, setPause] = useState({scope:null,value:false})
  const current = useRef(scope); current.current = scope
  useEffect(() => {
    if (!enabled || !org?.id || !user?.id || !capability) return
    const controller = new AbortController()
    setState({ scope, result: null, loading: true, error: null })
    const timeout = setTimeout(() => {
      if (controller.signal.aborted || current.current !== scope) return
      controller.abort()
      setState({ scope, result: null, loading: false, error: RESEARCH_READ_TIMEOUT })
    }, RESEARCH_READ_TIMEOUT_MS)
    supabase.functions.invoke('intel-research', { body: { orgId: org.id, capability, params }, signal: controller.signal })
      .then(({ data, error }) => {
        if (controller.signal.aborted || current.current !== scope) return
        if (error || data?.error) throw new Error(data?.error || error.message)
        setState({ scope, result: data, loading: false, error: null })
      }).catch(error => { if (!controller.signal.aborted && current.current === scope) setState({ scope, result: null, loading: false, error: error.message }) })
      .finally(() => clearTimeout(timeout))
    return () => { clearTimeout(timeout); controller.abort() }
  }, [scope, enabled, revision, supabase]) // parameters are serialized into scope
  const liveEnabled=watch&&enabled&&state.scope===scope&&state.result?.refreshPolicy?.enabled===true
  const livePaused=pause.scope===scope&&pause.value
  useEffect(()=>{
    if(!liveEnabled||livePaused||!org?.id||!user?.id)return
    let timer,controller,closed=false
    const schedule=()=>{clearTimeout(timer);if(!closed&&document.visibilityState==='visible')timer=setTimeout(read,60000)}
    const read=async()=>{
      if(closed||document.visibilityState!=='visible')return
      const requestController=new AbortController();controller=requestController
      try{
        const {data,error}=await supabase.functions.invoke('intel-research',{body:{orgId:org.id,capability,params,readMode:'retained'},signal:requestController.signal})
        if(closed||requestController.signal.aborted||current.current!==scope)return
        if(error||data?.error)throw Error(data?.error||error.message)
        setState({scope,result:data,loading:false,error:null})
      }catch(error){if(!closed&&!requestController.signal.aborted&&current.current===scope)setState(previous=>previous.scope===scope?{...previous,error:error.message}:previous)}
      finally{schedule()}
    }
    const visibility=()=>{clearTimeout(timer);controller?.abort();if(document.visibilityState==='visible')schedule()}
    document.addEventListener('visibilitychange',visibility);schedule()
    return()=>{closed=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibility)}
  },[scope,liveEnabled,livePaused,revision,supabase])
  const refresh = useCallback(() => setRevision(n => n + 1), [])
  return { ...(state.scope === scope ? state : { result: null, loading: enabled, error: null }), refresh,liveEnabled,livePaused,setLivePaused:value=>setPause({scope,value:Boolean(value)}) }
}
