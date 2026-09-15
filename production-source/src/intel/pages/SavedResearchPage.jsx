import ResearchProperties from '../components/ResearchProperties'
import {savedCohortPath} from '../lib/cohort-evidence'

import React, { useEffect, useState, useCallback, useRef } from 'react'

import { useTranslation } from 'react-i18next'

import { Link, useSearchParams } from 'react-router'

import ResearchThreadLibrary from '../components/ResearchThreadLibrary'

import { Bookmark, Trash2 } from 'lucide-react'

import { useProfile } from '../../lib/profile-context'

import { useSupabase } from '../../lib/useSupabase'

import { listSavedResearch, deleteSavedResearch, getSavedResearch } from '../lib/intel-data'

import { EvidenceRecord } from '../components/ResearchEvidence'

import ArtifactView from '../components/ArtifactView'

import { ReceiptView } from '../components/InvestigationLenses'

import { useScreenParams } from '../lib/useScreenParams'

import IntelDisclaimer from '../components/IntelDisclaimer'



const readable = value => String(value || 'Note').replaceAll('_', ' ')

const dateLabel = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'Date unavailable' }



function ResearchReader({ state, onClose, onRetry, onPropertiesSaved, t }) {

  const pane = useRef(null)

  useEffect(() => { const previous = document.activeElement, dialog = pane.current; dialog?.showModal(); return () => { dialog?.close(); if (previous?.isConnected) previous.focus?.() } }, [])

  const detail = state.row

  return <dialog className="intel-investigation intel-saved-reader" ref={pane} aria-label="Saved research reader" onCancel={e => { e.preventDefault(); onClose() }}>

    <header className="intel-saved-reader-heading"><div><p className="eyebrow">Saved research</p><h2>{detail?.title || state.title || 'Research'}</h2>{detail && <p className="intel-event-meta"><time dateTime={detail.created_at}>{dateLabel(detail.created_at)}</time> · {detail.private_owner_id ? 'Private · only you' : 'Shared in this workspace'}</p>}</div><button className="btn btn--quiet" onClick={onClose}>{t('common.close', { defaultValue: 'Close' })}</button></header>

    {detail && <ResearchProperties key={detail.id} record={detail} onSaved={onPropertiesSaved}/>}
    {savedCohortPath(detail?.snapshot?.workspace_path)&&<Link className="intel-text-link" to={savedCohortPath(detail.snapshot.workspace_path)}>Reopen original discovery cohort</Link>}

    {state.loading ? <p role="status">Opening your saved research…</p> : state.error ? <p role="alert">{state.error} <button className="intel-text-link" onClick={onRetry}>Retry</button></p> : detail?.chart_snapshot_id ? <Link className="intel-text-link" to={`/intel/chart-snapshots/${detail.chart_snapshot_id}`}>Open immutable chart snapshot</Link> : detail?.investigation_receipt ? <ReceiptView receipt={detail.investigation_receipt}/> : detail?.artifact ? <ArtifactView result={{ artifact: detail.artifact, cached: true }} alreadySaved/> : detail ? <EvidenceRecord record={detail.snapshot}/> : null}

  </dialog>

}



export default function SavedResearchPage() {

  const { t } = useTranslation('intel', { useSuspense: false })

  const { org } = useProfile(), { supabase, user } = useSupabase()

  const [search, setSearch] = useSearchParams()

  const requestedId = search.get('research_id')

  const readerOwner = useRef(`${user?.id}:${org?.id}`)

  const [params, setParams] = useScreenParams('research_', { page: 0 })

  const scope = `${user?.id || ''}:${org?.id || ''}:${params.page}`

  const active = useRef(scope); active.current = scope

  const generation = useRef(0), detailGeneration = useRef(0), deleting = useRef(null)

  const [state, setState] = useState({ scope: null, rows: [], loading: true, error: null })

  const [reader, setReader] = useState(null), [deletingId, setDeletingId] = useState(null)

  const current = state.scope === scope ? state : { rows: [], loading: true, error: null }

  const detail = reader?.scope === scope ? reader : null

  const load = useCallback(async () => {

    if (!org?.id || !user?.id) return

    const operation = ++generation.current

    setState({ scope, rows: [], loading: true, error: null })

    try { const rows = await listSavedResearch(supabase, org.id, { page: params.page }); if (operation === generation.current && active.current === scope) setState({ scope, rows, loading: false, error: null }) }

    catch (e) { if (operation === generation.current && active.current === scope) setState({ scope, rows: [], loading: false, error: e.message }) }

  }, [org?.id, user?.id, supabase, params.page, scope])

  useEffect(() => { setReader(null); setDeletingId(null); load(); return () => { generation.current++; detailGeneration.current++ } }, [load])

  const open = useCallback(async (id, title) => {

    if (!org?.id || !user?.id) return

    const operation = ++detailGeneration.current

    setReader({ scope, id, title, loading: true, row: null })

    try { const row = await getSavedResearch(supabase, org.id, id); if (active.current === scope && operation === detailGeneration.current) setReader({ scope, id, title, loading: false, row }) }

    catch (e) { if (active.current === scope && operation === detailGeneration.current) setReader({ scope, id, title, loading: false, error: e.message }) }

  }

  , [supabase, org?.id, user?.id, scope])

  useEffect(() => { const owner=`${user?.id}:${org?.id}`; if(readerOwner.current!==owner){readerOwner.current=owner;detailGeneration.current++;setReader(null);setSearch(previous=>{const next=new URLSearchParams(previous);next.delete('research_id');return next},{replace:true});return} if (requestedId) void open(requestedId); }, [requestedId, open])

  const close = () => { detailGeneration.current++; setReader(null); setSearch(previous => { const next=new URLSearchParams(previous);next.delete('research_id');return next }, {replace:true}) }

  const remove = async id => {

    if (deleting.current) return

    deleting.current = id; setDeletingId(id)

    try { await deleteSavedResearch(supabase, id); if (active.current === scope) await load() }

    catch (e) { if (active.current === scope) setState(s => ({ ...s, error: e.message })) }

    finally { deleting.current = null; if (active.current === scope) setDeletingId(null) }

  }

  return <div className="space-y-5">

    <div><div className="eyebrow flex items-center gap-1.5"><Bookmark className="h-3.5 w-3.5"/>{t('brand.name', { defaultValue: 'Investor Intel' })}</div><h1 className="page-title">{t('nav.research', { defaultValue: 'Saved Research' })}</h1><p className="page-sub">{t('pages.research_sub', { defaultValue: 'Your saved breakdowns, briefs, comparisons and explanations.' })}</p></div>

    <ResearchThreadLibrary key={`${user?.id}:${org?.id}`}/>

    <section className="intel-saved-list-region" aria-label="Saved research records">
    {current.loading ? <p role="status">Loading saved research…</p> : current.rows.length === 0 && !current.error ? <p className="text-sm text-[var(--fg-3)]">{t('research.empty', { defaultValue: 'No saved research yet. Save a breakdown or brief to keep it here.' })}</p> : current.rows.length > 0 ? <div className="intel-table-scroll intel-saved-index"><table aria-label="Saved research"><thead><tr><th scope="col">Research</th><th scope="col">Saved</th><th scope="col">Type / access</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{current.rows.map(r => {

      const a = r.artifact || {}, title = r.title || a.title || 'Untitled research'

      return <tr key={r.id}><th scope="row"><button className="intel-saved-title" onClick={() => setSearch(previous => {const next=new URLSearchParams(previous);next.set('research_id',r.id);return next})}>{r.properties?.[0]?.label || title}</button>{r.properties?.[0]?.label && <p className="text-xs">Original: {title}</p>}{r.properties?.[0] && <p className="text-xs text-[var(--fg-4)]">{r.properties[0].workflow_state} · {r.properties[0].tags?.join(', ')}</p>}{r.snapshot?.summary && <p className="intel-saved-excerpt">{r.snapshot.summary}</p>}</th><td><time dateTime={r.created_at} title={r.created_at}>{dateLabel(r.created_at)}</time></td><td><span className="intel-saved-kind">{readable(a.artifact_type || r.tags?.[0])}</span><small>{r.private_owner_id ? 'Private · only you' : 'Shared in this workspace'}</small>{a.confidence && <small>{readable(a.confidence)} confidence</small>}</td><td><button className="intel-saved-delete" aria-label={`${t('research.delete', { defaultValue: 'Delete saved research' })}: ${title}`} disabled={!!deletingId} onClick={() => remove(r.id)}><Trash2 className="h-4 w-4"/></button></td></tr>

    })}</tbody></table></div> : null}

    {current.error && <p role="alert">{current.error} <button className="intel-text-link" onClick={load}>Retry</button></p>}

    </section>
    <nav aria-label="Research pages" className="flex justify-between items-center text-xs"><button className="btn btn--quiet" disabled={current.loading || params.page === 0} onClick={() => setParams({ page: params.page - 1 })}>{t('markets.prev', { defaultValue: 'Previous' })}</button><span>Page {params.page + 1}</span><button className="btn btn--quiet" disabled={current.loading || current.rows.length < 30} onClick={() => setParams({ page: params.page + 1 })}>{t('markets.next', { defaultValue: 'Next' })}</button></nav>

    {detail && <ResearchReader state={detail} onClose={close} onPropertiesSaved={properties => {setState(previous => previous.scope===scope ? {...previous, rows:previous.rows.map(row=>row.id===detail.id?{...row,properties:[properties]}:row)} : previous);setReader(previous=>previous?.scope===scope?{...previous,row:{...previous.row,properties:[properties]}}:previous)}} onRetry={() => open(detail.id, detail.title)} t={t}/>}

    <IntelDisclaimer variant="block"/>

  </div>

}

