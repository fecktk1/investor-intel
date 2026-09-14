import {assertEquals as eq,assert,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {chartStructure,structureDrawing} from './chart-structure.ts'
const start=1789041600000,step=60000
const bars=(rows:number[][])=>rows.map(([o,h,l,c],i)=>({t:start+i*step,closedAt:start+(i+1)*step-1,recordedAt:start+(i+1)*step,o,h,l,c,v:100}))
const fixture=bars([[100,102,98,100],[100,110,99,108],[108,109,101,105],[105,112,104,109],[109,116,108,114],[114,115,110,113]])
const options={at:start+20*step,intervalMs:step,window:1,atrPeriod:2}
Deno.test('a swing is unavailable until the right-hand bar closes; original and confirmation times differ',()=>{
 eq(chartStructure(fixture,{...options,at:fixture[2].closedAt-1}).pivots.length,0)
 const pivot=chartStructure(fixture,{...options,at:fixture[2].closedAt}).pivots[0]
 eq(pivot.price,110);eq(pivot.t,fixture[1].t);eq(pivot.confirmedAt,fixture[2].closedAt);eq(pivot.knownAt,fixture[2].recordedAt)
})
Deno.test('the same confirmed level distinguishes a wick sweep, first close break, and later retest',()=>{
 const r=chartStructure(fixture,options),id=r.pivots[0].id,events=r.events.filter(e=>e.pivotId===id)
 eq(events.map(e=>e.kind),['sweep','break','retest']);eq(events.map(e=>e.confirmedAt),[fixture[3].closedAt,fixture[4].closedAt,fixture[5].closedAt]);eq(r.pivots[0].brokenAt,fixture[4].closedAt)
})
Deno.test('calculating a past cursor on the complete dataset equals calculating only its known prefix',()=>{
 for(let i=0;i<fixture.length;i++){const opts={...options,at:fixture[i].recordedAt,knownOnly:true};const {omitted:_full,...full}=chartStructure(fixture,opts),{omitted:_prefix,...prefix}=chartStructure(fixture.slice(0,i+1),opts);eq(full,prefix)}
})
Deno.test('late provider capture is excluded in known-only analysis',()=>{
 const late=fixture.map((b,i)=>i===2?{...b,recordedAt:options.at+1}:b)
 assert(chartStructure(late,options).pivots.some(p=>p.price===110));eq(chartStructure(late,{...options,knownOnly:true}).pivots.some(p=>p.price===110),false)
})
Deno.test('equal highs, gaps in time, close-only data and unknown closing clocks never create pivots',()=>{
 eq(chartStructure(bars([[100,110,90,100],[100,110,90,100],[100,110,90,100]]),options).pivots.length,0)
 eq(chartStructure([fixture[0],fixture[1],{...fixture[2],t:fixture[2].t+step,closedAt:fixture[2].closedAt+step}],options).pivots.length,0)
 eq(chartStructure(fixture.map(b=>({...b,o:null,h:null,l:null})),options).pivots.length,0)
 eq(chartStructure(fixture.map(b=>({...b,closedAt:undefined})),options).pivots.length,0)
 eq(chartStructure(fixture,{...options,intervalMs:null}).reason,'A verified bar interval is required for structure analysis.')
})
Deno.test('gap boundaries use the first and third wicks; later fills never appear in earlier replay',()=>{
 const f=bars([[100,102,98,100],[105,108,103,107],[110,113,109,112],[110,112,104,106],[106,107,101,103]])
 const earlier=chartStructure(f,{...options,at:f[2].closedAt}).gaps[0]
 eq(earlier.lower,102);eq(earlier.upper,109);eq(earlier.filledAt,undefined)
 eq(chartStructure(f,options).gaps[0].filledAt,f[4].closedAt)
})
Deno.test('swing labels and ATR distance have a defined reference, and invalid parameters fail',()=>{
 const r=chartStructure(fixture,options);eq(r.pivots.filter(p=>p.kind==='high').map(p=>p.classification),['H','HH']);assert(r.atr!>0);assert(r.pivots[0].distanceAtr!<0)
 assertThrows(()=>chartStructure(fixture,{...options,window:11}));assertThrows(()=>chartStructure(fixture,{...options,at:NaN}))
})
Deno.test('selected findings become bounded editable drawings with formula and source provenance',()=>{
 const result=chartStructure(fixture,options),d=structureDrawing(result.pivots[0],'d204aaf9-ef74-4f93-a1c3-936d2c4be4f1','synthetic fixture')
 eq(d.tool,'ray');eq(d.anchors[0].t,fixture[1].t);eq(d.anchors[1].t,fixture[2].closedAt);assert(d.text.includes('structure-1'));assert(d.text.includes('Source: synthetic fixture'))
})
