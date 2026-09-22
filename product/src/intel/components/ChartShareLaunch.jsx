import React from 'react'

// Standalone replacement for the product's chart Share launcher.
//
// The launcher itself is only a button, and on its own it would be pure. What it
// does is the problem: its single purpose is to load ChartSharePanel, and that
// panel is coupled the whole way down. It saves a version through
// requestChartWorkspace, which reaches the 'intel-chart-workspace' edge function
// through a Supabase client and is refused outright without one plus an org id
// and a user id, and it then manages the link's audience, expiry and revocation
// through that same service, pulling ChartShareControls, ChartShareCard and
// ChartShareImage behind it.
//
// Refusing at the launcher rather than at the panel keeps that entire flow, and
// those three components, out of the package instead of admitting them to sit
// behind a refusal. The button stays, disabled, so the chart's tool row keeps the
// shape it has in the product and the reason is on the control itself rather than
// hidden behind a press that goes nowhere.
const REASON='Sharing a chart saves a version to the Investor Intel workspace, which this standalone package does not carry.'
export default function ChartShareLaunch() {
 return <button type="button" disabled title={REASON} aria-label={`Share. ${REASON}`}>Share</button>
}
