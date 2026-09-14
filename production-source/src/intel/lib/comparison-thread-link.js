export function comparisonThreadHref(threadId,comparison){
 if(!comparison||!Array.isArray(comparison.assets)||comparison.assets.length<2||comparison.assets.length>4)return null
 const params=new URLSearchParams({thread:threadId,assets:JSON.stringify(comparison.assets.map(a=>({canonicalAssetKey:a.asset,displayName:a.label}))),period:comparison.period,view:JSON.stringify(comparison.view)})
 return `/intel/compare?${params}`
}
