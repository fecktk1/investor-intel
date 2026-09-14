import { assertEquals, assertThrows, assertAlmostEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { chartOutcome, chartOutcomeDrawing, type OutcomeSpec } from './chart-outcome.ts'
const start=Date.parse('2026-09-01T00:00:00Z'),step=3600000
const spec:OutcomeSpec={direction:'long',trigger:'close_above',entry:100,stop:90,target:120,quantity:2,feeBps:0,slippageBps:0,start}
const bar=(i:number,o=100,h=110,l=95,c=105)=>({t:start+i*step,closedAt:start+(i+1)*step-1,recordedAt:start+(i+1)*step,o,h,l,c,v:10})
const run=(bars:ReturnType<typeof bar>[],over:Partial<OutcomeSpec>={},at=start+bars.length*step)=>chartOutcome(bars,{...spec,...over},{at,intervalMs:step})
Deno.test('outcome strict close trigger excludes an earlier wick and equality, with no manufactured entry',()=>{
 assertEquals(run([bar(0,99,108,95,99),bar(1,99,106,98,100)]).status,'pending')
 const r=run([bar(0,100,125,80,105)]);assertEquals(r.status,'open');assertEquals(r.pnl,null);assertEquals(r.entry?.price,105)
})
Deno.test('outcome target uses the later bar and independently calculated two-sided costs',()=>{
 const r=run([bar(0),bar(1,106,125,100,121)],{feeBps:10,slippageBps:20})
 assertEquals(r.status,'target');assertAlmostEquals(r.pnl!.entryPrice,105.21);assertAlmostEquals(r.pnl!.exitPrice,119.76)
 assertAlmostEquals(r.pnl!.gross,29.1);assertAlmostEquals(r.pnl!.fees,.44994);assertAlmostEquals(r.pnl!.net,28.65006)
 assertEquals(r.entry?.closedAt,start+step-1);assertEquals(r.exit?.exactTime,false)
})
Deno.test('outcome does not decide which of two same-candle exits happened first',()=>{
 const r=run([bar(0),bar(1,105,125,85,110)])
 assertEquals(r.status,'ambiguous');assertEquals(r.pnl,null);assertEquals(r.possibilities,[{label:'Stop first',net:-30},{label:'Target first',net:30}])
})
Deno.test('outcome touch entries cannot infer whether the same-bar exit preceded entry',()=>{
 const r=run([bar(0,110,125,95,115)],{trigger:'touch'})
 assertEquals(r.status,'ambiguous');assertEquals(r.pnl,null);assertEquals(r.possibilities,[])
 const open=run([bar(0,100,125,95,115)],{trigger:'touch'});assertEquals(open.status,'target');assertEquals(open.pnl?.net,40)
})
Deno.test('outcome models a stop opening gap at the opening price, never an unavailable stop price',()=>{
 const r=run([bar(0),bar(1,80,125,75,100)]);assertEquals(r.status,'stopped');assertEquals(r.exit?.price,80);assertEquals(r.exit?.exactTime,true);assertEquals(r.pnl?.net,-50)
 const target=run([bar(0),bar(1,125,130,80,100)]);assertEquals(target.status,'target');assertEquals(target.exit?.price,120)
})
Deno.test('outcome short direction reverses prices and applies adverse slippage on both sides',()=>{
 const r=run([bar(0,101,105,90,95),bar(1,94,100,75,80)],{direction:'short',trigger:'close_below',stop:110,target:80,feeBps:10,slippageBps:20})
 assertEquals(r.status,'target');assertAlmostEquals(r.pnl!.entryPrice,94.81);assertAlmostEquals(r.pnl!.exitPrice,80.16);assertAlmostEquals(r.pnl!.net,28.95006)
})
Deno.test('outcome stops at missing or invalid OHLC and does not skip forward to a later target',()=>{
 assertEquals(run([bar(0),bar(2,105,125,95,120)],{},start+3*step).status,'incomplete')
 assertEquals(run([bar(0),bar(1,105,106,115,105),bar(2,105,125,95,120)]).status,'incomplete')
 assertEquals(run([bar(1)],{},start+2*step).status,'incomplete')
 assertEquals(run([bar(0)],{},start+3*step).status,'incomplete')
})
Deno.test('outcome has prefix-stable cutoff and recording-time filtering without future outcomes',()=>{
 const bars=[bar(0),bar(1,105,125,95,120)]
 assertEquals(run(bars,{},start+step).status,'open')
 bars[1].recordedAt=start+10*step
 const known=chartOutcome(bars,spec,{at:start+2*step,intervalMs:step,knownOnly:true});assertEquals(known.status,'incomplete');assertEquals(known.pnl,null)
})
Deno.test('outcome distinguishes missed bracket, open position and missing coverage',()=>{
 assertEquals(run([bar(0,100,130,95,125)]).status,'missed');assertEquals(run([bar(0)],{target:null}).status,'open')
 assertEquals(run([]).status,'unavailable');assertEquals(run([bar(0)],{},start).status,'unavailable')
})
Deno.test('outcome rejects invalid costs, side, bracket, clocks and numeric overflow',()=>{
 for(const patch of [{entry:NaN},{stop:100},{target:90},{quantity:0},{feeBps:-1},{slippageBps:1001},{entry:1e308,quantity:1e308},{start:NaN}])assertThrows(()=>run([bar(0)],patch))
 assertThrows(()=>chartOutcome([bar(0)],spec,{at:start-1,intervalMs:step}));assertThrows(()=>chartOutcome([bar(0)],spec,{at:start+step}))
})
Deno.test('outcome saved annotation retains exact assumptions and time provenance without creating a trade',()=>{
 const r=run([bar(0),bar(1,105,125,85,110)],{feeBps:10});const note=chartOutcomeDrawing(r,'d407b24f-c2d5-4e3a-9d96-79109903bcfe','Synthetic fixture · USD')
 assertEquals(note.tool,'text');assertEquals(note.anchors[0],{t:start+step-1,price:105});assertStringIncludes(note.text!,'ambiguous');assertStringIncludes(note.text!,'quantity 2; fee 10bps each side');assertStringIncludes(note.text!,'Retrospective rehearsal');assertStringIncludes(note.text!,'2026-09-01T02:00:00.000Z')
})
