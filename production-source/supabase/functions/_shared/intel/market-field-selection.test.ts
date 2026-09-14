import {assertEquals} from 'jsr:@std/assert'
import {selectMarketField} from './market-field-selection.ts'
const now=Date.parse('2026-09-12T12:00:00Z'),fresh={as_of:'2026-09-12T11:59:00Z'},stale={as_of:'2026-09-01T12:00:00Z'}
Deno.test('freshness precedes preference and provider-scoped zero aggregate values survive',()=>{
 const selected=selectMarketField([[5,stale,'intel_market_observations'],[7,fresh,'exchange_latest_tickers'],[0,fresh,'market_assets']],now,'USD')
 assertEquals(selected.value,0);assertEquals(selected.source_table,'market_assets');assertEquals(selected.scope,'asset_aggregate')
})
Deno.test('CMC retained quotes retain priority within comparable fresh aggregate evidence',()=>{
 assertEquals(selectMarketField([[10,fresh,'intel_market_observations'],[11,fresh,'market_assets']],now,'USD').value,10)
 const fallback=selectMarketField([[5,stale,'market_assets'],[7,fresh,'exchange_latest_tickers']],now,'USD')
 assertEquals(fallback.value,7);assertEquals(fallback.scope,'single_venue')
})
Deno.test('unknown clocks and pair fallback are qualified, with missing distinct from zero',()=>{
 const pair=selectMarketField([[0,{fetched_at:'2026-09-12T11:59:00Z'},'dex_pair_snapshots']],now,'USD')
 assertEquals(pair.value,0);assertEquals(pair.status,'unknown');assertEquals(pair.as_of,null);assertEquals(pair.scope,'contract_pair')
 assertEquals(selectMarketField([[null,fresh,'market_assets']],now,'USD').status,'missing')
})
