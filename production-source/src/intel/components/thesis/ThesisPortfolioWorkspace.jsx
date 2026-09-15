import React,{useMemo} from 'react'
import {Link} from 'react-router'
import {useSupabase} from '../../../lib/useSupabase'
import {useProfile} from '../../../lib/profile-context'
import {useAssetPortfolioContext} from '../../lib/useAssetPortfolioContext'
import {canonicalPortfolioKey,entityPortfolioKey} from '../../lib/asset-identity'
import {mergeLinkedAssetMarkers} from '../../lib/chart-history'
import AssetPortfolioPosition from '../AssetPortfolioPosition'
import TokenChart from '../TokenChart'
import {useContractChartEvidence} from '../../lib/useContractChartEvidence'
import ContractChartEvidenceStatus from '../ContractChartEvidenceStatus'

const assetKey=thesis=>canonicalPortfolioKey(thesis.subject_canonical_key)||canonicalPortfolioKey(thesis.entity?.canonical_ref_key)||entityPortfolioKey(thesis.entity)

function OwnedWorkspace({thesis,from,to,chartProps}) {
  const key=assetKey(thesis)
  const context=useAssetPortfolioContext({canonicalAssetKey:key,from,to})
  const publicEvidence=useContractChartEvidence({canonicalKey:chartProps?key:null,from,to,portfolioId:context.portfolioId})
  const markers=useMemo(()=>[...mergeLinkedAssetMarkers(context.markers,chartProps?.markers||[]),...publicEvidence.markers],[context.markers,chartProps?.markers,publicEvidence.markers])
  return <div className="space-y-3">
    {key?<AssetPortfolioPosition context={context} compact/>:<p className="text-sm text-[var(--fg-4)]">Choose an exact asset network in the asset workspace to connect portfolio history to this thesis.</p>}
    {key&&context.portfolioId&&<div className="flex gap-5 flex-wrap text-sm">
      <Link className="intel-text-link" to={`/intel/portfolio/${context.portfolioId}/asset/${encodeURIComponent(key)}`}>Open position and complete activity</Link>
      <Link className="intel-text-link" to={`/intel/theses/trades?${new URLSearchParams({thesis:thesis.id,asset:key})}`}>Open linked trade journal</Link>
    </div>}
    {chartProps?<><ContractChartEvidenceStatus evidence={publicEvidence}/><TokenChart {...chartProps} assetKey={`${chartProps.assetKey}:${context.portfolioId||''}`} markers={markers}
      historyLoading={chartProps.historyLoading||context.loading||context.loadingMore}
      historyError={chartProps.historyError||(context.error?'Portfolio activity could not be loaded.':null)}
      historyHasMore={chartProps.historyHasMore||!!context.nextCursor}
      onLoadMoreHistory={()=>Promise.allSettled([chartProps.onLoadMoreHistory?.(),context.loadMore()])}/></>:<>
      {thesis.portfolio_id&&<p className="text-sm text-[var(--fg-4)]">This thesis records a portfolio link. <button className="intel-text-link" onClick={()=>context.selectPortfolio(thesis.portfolio_id)}>View linked portfolio</button></p>}
      {thesis.baseline?.portfolio_snapshot&&Object.keys(thesis.baseline.portfolio_snapshot).length>0&&<details><summary className="cursor-pointer text-sm">Position context saved with the thesis</summary><pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg-4)] mt-3">{JSON.stringify(thesis.baseline.portfolio_snapshot,null,2)}</pre></details>}
      <p className="text-sm text-[var(--fg-4)]">Research and journal entries describe your decisions. Recorded portfolio transactions determine holdings.</p>
    </>}
  </div>
}

// A shared thesis never mounts private portfolio readers or exposes its owner's
// saved position snapshot. Its authorized research chart remains available.
export default function ThesisPortfolioWorkspace(props) {
  const {user}=useSupabase(),{org}=useProfile()
  const owns=props.thesis?.user_id===user?.id&&props.thesis?.org_id===org?.id
  if(!owns)return props.chartProps?<TokenChart {...props.chartProps}/>:<p className="text-sm text-[var(--fg-4)]">Portfolio positions and transaction notes are private to the thesis owner.</p>
  return <OwnedWorkspace key={`${user.id}:${org.id}:${props.thesis.id}`} {...props}/>
}
