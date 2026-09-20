// MCP Streamable HTTP, by hand, stateless.
//
// This is the wire layer only: JSON-RPC 2.0 framing, protocol version
// negotiation, and the method table. It knows nothing about Investor Intel, who
// is calling or what a tool does, which is what makes it testable without a
// database.
//
// WHY NO SDK. The TypeScript MCP SDK is written against Node's http server and
// carries a session store, an SSE transport and a process lifecycle this surface
// has none of. An Edge Function is a single request handler with no memory
// between invocations, so the only transport that can be honest here is the
// stateless one: POST in, one JSON response out. That is about 200 lines by
// hand, against a dependency that would have to be talked out of half of what it
// does. The spec surface we implement is listed in SUPPORTED_METHODS and nothing
// else is claimed in the capabilities.
//
// STATELESS, AND THEREFORE NO SESSION. We never issue Mcp-Session-Id. Per the
// spec a client must not send one it was not given, but some do anyway, so a
// session header on the way in is ignored rather than refused: refusing it would
// break a client over a header that cannot affect the answer. There is also no
// server-initiated stream, so GET is 405 with Allow, not an empty 200 that would
// leave a client waiting for events that are never coming.

/** Newest first. The first entry is what we answer with when a client asks for
 * something we do not know, which the spec permits and which is friendlier than
 * refusing a handshake over a date. */
export const SUPPORTED_PROTOCOL_VERSIONS=['2025-06-18','2025-03-26'] as const
export const LATEST_PROTOCOL_VERSION=SUPPORTED_PROTOCOL_VERSIONS[0]

export const SERVER_INFO={name:'investor-intel',title:'TheContentForge Investor Intel',version:'1.0.0'} as const

/** JSON-RPC 2.0 reserved codes. Tool FAILURES are not errors at this layer:
 * they come back as a result with isError true, so a model reads the reason and
 * adjusts instead of seeing a transport fault. */
export const RPC={PARSE_ERROR:-32700,INVALID_REQUEST:-32600,METHOD_NOT_FOUND:-32601,INVALID_PARAMS:-32602,INTERNAL_ERROR:-32603} as const

// resources/read and prompts/get are in this list because resources/list and
// prompts/list are. A server that lists two resources and then answers
// METHOD_NOT_FOUND when one is opened is worse than a server with no resources:
// Claude Desktop and Cursor both put listed resources and prompts in front of the
// member, so an unreadable entry is a visible failure they did nothing to cause.
export const SUPPORTED_METHODS=['initialize','notifications/initialized','notifications/cancelled','ping','tools/list','tools/call','resources/list','resources/read','resources/templates/list','prompts/list','prompts/get'] as const

export interface JsonRpcRequest {
 jsonrpc:'2.0'
 /** Absent means notification. A null id on the wire is normalized to absent by
  * parseRpcRequest, so this type never carries null: an id that exists is one
  * that can be answered. */
 id?:string|number
 method:string
 params?:Record<string,unknown>
}

export interface McpToolDefinition {
 name:string
 title:string
 description:string
 inputSchema:Record<string,unknown>
}

/** What the handler needs from the surface above it. Everything here is async so
 * the wire layer never has to know whether an answer costs a query. */
export interface McpDispatch {
 listTools():McpToolDefinition[]
 callTool(name:string,args:Record<string,unknown>):Promise<McpToolResult>
 listResources():Array<Record<string,unknown>>
 /** The contents of one listed resource. Returns null for a uri that was never
  * listed, which the wire layer turns into INVALID_PARAMS naming the uri. */
 readResource(uri:string):McpResourceContents|null
 listPrompts():Array<Record<string,unknown>>
 /** One listed prompt, rendered with the arguments the client supplied. Returns
  * null for a name that was never listed. */
 getPrompt(name:string,args:Record<string,unknown>):McpPromptResult|null
 instructions:string
}

/** One resource's contents, in the shape resources/read returns them. `text` for
 * anything human or JSON readable; this server has no binary resource. */
export interface McpResourceContents {
 uri:string
 mimeType:string
 text:string
}

export interface McpPromptResult {
 description:string
 messages:Array<{role:'user'|'assistant';content:{type:'text';text:string}}>
}

export interface McpToolResult {
 content:Array<{type:'text';text:string}>
 structuredContent?:Record<string,unknown>
 isError?:boolean
}

/** A tool result carrying JSON. The text block is the same payload serialized,
 * because a client that ignores structuredContent must still be able to read the
 * answer, and every current client renders the text block.
 *
 * COMPACT, NOT PRETTY-PRINTED. The payload already travels twice in one response
 * (once as structuredContent, once as this text block), and two-space indentation
 * added roughly two thirds again on top of that: rwa_universe measured 520 KB on
 * the wire for 180 KB of data. A model reads JSON the same either way, and the
 * bytes are a member's context window. */
export function jsonToolResult(payload:unknown,isError=false):McpToolResult {
 return {
  content:[{type:'text',text:JSON.stringify(payload)}],
  ...(payload&&typeof payload==='object'&&!Array.isArray(payload)?{structuredContent:payload as Record<string,unknown>}:{}),
  ...(isError?{isError:true}:{}),
 }
}

/** A refusal the model should read and act on, not retry. */
export function errorToolResult(code:string,message:string,extra:Record<string,unknown>={}):McpToolResult {
 return jsonToolResult({error:code,message,...extra},true)
}

export class JsonRpcError extends Error {
 constructor(public readonly code:number,message:string,public readonly data?:unknown){super(message);this.name='JsonRpcError'}
}

/** Shape check before anything is dispatched. A batch is refused rather than
 * half-answered: the 2025-06-18 spec removed JSON-RPC batching, and answering
 * one element of an array would be a silent partial success. */
export function parseRpcRequest(value:unknown):JsonRpcRequest {
 if(Array.isArray(value))throw new JsonRpcError(RPC.INVALID_REQUEST,'This server does not accept JSON-RPC batches. Send one request per POST.')
 if(!value||typeof value!=='object')throw new JsonRpcError(RPC.INVALID_REQUEST,'A JSON-RPC request must be an object.')
 const raw=value as Record<string,unknown>
 if(raw.jsonrpc!=='2.0')throw new JsonRpcError(RPC.INVALID_REQUEST,'Only JSON-RPC 2.0 is supported.')
 if(typeof raw.method!=='string'||!raw.method)throw new JsonRpcError(RPC.INVALID_REQUEST,'A JSON-RPC request needs a method.')
 // An id may be a string, a number or absent. Absent means notification, and a
 // notification never gets a body back. null is treated as absent, which is what
 // every client that sends it means by it.
 const id=raw.id
 if(id!==undefined&&id!==null&&typeof id!=='string'&&typeof id!=='number'){
  throw new JsonRpcError(RPC.INVALID_REQUEST,'A JSON-RPC id must be a string or a number.')
 }
 const params=raw.params
 if(params!==undefined&&(params===null||typeof params!=='object'||Array.isArray(params))){
  throw new JsonRpcError(RPC.INVALID_PARAMS,'Params must be an object.')
 }
 return {jsonrpc:'2.0',id:id===null?undefined:id as string|number|undefined,method:raw.method,params:(params??{}) as Record<string,unknown>}
}

export function isNotification(request:JsonRpcRequest):boolean {
 return request.id===undefined
}

/** Pick the version to answer with. A client that asks for one we know gets it
 * back verbatim; anything else gets our latest, and the client decides whether
 * it can live with that. */
export function negotiateProtocolVersion(requested:unknown):string {
 return typeof requested==='string'&&(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)?requested:LATEST_PROTOCOL_VERSION
}

/**
 * Run one JSON-RPC request against a dispatch.
 *
 * Returns the result object for a request, or null for a notification. Throws
 * JsonRpcError for anything the caller should see as a protocol fault; a tool
 * that simply refused comes back as a normal result with isError.
 */
export async function dispatchRpc(request:JsonRpcRequest,dispatch:McpDispatch):Promise<Record<string,unknown>|null> {
 const params=request.params??{}
 switch(request.method){
  case 'initialize':
   return {
    protocolVersion:negotiateProtocolVersion(params.protocolVersion),
    // Only what is actually implemented. listChanged is false everywhere
    // because a stateless server cannot notify anyone of a change.
    capabilities:{tools:{listChanged:false},resources:{listChanged:false,subscribe:false},prompts:{listChanged:false}},
    serverInfo:SERVER_INFO,
    instructions:dispatch.instructions,
   }
  // Both notifications are accepted and do nothing, which is the whole
  // correct behaviour for a stateless server: there is no session to mark
  // ready and no in-flight work to cancel between invocations.
  case 'notifications/initialized':
  case 'notifications/cancelled':
   return null
  // An empty result object is the spec's pong.
  case 'ping':
   return {}
  case 'tools/list':
   return {tools:dispatch.listTools()}
  case 'resources/list':
   return {resources:dispatch.listResources()}
  case 'resources/read':{
   const uri=params.uri
   if(typeof uri!=='string'||!uri)throw new JsonRpcError(RPC.INVALID_PARAMS,'resources/read needs a uri.')
   const contents=dispatch.readResource(uri)
   // Named at INVALID_PARAMS rather than INTERNAL_ERROR: the request was well
   // formed and the server simply has no such resource, which is the client's
   // to fix by reading resources/list.
   if(!contents)throw new JsonRpcError(RPC.INVALID_PARAMS,`${uri} is not a resource this server offers. Call resources/list to see what is available.`)
   return {contents:[contents]}
  }
  case 'resources/templates/list':
   return {resourceTemplates:[]}
  case 'prompts/list':
   return {prompts:dispatch.listPrompts()}
  case 'prompts/get':{
   const name=params.name
   if(typeof name!=='string'||!name)throw new JsonRpcError(RPC.INVALID_PARAMS,'prompts/get needs a prompt name.')
   const args=params.arguments
   if(args!==undefined&&(args===null||typeof args!=='object'||Array.isArray(args))){
    throw new JsonRpcError(RPC.INVALID_PARAMS,'Prompt arguments must be an object.')
   }
   const prompt=dispatch.getPrompt(name,(args??{}) as Record<string,unknown>)
   if(!prompt)throw new JsonRpcError(RPC.INVALID_PARAMS,`${name} is not a prompt this server offers. Call prompts/list to see what is available.`)
   return prompt as unknown as Record<string,unknown>
  }
  case 'tools/call':{
   const name=params.name
   if(typeof name!=='string'||!name)throw new JsonRpcError(RPC.INVALID_PARAMS,'tools/call needs a tool name.')
   const args=params.arguments
   if(args!==undefined&&(args===null||typeof args!=='object'||Array.isArray(args))){
    throw new JsonRpcError(RPC.INVALID_PARAMS,'Tool arguments must be an object.')
   }
   // An unknown tool is a protocol fault, not a tool failure: there was no tool
   // to fail. The spec puts it at INVALID_PARAMS.
   if(!dispatch.listTools().some(tool=>tool.name===name)){
    throw new JsonRpcError(RPC.INVALID_PARAMS,`${name} is not a tool this server offers. Call tools/list to see what is available.`)
   }
   return await dispatch.callTool(name,(args??{}) as Record<string,unknown>) as unknown as Record<string,unknown>
  }
  default:
   throw new JsonRpcError(RPC.METHOD_NOT_FOUND,`${request.method} is not a method this server implements.`)
 }
}

export function rpcSuccess(id:string|number|undefined,result:Record<string,unknown>):Record<string,unknown> {
 return {jsonrpc:'2.0',id:id??null,result}
}

export function rpcFailure(id:string|number|undefined,code:number,message:string,data?:unknown):Record<string,unknown> {
 return {jsonrpc:'2.0',id:id??null,error:{code,message,...(data===undefined?{}:{data})}}
}
