import {createClient} from 'npm:@supabase/supabase-js@2'
import {runAlertDeliveries} from '../_shared/intel/alert-delivery.ts'
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})
export async function handleDelivery(req:Request) {
 if(req.method!=='POST')return json({error:'method_not_allowed'},405)
 const secret=Deno.env.get('CRON_SECRET')
 if(!secret||req.headers.get('x-cron-secret')!==secret)return json({error:'unauthorized'},401)
 // Separate owner-approved rollout. No flag, cron, or external opt-in is set by deployment.
 if(Deno.env.get('INTEL_ALERT_DELIVERY_ENABLED')!=='true')return json({enabled:false,claimed:0,accepted:0})
 try{return json(await runAlertDeliveries(createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),{enabled:true,token:Deno.env.get('INVESTOR_TELEGRAM_BOT_TOKEN')||Deno.env.get('TELEGRAM_INVESTOR_BOT_TOKEN')||''}))}
 catch{return json({error:'alert_delivery_unavailable'},503)}
}
if(import.meta.main)Deno.serve(handleDelivery)
