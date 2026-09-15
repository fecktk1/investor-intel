import { isRevisionConflict } from './revision-conflict'
const blank = subject => ({ subject, id: crypto.randomUUID(), thread: null, question: '', decision: '', context: {}, title: subject, loaded: false, loading: false, dirty: false, change: 0, saving: false, error: null, entries: [], page: 0, hasMore: false, historyLoading: false, historyError: null })
const message = error => isRevisionConflict(error) ?'This thread changed in another window. Reload the saved thread before continuing; your unsaved text remains visible.' : error?.message || 'Research thread could not be saved.'

// One private store per mounted user/workspace. No prices or model responses are
// copied here. Navigation retains drafts; saved entries live in the journal DB.
export function createResearchThreadStore({ supabase: client, orgId, userId, delay = 1000 }) {
  // The provider passes a getter: a token refresh replaces the client, not the store.
  const current = () => typeof client === 'function' ? client() : client
  const supabase = { from: table => current().from(table), rpc: (name, params) => current().rpc(name, params) }
  const records = new Map(), listeners = new Set(), loads = new Map(), queues = new Map(), timers = new Map(), operations = new Map()
  let version = 0, active = true
  const get = subject => { if (!records.has(subject)) records.set(subject, blank(subject)); return records.get(subject) }
  const put = (subject, patch) => { if (!active) return; records.set(subject, { ...get(subject), ...patch }); version++; listeners.forEach(fn => fn()) }
  const load = async (subject, force = false) => {
    if (!active || !orgId || !userId) return
    if (loads.has(subject)) return loads.get(subject)
    if (get(subject).loaded && !force) return get(subject)
    put(subject, { loading: true, error: null })
    const promise = (async () => {
      try {
        const { data, error } = await supabase.from('intel_research_threads').select('*').eq('org_id', orgId).eq('user_id', userId).eq('subject', subject).maybeSingle()
        if (error) throw error
        if(data && (data.subject!==subject || data.org_id!==orgId || data.user_id!==userId)) throw Error('Thread scope could not be verified.')
        const current = get(subject), keepDraft = current.dirty && !force
        put(subject, { thread: data, id: data?.id || current.id, loaded: true, loading: false,
          ...(keepDraft ? {} : { question: data?.draft_question || '', decision: data?.draft_decision || '', context: data?.context || current.context, title: data?.title || current.title, dirty: false }) })
        return get(subject)
      } catch (error) { put(subject, { loading: false, error: message(error) }); throw error }
      finally { loads.delete(subject) }
    })()
    loads.set(subject, promise); return promise
  }
  const schedule = subject => { if (!active) return; clearTimeout(timers.get(subject)); timers.set(subject, setTimeout(() => { timers.delete(subject); void flush(subject).catch(() => {}) }, delay)) }
  const flush = (subject, closing = false) => {
    clearTimeout(timers.get(subject)); timers.delete(subject)
    const promise = (queues.get(subject) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!active && !closing) throw Error('Workspace changed before saving.')
      await load(subject)
      const snapshot = get(subject)
      if (!snapshot.loaded) throw Error('Load the research thread before saving.')
      if (!snapshot.dirty && snapshot.thread) return snapshot.thread
      if (!snapshot.question.trim() && !snapshot.decision.trim() && !snapshot.thread) return null
      put(subject, { saving: true, error: null })
      try {
        const { data, error } = await supabase.rpc('intel_save_research_thread', {
          p_org_id: orgId, p_expected_user: userId, p_id: snapshot.id, p_revision: snapshot.thread?.revision || 0,
          p_subject: subject, p_title: snapshot.title.slice(0, 160), p_question: snapshot.question,
          p_decision: snapshot.decision, p_context: snapshot.context,
        })
        if (error) throw error
        if (!data?.id || !data.revision) throw Error('Thread save was not confirmed.')
        const dirty = get(subject).change !== snapshot.change
        put(subject, { thread: data, id: data.id, dirty, saving: false })
        if (dirty) schedule(subject)
        return data
      } catch (error) { put(subject, { saving: false, error: message(error) }); throw error }
    })
    queues.set(subject, promise); return promise
  }
  const edit = (subject, patch, save = true) => {
    const current = get(subject), next = typeof patch === 'function' ? patch(current) : patch
    put(subject, { ...next, change: current.change + 1, dirty: save || current.dirty })
    if (save) schedule(subject)
  }
  const history = async (subject, more = false) => {
    await load(subject)
    const record = get(subject); if (!record.thread || record.historyLoading) return
    const page = more ? record.page + 1 : 0
    put(subject, { historyLoading: true, historyError: null })
    try {
      const { data, error } = await supabase.from('intel_research_thread_entries').select('*').eq('thread_id', record.thread.id).eq('org_id', orgId).eq('user_id', userId).order('recorded_at', { ascending: false }).order('id', { ascending: false }).range(page * 25, page * 25 + 25)
      if (error) throw error
      if (!Array.isArray(data)) throw Error('Thread entries could not be read.')
      // A bounded page, rather than an ever-growing private history in memory.
      put(subject, { entries: data.slice(0, 25), page, hasMore: data.length > 25, historyLoading: false })
    } catch (error) { put(subject, { historyLoading: false, historyError: message(error) }); throw error }
  }
  const append = async (subject, action = 'note', receipt = null) => {
    const thread = await flush(subject)
    if (!thread || !thread.draft_question.trim()) throw Error('Write a question before recording the thread.')
    const signature = JSON.stringify([thread.id, action, thread.draft_question, thread.draft_decision, thread.context, receipt?.id, receipt?.fingerprint])
    if (!operations.has(signature)) operations.set(signature, crypto.randomUUID())
    const { data, error } = await supabase.rpc('intel_append_research_thread', {
      p_org_id: orgId, p_expected_user: userId, p_thread_id: thread.id, p_operation: operations.get(signature), p_action: action,
      p_question: thread.draft_question, p_decision: thread.draft_decision, p_context: thread.context,
      p_saved_id: receipt?.id || null, p_evidence_version: receipt?.fingerprint || null,
    })
    if (error) { put(subject, { error: message(error) }); throw error }
    if (!data?.id) throw Error('Thread entry was not confirmed.')
    await history(subject); return data
  }
  const remove = async subject => {
    clearTimeout(timers.get(subject)); timers.delete(subject)
    await queues.get(subject)?.catch(() => {})
    const record = get(subject)
    if (record.thread) {
      const { data, error } = await supabase.from('intel_research_threads').delete().eq('org_id', orgId).eq('user_id', userId).eq('id', record.thread.id).eq('revision', record.thread.revision).select('id').maybeSingle()
      if (error) throw error
      if (!data) throw Error('This thread changed before deletion. Reload it first.')
    }
    put(subject, { ...blank(subject), loaded: true }); operations.clear()
  }
  return { get, load, edit, flush, append, history, remove, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, snapshot: () => version,
    activate: () => { active = true }, dispose: () => {
      // A draft still waiting for its debounce is saved, not dropped.
      const pending = [...timers.keys()]; timers.forEach(clearTimeout); timers.clear()
      pending.forEach(subject => void flush(subject, true).catch(() => {})); active = false
    } }
}
