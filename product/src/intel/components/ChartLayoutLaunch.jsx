import React,{useState} from 'react'
import deferredPanel from './deferred-panel'

// The layout library's two triggers, eager; the library itself on first press.
//
// `ChartLayoutLibrary` carries the workspace API client and the whole
// list/save/rename dialog. On the asset route it sat in the workstation's static
// graph in front of the first price render although nobody sees it until a
// press. The buttons here are the library's own buttons, same text and same
// disabled rule, so the row is complete from the first paint and nothing moves
// when the library arrives and renders them itself. The press that fetched the
// code is the press that opens the dialog (`autoOpen`).
const Library=deferredPanel(()=>import('./ChartLayoutLibrary'),{label:'Chart layouts',fallback:props=><LaunchButtons {...props} busy/>})

function LaunchButtons({context,disabled=false,comparisons=false,canSave=true,onStudies,busy=false,onLaunch}) {
 const off=disabled||!context?.userId
 return <>
  <button type="button" disabled={off||busy} aria-busy={busy||undefined} onClick={()=>onLaunch?.('layouts')}>{comparisons&&!canSave?'Open saved comparison':'Save layout'}</button>
  {onStudies&&<button type="button" disabled={off||busy} aria-busy={busy||undefined} onClick={()=>onLaunch?.('templates')}>Indicator templates</button>}
 </>
}

export default function ChartLayoutLaunch(props) {
 const [autoOpen,setAutoOpen]=useState(null)
 return autoOpen ? <Library {...props} autoOpen={autoOpen}/> : <LaunchButtons {...props} onLaunch={setAutoOpen}/>
}
