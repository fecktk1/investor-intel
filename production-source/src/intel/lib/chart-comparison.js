export {comparisonTimeline,comparisonWindow,comparisonPriceDomain} from '../../../supabase/functions/_shared/intel/chart-comparison'
export const comparisonAssetLink = asset => asset.startsWith('market:')
  ? `/intel/markets/${encodeURIComponent(asset.split(':').slice(2).join(':'))}?provider=${encodeURIComponent(asset.split(':')[1])}&id=${encodeURIComponent(asset.split(':').slice(2).join(':'))}`
  : `/intel/asset/${encodeURIComponent(asset)}`
