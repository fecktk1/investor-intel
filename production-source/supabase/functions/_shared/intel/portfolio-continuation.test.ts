import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {continuePortfolioContext} from './portfolio-continuation.ts'
Deno.test('a retained continuation does not hold the saved report response and still completes exactly once',async()=>{
 let release!:()=>void,finished=0;const retained:Promise<void>[]=[]
 const pending=new Promise<void>(resolve=>release=resolve)
 await continuePortfolioContext(async()=>{await pending;finished++},task=>{retained.push(task)})
 eq(finished,0);eq(retained.length,1);release();await retained[0];eq(finished,1)
})
Deno.test('without runtime retention the continuation is awaited, including registration failures',async()=>{
 for(const register of [undefined,()=>{throw Error('registration unavailable')}]){
  let finish!:()=>void,returned=false
  const pending=new Promise<void>(resolve=>finish=resolve)
  const task=continuePortfolioContext(()=>pending,register).then(()=>{returned=true})
  await Promise.resolve();eq(returned,false);finish();await task;eq(returned,true)
 }
})
