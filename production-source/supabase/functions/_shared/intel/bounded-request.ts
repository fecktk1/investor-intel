export class RequestBodyError extends Error {
 constructor(message:string,public status:number){super(message)}
}
/** Bound bytes while reading; Content-Length is only an early rejection hint. */
export async function readBoundedText(req:Pick<Request,'headers'|'body'>,maxBytes:number):Promise<string> {
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('invalid_body_limit')
 if(Number(req.headers.get('content-length')||0)>maxBytes){await req.body?.cancel().catch(()=>{});throw new RequestBodyError('request_too_large',413)}
 const reader=req.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0
 if(!reader)throw new RequestBodyError('invalid_json',400)
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel().catch(()=>{});throw new RequestBodyError('request_too_large',413)}chunks.push(value)}
 }finally{reader.releaseLock()}
 const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength}
 try{return new TextDecoder('utf-8',{fatal:true}).decode(body)}catch{throw new RequestBodyError('invalid_json',400)}
}
export async function readBoundedJson(req:Request,maxBytes:number):Promise<Record<string,unknown>> {
 const text=await readBoundedText(req,maxBytes)
 let parsed:unknown;try{parsed=JSON.parse(text)}catch{throw new RequestBodyError('invalid_json',400)}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new RequestBodyError('invalid_request',400)
 return parsed as Record<string,unknown>
}
