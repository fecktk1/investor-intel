import React from 'react'
import {Link} from 'react-router'
import {useMarketResearch} from '../lib/useMarketResearch'
import SpecialistEvidenceDetails from './thesis/SpecialistEvidenceDetails'
import ContractResearchWorkspace from './ContractResearchWorkspace'
export default function ConnectedAssetSourceReader({asset}){
 const query=useMarketResearch('venueContext',{canonicalKey:asset.asset},true),r=query.result
 return <>{query.loading?<p role="status">Reading retained evidence…</p>:query.error?<p role="alert">Evidence could not be read. {query.error.message||String(query.error)}</p>:r?.schemaVersion===1?<>
  <SpecialistEvidenceDetails allowSourcePaging specialist={{derivatives_state:r.derivatives,cmc_contract_state:r.cmcContract,rwa_state:r.rwa,security_state:r.security,benchmark_state:r.benchmark,representation_state:r.representation}}/>
  {r.cmcContract?.subject&&<ContractResearchWorkspace canonicalKey={r.cmcContract.subject}/>}
  <Link className="intel-text-link" to={`/intel/investigate?asset=${encodeURIComponent(asset.asset)}&lens=fragility`}>Investigate these sources and save a receipt</Link>
 </>:<p role="status">A complete evidence response is unavailable.</p>}</>
}
