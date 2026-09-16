import React from 'react'

// Standalone replacement for the product's chart working-state component.
//
// This component exists to WRITE the member's chart back. It calls
// saveChartWorkingState, which invokes the 'intel-chart-workspace' edge function
// through a Supabase client, and it does nothing at all unless usableChartContext
// finds that client plus a user id, an org id and an asset. There is no pure part
// to carry: strip the saving and nothing is left. So it is refused, and the
// working-state lib adapter beside this one deliberately does not export
// usableChartContext, which keeps that identity check out of the package too.
//
// TokenChart mounts this only when it was handed a persistence context, so the
// standalone demo never renders it. Anyone who wires a context of their own does
// render it, and it says plainly that nothing is being saved.
export default function ChartWorkingState() {
 return <span className="intel-event-meta" role="status">Chart changes are not saved. Saving a chart back needs the authenticated Investor Intel workspace.</span>
}
