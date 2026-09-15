import React from 'react'
import {Link} from 'react-router'
import SpecialistEvidenceDetails from './thesis/SpecialistEvidenceDetails'
import RwaPortfolioExposure from './RwaPortfolioExposure'
import PortfolioBenchmarkExposure from './PortfolioBenchmarkExposure'
import PortfolioNarrativeExposure from './PortfolioNarrativeExposure'
import PortfolioHistoricalPerformance from './PortfolioHistoricalPerformance'
export default function PortfolioResearchEvidence({evidence,portfolioId}){return <>
      <PortfolioNarrativeExposure exposure={evidence?.narrativeExposure} portfolioId={portfolioId}/>
      <RwaPortfolioExposure exposure={evidence?.rwaExposure} portfolioId={portfolioId}/>
      <PortfolioBenchmarkExposure exposures={evidence?.benchmarkExposure} portfolioId={portfolioId}/>
      {evidence?.historicalPerformance&&<PortfolioHistoricalPerformance key={evidence.historicalPerformance.version||'unavailable'} performance={evidence.historicalPerformance}/>}
      <p>{evidence?.marketEvidenceCoverage?.method||evidence?.marketEvidenceCoverage?.reason||'This saved reading predates connected market evidence. Refresh creates a new reading; the original evidence stays unchanged.'}</p>
      {!!evidence?.marketEvidenceCoverage?.omitted&&<p>{evidence.marketEvidenceCoverage.omitted} included holdings are outside this bounded market-evidence projection. Open their asset workspace to inspect their sources.</p>}
      {evidence?.marketEvidence?.map(row=><details key={row.canonicalAssetKey}><summary>{row.name||row.symbol||row.canonicalAssetKey}</summary><SpecialistEvidenceDetails specialist={row}/><Link className="intel-text-link" to={`/intel/investigate?asset=${encodeURIComponent(row.canonicalAssetKey)}&portfolio=${encodeURIComponent(portfolioId||'')}`}>Open connected research</Link></details>)}
    </>}
