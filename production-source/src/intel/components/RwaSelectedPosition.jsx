import React,{useState} from 'react'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {ResolvedCmcPosition} from './CmcAssetPosition'
export default function RwaSelectedPosition({tokens=[],selectedToken,onTokenChange,portfolioId}){
 const [open,setOpen]=useState(false),[selected,setSelected]=useState(null),{org}=useProfile(),{user}=useSupabase()
 const requested=selectedToken??selected,token=requested?tokens.find(t=>String(t.crypto_id)===requested):tokens[0]
 if(!tokens.length)return null
 return <details className="my-3" onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open)}}><summary>Your position in a token representation</summary>
  <label>Token <select className="select" value={token?String(token.crypto_id):''} onChange={e=>{setSelected(e.target.value);onTokenChange?.(e.target.value)}}>{!token&&<option value="">Selected token is outside this source response; choose a representation</option>}{tokens.slice(0,100).map(t=><option key={t.crypto_id} value={String(t.crypto_id)}>{t.name||t.symbol} · {t.issuer_name||'Issuer unreported'}</option>)}</select></label>
  {open&&token&&<ResolvedCmcPosition key={`${user?.id}:${org?.id}:${token.crypto_id}`} assetId={token.crypto_id} portfolioId={portfolioId}/>}
  {tokens.length>100&&<p>The selector is limited to 100 representations. Remaining token workspaces are available in the relationship table.</p>}
 </details>
}
