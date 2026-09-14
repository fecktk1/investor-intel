import {cmcDexIdentity} from '../market-assets/cmc-dex.ts'
import {readMarketSourceVersions,securityVersionChanges} from './market-source-versions.ts'

/** Caller must establish Intel access. This public source reader never queries
 * a private record, activates demand or contacts an upstream provider. */
export async function readSourceHistoryPage(db:any,input:any,now=Date.now()){
 const p=input||{},family=p.family,limit=p.limit??25
 if(Object.keys(p).some(k=>!['subject','family','cursor','limit'].includes(k))||!['security','rwa_relationship'].includes(family)||!Number.isInteger(limit)||limit<1||limit>25||typeof p.subject!=='string'||p.subject.length>240)throw Error('invalid_source_history_request')
 const subject=family==='security'?cmcDexIdentity(p.subject)?.subject:/^market:coinmarketcap:[1-9][0-9]{0,11}$/.test(p.subject)?p.subject:null
 if(!subject)throw Error('invalid_source_history_request')
 const history=await readMarketSourceVersions(db,subject,family,now,'display',limit,p.cursor)
 return {...history,schemaVersion:1,...(family==='security'?{comparison:securityVersionChanges(history.versions)}:{})}
}
