import assert from 'node:assert/strict'
import { cmcCallProof, cmcReproduceCommand, cmcReproduceRequest, cmcResponseExcerpt, shellQuote, CMC_EXCERPT_MAX_CHARS, CMC_REPRODUCE_BASE } from './cmc-reproduce.ts'
import { CMC_CAPABILITIES, CMC_CONVERT_EXEMPT, cmcAddsConvert, cmcParams, cmcRequestBody } from './cmc-capabilities.ts'
import { requestCmc } from './cmc-transport.ts'

// A POSIX-shell word splitter for exactly the quoting the command uses: bare
// words, '...' (no escapes inside) and "..." (no escapes emitted), glued by \'.
function shellWords(command:string):string[] {
  const out:string[]=[];let word='',has=false,i=0
  while(i<command.length){
    const c=command[i]
    if(c===' '){if(has){out.push(word);word='';has=false}i++;continue}
    has=true
    if(c==="'"){const end=command.indexOf("'",i+1);assert.ok(end>i,'unterminated single quote');word+=command.slice(i+1,end);i=end+1;continue}
    if(c==='"'){const end=command.indexOf('"',i+1);assert.ok(end>i,'unterminated double quote');word+=command.slice(i+1,end);i=end+1;continue}
    if(c==='\\'){word+=command[i+1];i+=2;continue}
    word+=c;i++
  }
  if(has)out.push(word)
  return out
}
const flagValues=(words:string[],flag:string)=>words.flatMap((w,i)=>w===flag?[words[i+1]]:[])
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const live=(capability:string,input:Record<string,unknown>={},extra:Record<string,unknown>={})=>({capability,endpoint:CMC_CAPABILITIES[capability].path,
  parameters:cmcParams(capability,input),httpStatus:200,creditCount:1,elapsedMs:12,origin:'live',keyMode:'keyed',cacheAgeSeconds:0,ttlSeconds:240,
  staleUntil:null,fetchedAt:'2026-09-22T10:00:00.000Z',reservation:'3f2c9a1e-8b7d-4c6e-9f00-1a2b3c4d5e6f',...extra})

Deno.test('a live keyed receipt reproduces as curl with the key only as the literal $CMC_API_KEY',()=>{
  const receipt=live('listings',{limit:10},{fingerprint:'0123456789abcdef01234567'})
  const command=cmcReproduceCommand(receipt)!
  assert.ok(command)
  assert.ok(command.includes('-H "X-CMC_PRO_API_KEY: $CMC_API_KEY"'))
  // No key material and no reservation/UUID ever rides along, even when the receipt carries one.
  assert.ok(!UUID.test(command))
  assert.ok(!command.includes('0123456789abcdef'))
  assert.ok(!command.includes(receipt.reservation))
  const words=shellWords(command)
  assert.deepEqual(words.slice(0,4),['curl','-sS','-G',`${CMC_REPRODUCE_BASE}/v3/cryptocurrency/listings/latest`])
  assert.deepEqual(flagValues(words,'-H'),['X-CMC_PRO_API_KEY: $CMC_API_KEY','Accept: application/json'])
})

Deno.test('a cached figure and a remembered failure reproduce the call behind them, and say which call it is',()=>{
  const command=cmcReproduceCommand(live('listings'))
  // The shared cache row is keyed by these exact parameters, so the call that
  // filled it is byte for byte the same request.
  assert.equal(cmcReproduceCommand(live('listings',{},{origin:'cache',creditCount:null,reservation:null})),command)
  assert.equal(cmcReproduceCommand(live('listings',{},{origin:'negative-cache'})),command)
  assert.equal(cmcReproduceRequest(live('listings'))?.meaning,'this_call')
  assert.equal(cmcReproduceRequest(live('listings',{},{origin:'cache'}))?.meaning,'cache_fill')
  assert.equal(cmcReproduceRequest(live('listings',{},{origin:'negative-cache'}))?.meaning,'failed_call')
})

Deno.test('a capture reproduces only from the request it recorded at capture time',()=>{
  const lane={...live('listings'),capability:'regime',endpoint:'/v3/cryptocurrency/listings/latest',parameters:{},origin:'capture',provider:'coinmarketcap'}
  // A capture receipt names its lane: without the recorded request nothing is exact.
  assert.equal(cmcReproduceCommand(lane),null)
  const recorded={...lane,proof:{request:{capability:'rwaList',endpoint:'/v5/real-world-assets/assets/list',parameters:{limit:'250',start:'1'}}}}
  const words=shellWords(cmcReproduceCommand(recorded)!)
  assert.equal(words[3],`${CMC_REPRODUCE_BASE}/v5/real-world-assets/assets/list`)
  assert.deepEqual(flagValues(words,'--data-urlencode'),['limit=250','start=1','convert=USD'])
  assert.equal(cmcReproduceRequest(recorded)?.meaning,'capture_call')
  assert.equal(cmcReproduceCommand({...recorded,origin:'stored'}),cmcReproduceCommand(recorded))
  // A recorded request is held to the same registry rules as a receipt.
  assert.equal(cmcReproduceCommand({...lane,proof:{request:{capability:'rwaList',endpoint:'/v1/cryptocurrency/map',parameters:{}}}}),null)
  assert.equal(cmcReproduceCommand({...lane,proof:{request:{capability:'rwaList',endpoint:'/v5/real-world-assets/assets/list',parameters:{api_key:'x'}}}}),null)
})

Deno.test('a keyless receipt reproduces in the keyless form: no key header at all',()=>{
  const command=cmcReproduceCommand(live('listings',{},{keyMode:'keyless'}))!
  assert.ok(command)
  assert.ok(!command.includes('X-CMC_PRO_API_KEY')&&!command.includes('$CMC_API_KEY'))
  assert.deepEqual(flagValues(shellWords(command),'-H'),['Accept: application/json'])
})

Deno.test('no command for anything that is not a registered call',()=>{
  for(const origin of [undefined,'LIVE','capture','stored'])assert.equal(cmcReproduceCommand(live('listings',{},{origin})),null,String(origin))
  assert.equal(cmcReproduceCommand(live('listings',{},{keyMode:null})),null)
  assert.equal(cmcReproduceCommand(live('listings',{},{endpoint:'/v1/cryptocurrency/map'})),null)
  assert.equal(cmcReproduceCommand(live('listings',{},{endpoint:''})),null)
  assert.equal(cmcReproduceCommand(live('listings',{},{capability:'notARealCapability'})),null)
  assert.equal(cmcReproduceCommand({...live('listings'),capability:'constructor',endpoint:undefined}),null)
  assert.equal(cmcReproduceCommand(live('listings',{},{provider:'coingecko'})),null)
  assert.equal(cmcReproduceCommand(live('listings',{},{parameters:{limit:'10',apiKey:'x'}})),null)
  assert.equal(cmcReproduceCommand(live('listings',{},{parameters:{limit:10}})),null)
  assert.equal(cmcReproduceCommand(null),null)
  assert.equal(cmcReproduceCommand(undefined),null)
  assert.ok(cmcReproduceCommand(live('listings',{},{provider:'coinmarketcap'})))
})

Deno.test('GET parameters are sent one --data-urlencode each, in receipt order, then convert',()=>{
  const receipt=live('quotes',{id:'1,1027'})
  const words=shellWords(cmcReproduceCommand(receipt)!)
  assert.deepEqual(flagValues(words,'--data-urlencode'),[...Object.entries(receipt.parameters).map(([k,v])=>`${k}=${v}`),'convert=USD'])
  assert.ok(!words.includes('-X'))
})

Deno.test('values with quotes and spaces are single-quoted safely',()=>{
  assert.equal(shellQuote("it's here"),"'it'\\''s here'")
  const receipt={...live('map'),parameters:{symbol:"BTC ETH'; rm -rf ~ #",limit:'5'}}
  const command=cmcReproduceCommand(receipt)!
  assert.ok(command.includes(`--data-urlencode 'symbol=BTC ETH'\\''; rm -rf ~ #'`))
  assert.deepEqual(flagValues(shellWords(command),'--data-urlencode'),["symbol=BTC ETH'; rm -rf ~ #",'limit=5'])
})

Deno.test('POST capabilities send the transport body, not a query string',()=>{
  const valid=live('dexBatch',{platform:'ethereum',addresses:['0x1111111111111111111111111111111111111111']})
  // A quote inside a POST body must survive shell quoting too.
  const receipt={...valid,parameters:{...valid.parameters,addresses:"0x1111111111111111111111111111111111111111,0x2222'2222"}}
  const words=shellWords(cmcReproduceCommand(receipt)!)
  assert.deepEqual(words.slice(0,5),['curl','-sS','-X','POST',`${CMC_REPRODUCE_BASE}/v1/dex/tokens/batch-query`])
  assert.ok(!words.includes('-G')&&!words.includes('--data-urlencode'))
  assert.deepEqual(flagValues(words,'-H'),['X-CMC_PRO_API_KEY: $CMC_API_KEY','Accept: application/json','Content-Type: application/json'])
  const [body]=flagValues(words,'--data')
  assert.deepEqual(JSON.parse(body),cmcRequestBody('dexBatch',receipt.parameters))
  assert.deepEqual(JSON.parse(body).addresses,['0x1111111111111111111111111111111111111111',"0x2222'2222"])
  const meme=live('dexMeme',{})
  assert.deepEqual(JSON.parse(flagValues(shellWords(cmcReproduceCommand(meme)!),'--data')[0]),cmcRequestBody('dexMeme',meme.parameters))
})

Deno.test('the exemption list moved intact: dex never, exempt names never, everything else converts',()=>{
  assert.equal(CMC_CONVERT_EXEMPT.length,23)
  for(const name of Object.keys(CMC_CAPABILITIES))assert.equal(cmcAddsConvert(name),!name.startsWith('dex')&&!CMC_CONVERT_EXEMPT.includes(name),name)
  assert.equal(cmcAddsConvert('listings'),true)
  assert.equal(cmcAddsConvert('priceConversion'),false)
  assert.equal(cmcAddsConvert('dexPools'),false)
})

// Parity against the real transport: the URL it fetches and the command's query
// carry the same parameters, and convert=USD exactly when the transport adds it.
Deno.test('reproduced GET matches the URL the transport actually fetched',async()=>{
  const names=['COINMARKETCAP_API_KEY','CMC_API_KEY','CMC_ENABLED','CMC_VERIFIED_BASELINE_PLAN','CMC_ACCESS_PROFILE','CMC_VERIFIED_HACKATHON_PLAN','CMC_HACKATHON_EXPIRES_AT','CMC_CONNECTED_DEMAND_ENABLED'],saved=names.map(n=>Deno.env.get(n)),originalFetch=globalThis.fetch
  Deno.env.set(names[0],'synthetic-cmc-test-key');Deno.env.set('CMC_ENABLED','true');Deno.env.set('CMC_VERIFIED_BASELINE_PLAN','startup')
  Deno.env.delete('CMC_ACCESS_PROFILE');Deno.env.delete('CMC_HACKATHON_EXPIRES_AT');Deno.env.delete('CMC_CONNECTED_DEMAND_ENABLED')
  const fakeDb=()=>{const q:any={select:()=>q,eq:()=>q,upsert:()=>Promise.resolve({error:null}),maybeSingle:()=>Promise.resolve({data:null}),update:()=>q,insert:()=>Promise.resolve({error:null}),then:(r:any)=>r({error:null})}
    return {rpc:(name:string)=>Promise.resolve({data:name==='cmc_account_sync_claim'?{allowed:false,reason:'account_fresh'}:name==='cmc_request_reserve'?{allowed:true,reservation_id:'r'}:true}),from:()=>q}}
  try{
    const cases:[string,Record<string,unknown>][]=[['listings',{limit:5}],['map',{symbol:'BTC'}],['rwaQuotes',{rwa_id:'12'}],['priceConversion',{amount:'2',id:'1',convert:'EUR'}],['ohlcv',{id:'1'}],['dexPools',{platform:'ethereum',address:'0x1111111111111111111111111111111111111111'}]]
    for(const [name,input] of cases){
      let fetched=''
      globalThis.fetch=(async(url:string)=>{fetched=String(url);return Response.json({data:[],status:{error_code:0,credit_count:1}})}) as typeof fetch
      const result=await requestCmc(name,input,{supabase:fakeDb(),kind:'request'} as any)
      assert.ok(fetched,`${name}: transport made no call`)
      const receipt=result.receipt?.origin==='live'?result.receipt:live(name,input)
      const command=cmcReproduceCommand(receipt)!
      assert.ok(command,name)
      assert.ok(!command.includes('synthetic-cmc-test-key'),name)
      const url=new URL(fetched),words=shellWords(command)
      assert.equal(words[3],`${url.origin}${url.pathname}`,name)
      assert.deepEqual(flagValues(words,'--data-urlencode'),[...url.searchParams].map(([k,v])=>`${k}=${v}`),name)
      assert.equal(url.searchParams.get('convert')==='USD'&&!('convert' in receipt.parameters),cmcAddsConvert(name),name)
    }
  }finally{globalThis.fetch=originalFetch;names.forEach((n,i)=>saved[i]==null?Deno.env.delete(n):Deno.env.set(n,saved[i]!))}
})

// ─── Response excerpt ────────────────────────────────────────────────────────

const rwaRow=(i:number)=>({rwa_id:i,name:`Asset ${i}`,symbol:`A${i}`,slug:`asset-${i}`,asset_type:'commodity',
  tokenized_market_cap:1000+i,tokenized_volume_24h:10+i,tokens:[{crypto_id:100+i,symbol:`T${i}a`},{crypto_id:200+i,symbol:`T${i}b`},{crypto_id:300+i,symbol:`T${i}c`}]})
const RWA_LIST={status:{timestamp:'2026-09-23T02:47:01.166Z',error_code:'0',error_message:'',elapsed:7,credit_count:1},
  data:{has_more:true,total_size:791,rwa_assets:Array.from({length:25},(_,i)=>rwaRow(i+1))}}

/** Every leaf the excerpt shows is the body's own value at the same path (or,
 * for shortened text, its prefix): an excerpt can drop, never invent. */
function assertSubset(excerpt:unknown,body:unknown,path='data'){
  if(typeof excerpt==='string'&&typeof body==='string'){assert.ok(excerpt===body||(excerpt.endsWith('…')&&body.startsWith(excerpt.slice(0,-1))),path);return}
  if(excerpt===null||typeof excerpt!=='object'){assert.deepEqual(excerpt,body,path);return}
  assert.ok(body&&typeof body==='object',path)
  for(const [k,v] of Object.entries(excerpt as Record<string,unknown>))assertSubset(v,(body as any)[k],`${path}.${k}`)
}

Deno.test('the excerpt keeps the status block as returned and the first rows, and names each cut list with its real total',()=>{
  const excerpt=cmcResponseExcerpt(RWA_LIST)!
  assert.deepEqual(excerpt.status,RWA_LIST.status)
  assert.equal((excerpt.data as any).total_size,791)
  assert.equal((excerpt.data as any).rwa_assets.length,3)
  assert.deepEqual(excerpt.lists[0],{path:'data.rwa_assets',shown:3,total:25})
  // A member's own list is cut harder and named too.
  assert.ok(excerpt.lists.some(l=>l.path==='data.rwa_assets[0].tokens'&&l.shown===2&&l.total===3))
  assert.equal(excerpt.trimmed,true);assert.equal(excerpt.dataOmitted,false)
  assertSubset(excerpt.data,RWA_LIST.data)
  assert.ok(JSON.stringify({status:excerpt.status,data:excerpt.data}).length<=CMC_EXCERPT_MAX_CHARS)
})

Deno.test('a keyed map of records is cut like a list, and long text is shortened and counted',()=>{
  const info={status:{error_code:0,credit_count:2},data:Object.fromEntries(Array.from({length:70},(_,i)=>[String(i+1),{id:i+1,description:'x'.repeat(900),urls:{website:['https://example.com']}}]))}
  const excerpt=cmcResponseExcerpt(info)!
  assert.deepEqual(Object.keys(excerpt.data as object),['1','2','3'])
  assert.deepEqual(excerpt.lists[0],{path:'data',shown:3,total:70})
  assert.equal(excerpt.shortened,3)
  assert.ok(((excerpt.data as any)['1'].description as string).endsWith('…'))
  assertSubset(excerpt.data,info.data)
})

Deno.test('an excerpt never exceeds its bound: rows give way first, then the data member',()=>{
  const wide={status:{error_code:0,credit_count:1},data:Array.from({length:40},(_,i)=>Object.fromEntries(Array.from({length:60},(_,k)=>[`field_${k}`,`value ${i} ${k} ${'y'.repeat(60)}`])))}
  const excerpt=cmcResponseExcerpt(wide)!
  assert.ok(JSON.stringify({status:excerpt.status,data:excerpt.data}).length<=CMC_EXCERPT_MAX_CHARS)
  assert.equal(excerpt.dataOmitted,true);assert.equal(excerpt.data,null)
  assert.deepEqual(excerpt.lists,[{path:'data',shown:0,total:40}])
  assert.deepEqual(excerpt.status,wide.status)
  const small={status:{error_code:0,credit_count:0},data:[{id:1}]}
  const whole=cmcResponseExcerpt(small)!
  assert.deepEqual(whole.data,small.data);assert.equal(whole.trimmed,false);assert.deepEqual(whole.lists,[])
})

Deno.test('a proof reports the charge its own response carried, and says why an excerpt is missing',()=>{
  const proof=cmcCallProof(RWA_LIST,{source:'shared-cache-row',httpStatus:200,retrievedAt:'2026-09-23T02:47:01.178+00:00'})
  assert.equal(proof.creditCount,1);assert.equal(proof.errorCode,'0');assert.equal(proof.httpStatus,200)
  assert.equal(proof.respondedAt,'2026-09-23T02:47:01.166Z');assert.equal(proof.retrievedAt,'2026-09-23T02:47:01.178Z')
  assert.equal(proof.excerptMissing,null);assert.ok(proof.excerpt)
  // A reported zero is a real charge of zero.
  assert.equal(cmcCallProof({status:{credit_count:0},data:[]},{source:'live-response'}).creditCount,0)
  const none=cmcCallProof(null,{source:'shared-cache-row',httpStatus:403,missing:'failure_body_not_kept'})
  assert.equal(none.excerpt,null);assert.equal(none.excerptMissing,'failure_body_not_kept');assert.equal(none.creditCount,null)
  assert.equal(cmcCallProof({data:[]},{source:'live-response'}).creditCount,null)
  // The key is never material; were a body ever to echo it, the excerpt is withheld.
  const echoed=cmcCallProof({status:{credit_count:1},data:[{note:'synthetic-cmc-test-key'}]},{source:'live-response',secret:'synthetic-cmc-test-key'})
  assert.equal(echoed.excerpt,null);assert.equal(echoed.excerptMissing,'withheld');assert.equal(echoed.creditCount,1)
})
