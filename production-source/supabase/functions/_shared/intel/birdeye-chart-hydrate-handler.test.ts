import {assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts'
Deno.test('OHLCV warming uses the real cron handler and preserves cache-only reuse and bounds',async t=>{
  const oldFetch=globalThis.fetch,serve=Object.getOwnPropertyDescriptor(Deno,'serve')!
  const settings={SUPABASE_URL:'https://qa-warm.invalid',SUPABASE_SERVICE_ROLE_KEY:'qa-service',CRON_SECRET:'qa-cron'},old=new Map(Object.keys(settings).map(k=>[k,Deno.env.get(k)]))
  let handler:any;const reads:string[]=[]
  const tokens=[{chain:'solana',address:'So11111111111111111111111111111111111111112'}]
  try{
    for(const [k,v]of Object.entries(settings))Deno.env.set(k,v)
    Object.defineProperty(Deno,'serve',{configurable:true,value:(fn:any)=>{handler=fn;return {}}})
    globalThis.fetch=async input=>{
      const url=new URL(input instanceof Request?input.url:String(input));reads.push(url.pathname)
      if(url.origin!==settings.SUPABASE_URL||url.pathname!=='/rest/v1/rpc/intel_birdeye_chart_claim')throw Error('Unexpected provider or database operation')
      return new Response(JSON.stringify({claimed:false,candles:[{t:1789041600000,o:10,h:12,l:9,c:11,v:0}],state:'fresh',fetchedAt:'2026-09-11T08:00:00Z'}),{headers:{'Content-Type':'application/json'}})
    }
    await import('../../birdeye-intel-hydrate/index.ts')
    const call=async(body:any,auth=true)=>{reads.length=0;return await handler(new Request('https://qa-warm.invalid/functions/v1/birdeye-intel-hydrate',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'x-cron-secret':'qa-cron'}:{})},body:JSON.stringify(body)}))}
    await t.step('cron authentication remains mandatory',async()=>{assertEquals((await call({modes:['ohlcv'],tokens},false)).status,401);assertEquals(reads,[])})
    await t.step('explicit identity and bounded token/timeframe input are required',async()=>{for(const body of [{modes:['ohlcv']},{modes:['ohlcv'],tokens:Array(6).fill(tokens[0])},{modes:['ohlcv'],tokens,timeframes:['1s']}]){assertEquals((await call(body)).status,400);assertEquals(reads,[])}})
    await t.step('a warm OHLCV request returns exact cached data without a provider request',async()=>{const response=await call({modes:['ohlcv'],tokens,timeframes:['1H'],debug:true}),body=await response.json();assertEquals(response.status,200);assertEquals(body.ohlcv,1);assertEquals(body.ohlcv_refreshed,0);assertEquals(body.ohlcv_reused,1);assertEquals(reads,['/rest/v1/rpc/intel_birdeye_chart_claim']);assertEquals((Object.values(body.samples)[0] as {fetched_at:string}).fetched_at,'2026-09-11T08:00:00Z')})
  }finally{globalThis.fetch=oldFetch;Object.defineProperty(Deno,'serve',serve);for(const [k,v]of old)if(v===undefined)Deno.env.delete(k);else Deno.env.set(k,v)}
})
