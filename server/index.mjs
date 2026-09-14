import { createServer } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { createResearchService } from './governance.mjs'
if(existsSync('.env'))process.loadEnvFile('.env')
mkdirSync('.local',{recursive:true})
const port=Number(process.env.DEMO_API_PORT||8788),webPort=Number(process.env.DEMO_WEB_PORT||5187)
const rawLimit=Number(process.env.CMC_DEMO_CREDIT_LIMIT||20)
const service=createResearchService({filename:'.local/demo.sqlite',mode:process.env.CMC_MODE,key:process.env.CMC_API_KEY||'',plan:process.env.CMC_VERIFIED_PLAN||'basic',creditLimit:Number.isFinite(rawLimit)?Math.min(100,Math.max(0,rawLimit)):20})
const server=createServer(async(req,res)=>{
  const send=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))}
  if(![`127.0.0.1:${port}`,`localhost:${port}`,`127.0.0.1:${webPort}`,`localhost:${webPort}`].includes(req.headers.host))return send({error:'Invalid host'},403)
  if(req.headers.origin&&!['http://127.0.0.1:'+webPort,'http://localhost:'+webPort].includes(req.headers.origin))return send({error:'Invalid origin'},403)
  if(req.url==='/api/status'&&req.method==='GET')return send(service.state())
  if(req.url!=='/api/research'||req.method!=='POST')return send({error:'Not found'},404)
  try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)return send({error:'Request too large'},413)}const body=JSON.parse(raw);send(await service.read(body.capability,body.params||{}))}catch(e){send({error:e.message||'Invalid request'},400)}
})
server.listen(port,'127.0.0.1',()=>console.log(`Investor Intel local API: http://127.0.0.1:${port} (${service.state().mode}; keys stay server-side)`))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{service.close();process.exit()}))
