import {assert,assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {portfolioPerformance,readPortfolioPerformance} from './portfolio-performance.ts'
import {performanceSnapshot} from '../investor-portfolio/performance-snapshot.ts'
const day=86400000,start=Date.parse('2026-09-10T12:00:00Z'),end=start+day,mid=start+day/2,iso=(t:number)=>new Date(t).toISOString()
const h=(quantity=10,value=1000,key='native:bitcoin')=>({canonicalAssetKey:key,quantity,value,priceStatus:'priced'})
const snap=(t:number,holdings:any[],id='s'+t)=>({id,as_of:iso(t),holdings_summary:holdings,total_value_usd:holdings.reduce((n,h)=>n+h.value,0),risk_summary:{performance:{version:1,incompleteHistory:false}}})
const book=(a:any[],b:any[],manual:any[]=[],groups:any[]=[])=>({snapshots:[snap(start,a),snap(end,b)],manual,groups})
const manual=(type='buy',quantity=5,price=100,at=mid)=>({id:'m',transaction_type:type,canonical_asset_key:'native:bitcoin',quantity,price_per_unit:price,quote_currency:'USD',timestamp:iso(at),fee_currency:'USD',classification_status:'confirmed'})
const group=(type:string,legs:any[],at=mid)=>({id:'g',chain:'bitcoin',type,status:'success',classification_status:'confirmed',block_time:iso(at),fee_amount:0,line_items:legs})
const leg=(quantity:number,direction:string,key='native:bitcoin')=>({canonical_asset_key:key,amount:quantity,direction,price_usd_at_tx:100,price_source_at_tx:'recorded'})
const calc=(b:any)=>portfolioPerformance(b,end+1)
Deno.test('cash-flow weighting uses actual timestamps, not UTC date truncation',()=>{
 const result=calc(book([h()],[h(15,1650)],[manual()]));eq(result.status,'estimate');eq(result.periods[0].returnPercent,12);eq(result.netFlowsUsd,500);eq(result.changeAfterFlowsUsd,150);eq(result.periods[0].flows[0].weight,.5)
 eq(calc(book([h()],[h(15,1650)],[manual('buy',5,100,end)])).periods[0].returnPercent,15)
})
Deno.test('zero gains remain zero and closed positions retain their proceeds',()=>{
 eq(calc(book([h()],[h()])).returnPercent,0)
 const r=calc(book([h()],[h(0,0)],[manual('sell',10,110,end)]));eq(r.status,'estimate');eq(r.periods[0].returnPercent,10);eq(r.netFlowsUsd,-1100)
})
Deno.test('manual standalone buys/sells and recorded USD fees model the tracked asset book boundary',()=>{
 const m={...manual(),fee_amount:10};const result=calc(book([h()],[h(15,1500)],[m]));eq(result.periods[0].netFlowsUsd,510);eq(result.changeAfterFlowsUsd,-10)
 const pair='pair',a={...manual('swap',10,100),direction:'out',fee_amount:1,raw_metadata:{manual_group_id:pair}},b={...manual('swap',1,1000),id:'in',canonical_asset_key:'native:ethereum',direction:'in',raw_metadata:{manual_group_id:pair}}
 const r=calc(book([h()],[h(1,1000,'native:ethereum')],[a,b]));eq(r.status,'estimate');eq(r.netFlowsUsd,1);eq(r.changeAfterFlowsUsd,-1)
 eq(calc(book([h()],[h(1,1000,'native:ethereum')],[a])).status,'incomplete')
})
Deno.test('internal swaps preserve both legs and native fees reduce value without becoming a withdrawal',()=>{
 const g=group('swap',[leg(5,'out'),leg(1,'in','native:ethereum')]);g.fee_amount=1;Object.assign(g,{fee_canonical_key:'native:bitcoin'})
 const r=calc(book([h()],[h(4,400),h(1,500,'native:ethereum')],[],[g]));eq(r.status,'estimate');eq(r.netFlowsUsd,0);eq(r.changeAfterFlowsUsd,-100)
})
Deno.test('one portfolio internal transfer nets exact identities and external transfer stays distinct from a sale',()=>{
 const a={...group('transfer_out',[leg(2,'out')]),tx_hash:'same'},b={...group('transfer_in',[leg(2,'in')]),id:'b',tx_hash:'same'}
 eq(calc(book([h()],[h()],[],[a,b])).netFlowsUsd,0)
 const external=calc(book([h()],[h(8,800)],[],[a]));eq(external.status,'estimate');eq(external.netFlowsUsd,-200);eq(external.returnPercent,0)
 eq(calc(book([h()],[h()],[],[a,{...b,block_time:iso(mid+1)}])).status,'incomplete')
})
Deno.test('mirrors, repeated identical rows, failed and pending events do not change holdings or returns',()=>{
 const m=manual();eq(calc(book([h()],[h(15,1500)],[m,m])).netFlowsUsd,500)
 const g=group('transfer_in',[leg(1,'in')]);const r=calc(book([h()],[h()],[],[{...g,status:'failed'},{...g,id:'p',status:'pending'},{...g,id:'mirror',is_display_mirror:true}]))
 eq(r.returnPercent,0);eq(r.periods[0].transactionRefs,[])
})
Deno.test('unknown values, exotic events, single-leg synced trades, missing clocks, over-limit and legacy snapshots are unavailable',()=>{
 const invalids=[book([h()],[h(15,1500)],[{...manual(),price_per_unit:null}]),book([h()],[h(15,1500)],[{...manual(),quote_currency:'EUR'}]),book([h()],[h()],[],[group('bridge',[leg(0,'in')])]),book([h()],[h(15,1500)],[],[group('buy',[leg(5,'in')])]),book([h()],[h()],[{...manual(),timestamp:null}]),{...book([h()],[h()]),truncated:true},book([h()],[{...h(),canonicalAssetKey:null}]),book([h()],[{...h(),priceStatus:'stale'}])]
 for(const data of invalids){const r=calc(data);assert(r.status!=='estimate');eq(r.returnPercent,null)}
 const legacy=book([h()],[h()]);delete (legacy.snapshots[0].risk_summary as any).performance;eq(calc(legacy).status,'incomplete')
})
Deno.test('asset identity, missing transactions and unknown fees cannot reconcile by ticker or unexplained balance changes',()=>{
 eq(calc(book([h()],[h(11,1100)])).status,'incomplete')
 eq(calc(book([h()],[h(10,1000,'imposter')])).status,'incomplete')
 eq(calc(book([h()],[h(15,1500)],[{...manual(),fee_amount:1,fee_currency:null}])).status,'incomplete')
 eq(calc(book([h()],[h(0,0)],[manual('sell',10,0,mid)])).returnPercent,-100)
})
Deno.test('linked periods retain gaps instead of skipping bad days',()=>{
 const data=book([h()],[h(10,1100)]);data.snapshots.push(snap(end+day,[h(10,1210)]));const r=portfolioPerformance(data,end+day+1);assert(Math.abs(r.returnPercent!-21)<1e-8)
 data.snapshots[1].holdings_summary[0].priceStatus='unpriced';eq(portfolioPerformance(data,end+day+1).returnPercent,null)
})
Deno.test('fresh snapshot metadata retains original display fields and never backfills historical words',()=>{
 const r=performanceSnapshot([{assetSymbol:'BTC',canonicalAssetKey:'native:bitcoin',quantity:0,currentValue:0,allocationPct:0,priceStatus:'unpriced',marketContext:{}}] as any,{incompleteHistory:true,unpricedCount:1,staleCount:0} as any)
 eq(r.quality,{version:1,incompleteHistory:true,unpriced:1,stale:0});eq(r.holdings[0].value,0);eq(r.holdings[0].canonicalAssetKey,'native:bitcoin')
})
Deno.test('same inputs have one version across page and saved research; failed reads are failures',async()=>{
 const db={rpc:async()=>({data:book([h()],[h()])})},a=await readPortfolioPerformance(db,'org','p',end+1),b=await readPortfolioPerformance(db,'org','p',end+100)
 eq(a.version,b.version);eq(a.returnPercent,b.returnPercent)
 eq((await readPortfolioPerformance({rpc:async()=>({error:{message:'private details'}})},'org','p',end)).status,'error')
})
