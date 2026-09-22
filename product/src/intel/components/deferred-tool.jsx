import React,{useState} from 'react'
import deferredPanel from './deferred-panel'

// A chart-tool control whose panel code arrives on the first press.
//
// The chart tools are a row of buttons that each open a dialog. Statically
// importing every dialog put all of them in front of the first price render,
// even for a reader who opens none. Here the trigger is eager and stays exactly
// where it was, so nothing shifts and the row is complete from the first paint;
// the dialog, its form and its API calls arrive when someone presses it.
//
// The loaded panel renders its own trigger, so `autoOpen` makes the press that
// fetched the code the press that opened the tool. The fallback is the same
// button, marked busy, for the moment between the two.
export function deferredTool(load,{label}={}) {
 const Panel=deferredPanel(load,{label,fallback:props=><button type="button" disabled aria-busy="true">{props.triggerLabel}</button>})
 return function DeferredTool({triggerLabel,disabled=false,...props}) {
  const [armed,setArmed]=useState(false)
  return armed
   ? <Panel {...props} triggerLabel={triggerLabel} label={triggerLabel} disabled={disabled} autoOpen/>
   : <button type="button" disabled={disabled} onClick={()=>setArmed(true)}>{triggerLabel}</button>
 }
}

export default deferredTool
