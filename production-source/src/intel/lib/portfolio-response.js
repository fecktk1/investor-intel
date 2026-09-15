const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
export function validPortfolioPage(value){
 return record(value)&&Array.isArray(value.rows)&&value.rows.every(record)&&
  Number.isSafeInteger(value.total)&&value.total>=0&&Number.isSafeInteger(value.page)&&value.page>=0&&
  Number.isSafeInteger(value.limit)&&value.limit>=1&&value.limit<=250&&value.rows.length<=value.limit&&value.rows.length<=value.total&&
  typeof value.hasMore==='boolean'&&value.hasMore===((value.page+1)*value.limit<value.total)&&
  value.rows.length===Math.min(value.limit,Math.max(0,value.total-value.page*value.limit))
}
export function requirePortfolioOverview(value,orgId,portfolioId){
 if(!record(value)||!record(value.portfolio)||value.portfolio.id!==portfolioId||value.portfolio.org_id!==orgId||!record(value.summary)||
  ![value.open,value.closed,value.sources].every(validPortfolioPage))throw Error('Portfolio response could not be verified. Your previous view remains available; try again.')
 return value
}
export function requirePortfolioPage(value,page,limit){
 if(!validPortfolioPage(value)||value.page!==page||value.limit!==limit)throw Error('Portfolio page could not be verified. Try loading it again.')
 return value
}
