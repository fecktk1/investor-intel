import {loadCmcOperatingSettings,cmcPolicyEnvironment} from '../_shared/market-assets/cmc-operating-settings.ts'
import {createClient} from 'npm:@supabase/supabase-js@2'
import {validateUserJwt} from '../_shared/internal-auth.ts'
import {resolveChartShare} from '../_shared/intel/chart-share-service.ts'
import {chartReviewService} from '../_shared/intel/chart-review-service.ts'
import {chartLinkPreview} from '../_shared/intel/chart-link-preview.ts'
import {readBoundedJson,RequestBodyError} from '../_shared/intel/bounded-request.ts'
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'private, no-store','X-Robots-Tag':'noindex, noarchive','Referrer-Policy':'no-referrer'}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers})
export async function handleChartShare(req:Request){
 if(req.method==='OPTIONS')return new Response('ok',{headers})
 if(req.method!=='POST')return json({error:'method_not_allowed'},405)
 try{
  const body=await readBoundedJson(req,16000)
  const viewer=await validateUserJwt(req,createClient)
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const sourceEnv=cmcPolicyEnvironment(await loadCmcOperatingSettings(db),key=>Deno.env.get(key))
  if(body.operation==='link_preview')return json(await chartLinkPreview(db,body.token,sourceEnv))
  if(String(body.operation).startsWith('review_'))return json(await chartReviewService(db,viewer,body,sourceEnv))
  return json(await resolveChartShare(db,body.token,viewer,sourceEnv))
 }catch(error){
  if(error instanceof RequestBodyError)return json({error:error.message},error.status)
  if(error instanceof Error&&error.message.startsWith('chart_review_'))return json({error:error.message},error.message.includes('storage')?503:error.message.includes('revision')||error.message.includes('deleted')?409:error.message.includes('invalid')||error.message.includes('anchor')?400:404)
  return json({error:'chart_share_unavailable'},error instanceof Error&&error.message.includes('storage')?503:404)
 }
}
if(import.meta.main)Deno.serve(handleChartShare)
