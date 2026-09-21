import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWatchlistSelection } from '../context/WatchlistSelection'
import { addWatchlistItem } from '../lib/watchlist-api'
import { refusalMessage } from '../lib/watchlist-refusal'
import { watchlistChartInput } from '../lib/watchlist-chart-identity'
import { Link, useLocation } from 'react-router'
export default function ChartWatchlistAdd({ context, plotRef }) {
  const location = useLocation()
  const { t } = useTranslation('intel', { useSuspense: false }), selection = useWatchlistSelection(new URLSearchParams(location.search).get('watchlist'))
  const [open, setOpen] = useState(false), [listId, setListId] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState(null)
  const dialog = useRef(null), trigger = useRef(null), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const target = plotRef?.current
    const menu = event => { if (!event.defaultPrevented && (event.type === 'contextmenu' || event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) { event.preventDefault(); setOpen(true) } }
    target?.addEventListener('contextmenu', menu); target?.addEventListener('keydown', menu)
    return () => { target?.removeEventListener('contextmenu', menu); target?.removeEventListener('keydown', menu) }
  }, [plotRef])
  useEffect(() => { if (open) { setError(null); setListId(selection.selected?.id || null); dialog.current?.showModal() } }, [open]) // selection is frozen at opening
  const close = () => { dialog.current?.close(); setOpen(false); trigger.current?.focus() }
  const add = async event => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const input = watchlistChartInput(context.asset)
      if (!input) throw Error('Choose a verified asset network in the dossier before adding this chart to a list.')
      // Which list it landed in is named back to the reader. "Default
      // watchlist" silently creates a list nobody chose, so the confirmation
      // has to say where the asset actually went and offer the way there.
      const added = await addWatchlistItem(context.supabase, context.orgId, context.userId, { ...input, listId })
      const lists = await selection.reload().catch(() => [])
      const landedId = added?.watchlist_id || listId || null
      if (alive.current) {
        setNotice({ id: landedId, name: (lists || []).find(list => list.id === landedId)?.name || null })
        close()
      }
    } catch (e) { if (alive.current) setError(refusalMessage(t, e) || e.message) } finally { if (alive.current) setBusy(false) }
  }
  if (selection.unavailable) return null
  return <><button type="button" ref={trigger} className="intel-text-link" onClick={() => setOpen(true)}>{t('watchlist.chart_add', { defaultValue: 'Add to watchlist' })}</button>{notice && <span role="status" className="text-xs">{notice.name ? t('watchlist.added_to', { list: notice.name, defaultValue: 'Added to {{list}}.' }) : t('watchlist.added', { defaultValue: 'Asset saved to the selected watchlist.' })}{notice.id && <> <Link className="intel-text-link" to={`/intel/watchlist?list=${encodeURIComponent(notice.id)}`}>{t('watchlist.open_list', { defaultValue: 'Open the list' })}</Link></>}</span>}{open && <dialog ref={dialog} className="intel-chart-study-dialog" aria-label={t('watchlist.chart_add', { defaultValue: 'Add to watchlist' })} onCancel={event => { event.preventDefault(); close() }}><form onSubmit={add} className="space-y-3"><h2>{t('watchlist.chart_add', { defaultValue: 'Add to watchlist' })}</h2><p className="text-xs break-all">{context.asset}</p><label className="block">{t('watchlist.list', { defaultValue: 'Watchlist' })}<select className="select w-full" value={listId || ''} onChange={event => setListId(event.target.value)}><option value="">{t('watchlist.default', { defaultValue: 'Default watchlist' })}</option>{selection.lists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>{(error || selection.error) && <p role="alert">{error || selection.error}</p>}<div className="flex gap-2"><button className="btn btn--primary" disabled={busy || selection.loading || !!selection.error}>{t('watchlist.add', { defaultValue: 'Add' })}</button><button type="button" className="btn btn--quiet" onClick={close}>{t('common.cancel', { defaultValue: 'Cancel' })}</button></div></form></dialog>}</>
}
