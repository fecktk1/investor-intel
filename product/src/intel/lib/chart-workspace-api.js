import {validateChartLayout} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
const messages={chart_layout_not_found:'This saved layout is unavailable or belongs to another workspace. Open your layout library to choose another.',invalid_chart_id:'This saved layout link is invalid. Open your layout library to choose another.',chart_capture_expired_or_invalid:'The verified price capture expired. Refresh the asset chart and create a new preview.',chart_capture_series_changed:'The price series changed after capture. Refresh the chart before saving.',chart_capture_asset_mismatch:'The price capture belongs to another asset. Refresh this asset before saving.',chart_snapshot_export_unavailable:'This source does not currently permit snapshot export.',chart_snapshot_not_found:'This snapshot is unavailable or you no longer have access.',chart_snapshot_deleted:'This snapshot was deleted. A retry cannot restore its private content.',chart_layout_deleted:'This layout was deleted. Start a new layout to save a new copy.',chart_snapshot_limit:'You have reached 200 saved snapshots. Delete an unneeded snapshot before saving another.'}
Object.assign(messages,{chart_share_source_unavailable:'Sharing is not currently enabled for this price source. You can keep an owner-only link.',chart_share_unavailable:'This link is unavailable or has been revoked. Create a new link from your snapshot.',chart_share_limit:'You have reached 250 active links. Revoke an unneeded link first.',chart_share_storage_unavailable:'Chart sharing is unavailable. Retry when the service is ready.'})
Object.assign(messages,{chart_alert_revision_conflict: "This condition changed in another tab. Reload Alerts before editing it again.",chart_alert_deleted: "This condition was deleted. A delayed retry cannot restore it.",chart_alert_not_found: "This condition is unavailable or you no longer have access.",chart_alert_limit: "You have reached 100 chart conditions. Delete an unneeded condition before saving another.",chart_alert_storage_unavailable: "Chart conditions are unavailable. Retry when the service is ready."})
export async function requestChartWorkspace(context,body) {
 Object.assign(messages,{chart_alert_operation_changed:'This retry contains different changes. Reload the rule before saving.',chart_alert_general_invalid:'Check the rule type, revision and cooldown.',chart_alert_general_text_invalid:'Check the alert name and private note.',chart_alert_general_threshold_invalid:'Enter a valid threshold. Zero is supported.',chart_alert_general_identity_invalid:'Select a verified asset, wallet or narrative in this workspace.'})
 if(!context?.supabase||!context.orgId||!context.userId)throw new Error('Sign in to save chart layouts.')
 const {data,error}=await context.supabase.functions.invoke('intel-chart-workspace',{body:{...body,orgId:context.orgId}})
 if(error){
  const details=await error.context?.json?.().catch(()=>null)
  if(details?.error==='chart_revision_conflict')throw new Error('This layout changed in another tab. Open the latest version before saving.')
  if(messages[details?.error])throw new Error(messages[details.error])
  throw new Error('Chart layouts are unavailable. Retry when the service is ready.')
 }
 if(data?.error)throw new Error(messages[data.error]||data.error)
 return data
}
export async function saveChartLayout(context,{id=null,revision=0,operationId,title,layout}) {
 return requestChartWorkspace(context,{operation:'save',id,revision,operationId,title,layout:validateChartLayout(layout)})
}
