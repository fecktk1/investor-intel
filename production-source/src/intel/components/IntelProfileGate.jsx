import React,{useRef} from 'react'
/** Rechecking the same signed-in scope must not unmount unsaved chart/research
 * state. An account, active-org or resolved-org change still clears immediately.
 * This controls presentation only; each request retains its authorization checks. */
export default function IntelProfileGate({loading,user,profile,org,children}){
 const confirmed=useRef(null)
 const requested=user?.user_metadata?.active_org_id
 const identity=user?.id&&profile?.id===user.id&&org?.id&&(!requested||requested===org.id)?JSON.stringify([user.id,org.id]):null
 if(!loading)confirmed.current=identity
 const retain=identity!=null&&confirmed.current===identity
 if(!identity||(loading&&!retain))return <div className="intel-route-loading" role="status">Loading workspace…</div>
 return <React.Fragment key={identity}>{children}</React.Fragment>
}
