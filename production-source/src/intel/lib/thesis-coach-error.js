// What the thesis builder shows when the AI coach did not return a draft.
//
// The coach refuses a draft whose figures could not be matched to the evidence
// it was given, even after one regeneration (intel-thesis returns
// `coach_figure_ungrounded` with the figures it could not ground). That is a
// deliberate refusal, not a failure, so it is explained in the reader's language
// with the same words the artifact view uses for a withheld generated artifact,
// rather than as the raw error code. Any other error keeps its own message.

export const COACH_GROUNDING_REFUSED = 'coach_figure_ungrounded'

/** `{ title, body }` for a coach error: an Error from invokeThesis (carrying
 *  `code` and `ungrounded`), a plain code string, or a message string. */
export function coachErrorText(t, error) {
  if (!error) return null
  const code = typeof error === 'string' ? error : error.code || error.message
  if (code === COACH_GROUNDING_REFUSED) {
    const figures = (Array.isArray(error?.ungrounded) ? error.ungrounded : []).map(String).filter(Boolean)
    return {
      title: t('artifact.blocked_title', { defaultValue: 'Output withheld' }),
      body: t('artifact.grounding_blocked_body', {
        figures: figures.join('; ') || '-',
        defaultValue: 'A figure in this response could not be matched to the evidence it was generated from, even after one regeneration, so the response was withheld. Figures that could not be grounded: {{figures}}.',
      }),
      refused: true,
    }
  }
  return { title: null, body: typeof error === 'string' ? error : error.message || String(error), refused: false }
}
