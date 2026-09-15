import React,{useState} from 'react'
import {useTranslation} from 'react-i18next'
import deferredPanel from './deferred-panel'

/** Share, reachable from the chart itself.
 *
 * A share link always points at a saved version, so the audience, expiry and
 * revocation controls only exist once a snapshot does. Before this, the only
 * way in was to save a snapshot, follow the link in the confirmation and find
 * the control on the snapshot page, which is why the owner could not find a
 * Share button on the chart.
 *
 * Only the trigger is eager. The flow behind it, the brand card and the whole
 * link-management dialog, is a chunk of its own, so an asset page that is never
 * shared does not carry it. The fallback is the same button in the same place,
 * so pressing Share never moves anything. */
function ShareButton({label,...rest}) {return <button type="button" {...rest}>{label}</button>}

const SharePanel=deferredPanel(()=>import('./ChartSharePanel'),{
 label:'Chart sharing',
 fallback:props=><ShareButton label={props.label} disabled aria-busy="true"/>,
})

export default function ChartShareLaunch({disabled=false,...rest}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [armed,setArmed]=useState(false)
 const label=t('chart.share.open',{defaultValue:'Share'})
 return armed
  ? <SharePanel {...rest} disabled={disabled} label={label} autoStart/>
  : <ShareButton label={label} disabled={disabled} onClick={()=>setArmed(true)}/>
}
