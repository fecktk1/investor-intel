import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { createWatchlist, changeWatchlist, deleteWatchlist } from '../lib/watchlist-api'

export default function WatchlistManager({ state, onSelect }) {
  const { t } = useTranslation('intel', { useSuspense: false }), { org, role } = useProfile(), { supabase, user } = useSupabase()
  const [mode, setMode] = useState(null), [name, setName] = useState(''), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const editable = ['owner', 'admin', 'editor'].includes(role)
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      if (mode === 'delete') { await deleteWatchlist(supabase, org.id, state.selected); await state.reload(); await onSelect('') }
      else { const list = mode === 'create' ? await createWatchlist(supabase, org.id, user.id, name) : await changeWatchlist(supabase, org.id, state.selected, name); await state.reload(); await onSelect(list.id) }
      setMode(null); setName('')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <section className="intel-watchlist-manager border-y border-[var(--border-default)] py-3 space-y-3" aria-label={t('watchlist.manage', { defaultValue: 'Named watchlists' })}>
    <div className="flex flex-wrap gap-3 items-center"><label className="flex items-center gap-2"><span>{t('watchlist.list', { defaultValue: 'Watchlist' })}</span><select className="select" disabled={state.loading || busy} value={state.selected?.id || ''} onChange={event => { setMode(null); Promise.resolve(onSelect(event.target.value)).catch(e => setError(e.message)) }}><option value="" disabled>{t('watchlist.choose', { defaultValue: 'Choose a watchlist' })}</option>{state.lists.map(list => <option key={list.id} value={list.id}>{list.name}{list.is_default ? ' · Default' : ''}</option>)}</select></label>
      {editable && <><button className="btn btn--quiet btn--sm" disabled={busy || state.loading} onClick={() => { setMode('create'); setName(''); setError(null) }}>{t('watchlist.new', { defaultValue: 'New list' })}</button>{state.selected && <><button className="btn btn--quiet btn--sm" onClick={() => { setMode('rename'); setName(state.selected.name); setError(null) }}>{t('watchlist.rename', { defaultValue: 'Rename' })}</button>{!state.selected.is_default && <button className="btn btn--quiet btn--sm" onClick={() => { setMode('delete'); setError(null) }}>{t('watchlist.delete_list', { defaultValue: 'Delete list' })}</button>}</>}</>}
      <button className="btn btn--quiet btn--sm" disabled={busy || state.loading} onClick={() => state.reload().catch(e => setError(e.message))}>{t('common.reload', { defaultValue: 'Reload' })}</button>
    </div>
    <p className="text-xs text-[var(--fg-4)]">{t('watchlist.sharing_order', { defaultValue: 'List contents are shared with authorized workspace members. Your selected list is personal. Pins appear first; arrows set order within each group. Manual order stays fixed when prices change.' })}</p>
    {mode && <form onSubmit={submit} className="flex flex-wrap items-center gap-3">{mode === 'delete' ? <p>{t('watchlist.delete_confirm', { defaultValue: 'Delete this list and its watchlist entries? Portfolio transactions and research are retained.' })}</p> : <label><span className="sr-only">{t('watchlist.list_name', { defaultValue: 'List name' })}</span><input autoFocus className="input" value={name} maxLength={120} onChange={e => setName(e.target.value)}/></label>}<button className="btn btn--primary btn--sm" disabled={busy || mode !== 'delete' && !name.trim()}>{mode === 'delete' ? t('watchlist.confirm_delete', { defaultValue: 'Confirm delete' }) : t('common.save', { defaultValue: 'Save' })}</button><button type="button" className="btn btn--quiet btn--sm" onClick={() => setMode(null)}>{t('common.cancel', { defaultValue: 'Cancel' })}</button></form>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
  </section>
}
