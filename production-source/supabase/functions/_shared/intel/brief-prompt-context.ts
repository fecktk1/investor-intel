type Row = Record<string,any>
const records = (value:unknown):Row[] => Array.isArray(value) ? value.filter(v=>v&&typeof v==='object') : []
function concise(value:any, depth=0):any {
  if(typeof value==='string')return value.slice(0,340)
  if(value==null||typeof value!=='object')return value
  if(depth>3)return undefined
  if(Array.isArray(value))return value.slice(0,5).map(v=>concise(v,depth+1))
  return Object.fromEntries(Object.entries(value).slice(0,18).map(([k,v])=>[k,concise(v,depth+1)]).filter(([,v])=>v!==undefined))
}

/** Keep valid JSON and reserve the beginning of the prompt for verified personal
 * context. Appending the entire pack after a large news feed silently lost it. */
export function compactBriefPromptContext(input:Row):Row {
  const pack=input.brief_evidence_pack || {}
  const holdings=records(pack.portfolio_holdings)
  const coverage=pack.context_coverage || {}
  const bounded=(value:any,max:number)=>{const item=concise(value);return JSON.stringify(item??null).length<=max?item:{prompt_truncated:true}}
  const brief:Row={
    portfolio_scope:pack.portfolio_scope ? {id:String(pack.portfolio_scope.id||'').slice(0,160),name:String(pack.portfolio_scope.name||'').slice(0,340)} : null,
    portfolio_holdings:holdings.slice(0,12).map(h=>({canonicalKey:h.canonicalKey,chain:h.chain,symbol:String(h.symbol||'').slice(0,40),quantity:h.quantity,value:h.value??null,priceStatus:h.priceStatus,costBasisStatus:h.costBasisStatus})),
    portfolio_coverage:{flows_truncated:!!coverage.flows_truncated,holdings_truncated:!!coverage.holdings_truncated,watchlist_truncated:!!coverage.watchlist_truncated,included_holdings:Math.min(12,holdings.length),available_holdings:holdings.length,prompt_holdings_truncated:holdings.length>12},
    market_regime:bounded(pack.market_regime || input.market_regime,1500),
    data_coverage:bounded(pack.data_coverage,1500),
    assembled_at:typeof pack.assembled_at==='string'?pack.assembled_at.slice(0,40):undefined,
  }
  const result:Row={brief_evidence_pack:brief,evidence_package:[]}
  const fits=()=>JSON.stringify(result).length<=8500
  // The identity/coverage envelope stays intact even for large portfolios.
  while(!fits()&&brief.portfolio_holdings.length){brief.portfolio_holdings.pop();brief.portfolio_coverage.prompt_holdings_truncated=true;brief.portfolio_coverage.included_holdings=brief.portfolio_holdings.length}
  const append=(key:string,rows:Row[],limit:number)=>{
    if(!fits())return
    brief[key]=[]
    if(!fits()){delete brief[key];return}
    for(const row of rows.slice(0,limit)){brief[key].push(concise(row));if(!fits()){brief[key].pop();break}}
  }
  append('watchlist_assets',records(pack.watchlist_assets).map(row=>({subject:row.subject,headlines:row.headlines,coverage:row.coverage})),4)
  append('macro',records(pack.macro_rotation?.macro),2)
  append('narrative_heat',records(pack.narrative_heat),4)
  append('news_that_matters',records(pack.news_that_matters),4)
  for(const row of records(input.evidence_package).slice(0,8)){result.evidence_package.push(concise(row));if(!fits()){result.evidence_package.pop();break}}
  return result
}
