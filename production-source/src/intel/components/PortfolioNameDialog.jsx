import React, { useEffect, useRef, useState } from 'react'

export default function PortfolioNameDialog({ initialName = '', renaming = false, onSave, onClose, t }) {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const dialog = useRef(null), mounted = useRef(true)
  useEffect(() => { mounted.current = true; dialog.current?.showModal(); return () => { mounted.current = false } }, [])
  const save = async event => {
    event.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true); setError(null)
    try { await onSave(name.trim()); if (mounted.current) onClose() }
    catch (e) { if (mounted.current) setError(e.message) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <dialog ref={dialog} className="intel-chart-study-dialog" aria-labelledby="portfolio-name-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={save}>
      <div className="intel-investigation-analysis-heading"><h2 id="portfolio-name-title">{renaming ? t('portfolio.rename', { defaultValue: 'Rename portfolio' }) : t('portfolio.create', { defaultValue: 'Create portfolio' })}</h2><button type="button" disabled={busy} onClick={onClose}>{t('common.close', { defaultValue: 'Close' })}</button></div>
      <label className="intel-research-field">{t('portfolio.name', { defaultValue: 'Portfolio name' })}<input autoFocus required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>{busy ? t('common.saving', { defaultValue: 'Saving…' }) : renaming ? t('common.save_changes', { defaultValue: 'Save changes' }) : t('portfolio.create', { defaultValue: 'Create portfolio' })}</button>
    </form>
  </dialog>
}
