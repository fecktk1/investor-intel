// The wire layer, with no database and no token.
//
// Everything here is about the shape a client sees. If a handshake, a refusal or
// a notification comes back in the wrong shape, a client reports "malformed
// response" to the person and the whole surface looks broken however correct the
// tools are, so these are the assertions worth pinning.

import {assert,assertEquals,assertRejects,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
 dispatchRpc,parseRpcRequest,isNotification,negotiateProtocolVersion,rpcSuccess,rpcFailure,
 jsonToolResult,errorToolResult,JsonRpcError,RPC,SUPPORTED_PROTOCOL_VERSIONS,LATEST_PROTOCOL_VERSION,
 SERVER_INFO,SUPPORTED_METHODS,type McpDispatch,
} from './mcp-protocol.ts'

const dispatch=(overrides:Partial<McpDispatch>={}):McpDispatch=>({
 instructions:'Instructions.',
 listTools:()=>[{name:'search_assets',title:'Find an asset',description:'d',inputSchema:{type:'object',properties:{},additionalProperties:false}}],
 listResources:()=>[{uri:'investor-intel://tools',name:'Tool catalogue'}],
 readResource:(uri)=>uri==='investor-intel://tools'?{uri,mimeType:'application/json',text:'{"tools":[]}'}:null,
 listPrompts:()=>[{name:'ground_a_claim',title:'Check a claim'}],
 getPrompt:(name,args)=>name==='ground_a_claim'
  ?{description:'Check a claim.',messages:[{role:'user' as const,content:{type:'text' as const,text:`claim=${String(args.claim??'')}`}}]}
  :null,
 callTool:(name,args)=>Promise.resolve(jsonToolResult({called:name,args})),
 ...overrides,
})

Deno.test('initialize negotiates a version the client asked for, and falls back to the latest',async()=>{
 for(const version of SUPPORTED_PROTOCOL_VERSIONS){
  const result=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:version}}),dispatch())
  assertEquals(result?.protocolVersion,version,`${version} is supported and must be echoed`)
 }
 // A client asking for a future or unknown version gets our latest rather than a
 // refused handshake.
 for(const asked of ['2099-01-01','',null,undefined,42]){
  const result=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:asked}}),dispatch())
  assertEquals(result?.protocolVersion,LATEST_PROTOCOL_VERSION)
 }
 assertEquals(negotiateProtocolVersion('2025-03-26'),'2025-03-26')
 assertEquals(negotiateProtocolVersion('nonsense'),LATEST_PROTOCOL_VERSION)
})

Deno.test('initialize advertises only the capabilities that are implemented',async()=>{
 const result=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method:'initialize',params:{}}),dispatch())
 const capabilities=result?.capabilities as Record<string,Record<string,unknown>>
 assertEquals(Object.keys(capabilities).sort(),['prompts','resources','tools'])
 // A stateless server cannot notify anyone of a change, so claiming listChanged
 // would be a promise it can never keep.
 for(const key of Object.keys(capabilities))assertEquals(capabilities[key].listChanged,false,`${key}.listChanged must be false`)
 assertEquals(capabilities.resources.subscribe,false)
 assertEquals((result?.serverInfo as Record<string,unknown>).name,SERVER_INFO.name)
 assert(String(result?.instructions).length>0,'instructions must reach the client')
})

Deno.test('ping answers with an empty result, and the handshake notifications do nothing',async()=>{
 assertEquals(await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:9,method:'ping'}),dispatch()),{})
 for(const method of ['notifications/initialized','notifications/cancelled']){
  const request=parseRpcRequest({jsonrpc:'2.0',method})
  assert(isNotification(request),`${method} carries no id`)
  assertEquals(await dispatchRpc(request,dispatch()),null,'a notification produces no result')
 }
})

Deno.test('tools, resources and prompts come back under the keys the spec names',async()=>{
 const tools=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method:'tools/list'}),dispatch())
 assert(Array.isArray(tools?.tools))
 assertEquals((tools!.tools as unknown[]).length,1)
 const resources=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:2,method:'resources/list'}),dispatch())
 assert(Array.isArray(resources?.resources))
 const templates=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:3,method:'resources/templates/list'}),dispatch())
 assertEquals(templates?.resourceTemplates,[],'an empty list, not a missing key')
 const prompts=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:4,method:'prompts/list'}),dispatch())
 assert(Array.isArray(prompts?.prompts))
})

// The whole point of this one: a listed resource or prompt that cannot be fetched
// is a visible failure in Claude Desktop and Cursor, which both put listed
// resources and prompts in front of the member. Every method that lists something
// must have the method that opens it.
Deno.test('everything resources/list and prompts/list advertise can actually be fetched',async()=>{
 const read=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'investor-intel://tools'}}),dispatch())
 assert(Array.isArray(read?.contents),'contents is an array, as the spec names it')
 assertEquals((read!.contents as Array<Record<string,unknown>>)[0].uri,'investor-intel://tools')
 assertEquals((read!.contents as Array<Record<string,unknown>>)[0].mimeType,'application/json')

 const got=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:2,method:'prompts/get',params:{name:'ground_a_claim',arguments:{claim:'BTC is above 80k'}}}),dispatch())
 assertEquals((got!.messages as Array<Record<string,any>>)[0].content.text,'claim=BTC is above 80k')
 assertEquals((got!.messages as Array<Record<string,any>>)[0].role,'user')

 // A uri or name that was never listed is INVALID_PARAMS naming it, not
 // METHOD_NOT_FOUND and not an empty success.
 await assertRejects(
  ()=>dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:3,method:'resources/read',params:{uri:'investor-intel://nope'}}),dispatch()),
  JsonRpcError,'is not a resource this server offers',
 )
 await assertRejects(
  ()=>dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:4,method:'prompts/get',params:{name:'nope'}}),dispatch()),
  JsonRpcError,'is not a prompt this server offers',
 )
 // A missing or wrongly shaped parameter is refused before the dispatch is asked.
 await assertRejects(()=>dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:5,method:'resources/read',params:{}}),dispatch()),JsonRpcError,'needs a uri')
 await assertRejects(()=>dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:6,method:'prompts/get',params:{}}),dispatch()),JsonRpcError,'needs a prompt name')
 await assertRejects(()=>dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:7,method:'prompts/get',params:{name:'ground_a_claim',arguments:[1]}}),dispatch()),JsonRpcError,'Prompt arguments must be an object')
})

Deno.test('every method the server advertises as supported is one dispatchRpc answers',async()=>{
 for(const method of SUPPORTED_METHODS){
  const params=method==='resources/read'?{uri:'investor-intel://tools'}
   :method==='prompts/get'?{name:'ground_a_claim'}
   :method==='tools/call'?{name:'search_assets',arguments:{}}
   :{}
  // No throw of METHOD_NOT_FOUND. A notification legitimately returns null.
  const result=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method,params}),dispatch())
  assert(result!==undefined,`${method} must be answered`)
 }
})

Deno.test('tools/call reaches the dispatch, and an unknown tool is a protocol fault',async()=>{
 const called=await dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_assets',arguments:{query:'BTC'}}}),dispatch())
 assertEquals((called as {structuredContent?:Record<string,unknown>}).structuredContent?.called,'search_assets')
 // There was no tool to fail, so this is INVALID_PARAMS rather than a tool result
 // with isError. The distinction matters: a client retries one and not the other.
 const error=await assertRejects(
  ()=>dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'nope'}}),dispatch()),
  JsonRpcError,
 )
 assertEquals(error.code,RPC.INVALID_PARAMS)
 assert(error.message.includes('tools/list'),'the refusal must say how to discover the real tools')
 // Arguments have to be an object, never an array or a string.
 for(const args of [[],'x',7]){
  await assertRejects(()=>dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_assets',arguments:args}}),dispatch()),JsonRpcError)
 }
})

Deno.test('an unimplemented method is METHOD_NOT_FOUND, not a silent empty result',async()=>{
 // Methods this server genuinely does not implement, and does not advertise.
 // resources/read used to be the example here, which was the bug: it was listed
 // in the capabilities and answered METHOD_NOT_FOUND.
 for(const method of ['resources/subscribe','logging/setLevel','completion/complete','sampling/createMessage']){
  assert(!(SUPPORTED_METHODS as readonly string[]).includes(method),`${method} must not be advertised`)
  const error=await assertRejects(
   ()=>dispatchRpc(parseRpcRequest({jsonrpc:'2.0',id:1,method}),dispatch()),
   JsonRpcError,
  )
  assertEquals(error.code,RPC.METHOD_NOT_FOUND,`${method} must be METHOD_NOT_FOUND`)
 }
})

Deno.test('parseRpcRequest refuses everything that is not one 2.0 request',()=>{
 // A batch is refused rather than half-answered: 2025-06-18 removed batching, and
 // answering one element would be a silent partial success.
 const batch=assertThrows(()=>parseRpcRequest([{jsonrpc:'2.0',id:1,method:'ping'}]),JsonRpcError)
 assertEquals((batch as JsonRpcError).code,RPC.INVALID_REQUEST)
 assert((batch as JsonRpcError).message.includes('batch'))
 for(const bad of [null,undefined,'x',7,[],{},{jsonrpc:'1.0',method:'ping'},{jsonrpc:'2.0'},{jsonrpc:'2.0',method:''},{jsonrpc:'2.0',method:'ping',id:{}},{jsonrpc:'2.0',method:'ping',id:[]}]){
  assertThrows(()=>parseRpcRequest(bad),JsonRpcError,undefined,`${JSON.stringify(bad)} must be refused`)
 }
 for(const params of [[],'x',7,null]){
  assertThrows(()=>parseRpcRequest({jsonrpc:'2.0',id:1,method:'ping',params}),JsonRpcError)
 }
 // A null id means the same as an absent one to every client that sends it.
 assert(isNotification(parseRpcRequest({jsonrpc:'2.0',id:null,method:'ping'})))
 assert(!isNotification(parseRpcRequest({jsonrpc:'2.0',id:0,method:'ping'})),'id 0 is a real id')
 assert(!isNotification(parseRpcRequest({jsonrpc:'2.0',id:'a',method:'ping'})))
})

Deno.test('the response envelopes are JSON-RPC 2.0 shaped',()=>{
 assertEquals(rpcSuccess(1,{ok:true}),{jsonrpc:'2.0',id:1,result:{ok:true}})
 // A failure with no id still carries id null, which is what the spec requires
 // when the id could not be determined.
 assertEquals(rpcFailure(undefined,RPC.PARSE_ERROR,'bad'),{jsonrpc:'2.0',id:null,error:{code:RPC.PARSE_ERROR,message:'bad'}})
 assertEquals(rpcFailure('x',RPC.INVALID_PARAMS,'bad',{field:'q'}),{jsonrpc:'2.0',id:'x',error:{code:RPC.INVALID_PARAMS,message:'bad',data:{field:'q'}}})
})

Deno.test('a tool result carries the payload as text AND as structured content',()=>{
 const result=jsonToolResult({a:1})
 assertEquals(result.content[0].type,'text')
 // The text block is the same payload serialized, because a client that ignores
 // structuredContent must still be able to read the answer.
 assertEquals(JSON.parse(result.content[0].text),{a:1})
 // Compact, not indented. The payload travels twice in one response and the
 // indentation was pure weight in a member's context window.
 assertEquals(result.content[0].text,'{"a":1}')
 assertEquals(result.structuredContent,{a:1})
 assertEquals(result.isError,undefined)
 // An array payload has no structuredContent, because that field is defined as an
 // object. The text block still carries it.
 const list=jsonToolResult([1,2])
 assertEquals(list.structuredContent,undefined)
 assertEquals(JSON.parse(list.content[0].text),[1,2])
 const refusal=errorToolResult('scope_missing','This token does not carry write:alerts.',{scope_required:'write:alerts'})
 assertEquals(refusal.isError,true)
 assertEquals(refusal.structuredContent?.error,'scope_missing')
 assertEquals(refusal.structuredContent?.scope_required,'write:alerts')
})
