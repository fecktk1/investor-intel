// Navigation only. Forms own validation, evidence resolution and explicit submission.
export function intelSearchActions(navGroups, t, journalEnabled) {
  const allowed = new Set(navGroups.flatMap(group => group.items.map(item => item.to)))
  return [
    ...(journalEnabled ? [{ parent: '/intel/theses', to: '/intel/theses/new', key: 'thesis', label: 'Draft a thesis', keywords: 'new create start thesis journal', description: 'Open the thesis builder. Nothing is saved until you review and save.' }] : []),
    { parent: '/intel/investigate', to: '/intel/investigate', key: 'investigation', label: 'Draft an investigation', keywords: 'new create start research investigation', description: 'Choose a question and evidence. Nothing is generated until you ask.' },
    { parent: '/intel/explain', to: '/intel/explain', key: 'explanation', label: 'Draft an explanation question', keywords: 'new create start explain question', description: 'Write your question. Nothing is generated until you ask.' },
  ].filter(action => allowed.has(action.parent)).map(action => ({
    to: action.to,
    label: t(`search.action.${action.key}`, { defaultValue: action.label }),
    description: t(`search.action.${action.key}_description`, { defaultValue: action.description }),
    keywords: action.keywords,
    group: t('search.actions', { defaultValue: 'Start a draft' }),
  }))
}
