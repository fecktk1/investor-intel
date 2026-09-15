import React from 'react'

function VenueLoading({failed = false}) {
  return <section id="asset-venue-evidence" className="intel-open-section">
    <h2>Venues &amp; positioning</h2>
    <p role={failed ? 'alert' : 'status'}>{failed ? 'Venue research could not be opened. Reload this page to retry.' : 'Loading venue evidence…'}</p>
    {failed && <button className="btn btn--ghost" onClick={() => window.location.reload()}>Reload page</button>}
  </section>
}
class VenueBoundary extends React.Component {
  state = {failed: false}
  static getDerivedStateFromError() {return {failed: true}}
  render() {return this.state.failed ? <VenueLoading failed /> : this.props.children}
}

// The full venue UI remains automatic, but its code is off the first asset-read
// path. Only code is shared; the workspace still scopes its own data by user,
// organization and canonical asset. A failed code load leaves the chart usable.
export function createDeferredVenue(load) {
  const Workspace = React.lazy(load)
  return function DeferredAssetVenueWorkspace(props) {
    return <VenueBoundary key={props.canonicalKey}><React.Suspense fallback={<VenueLoading />}><Workspace {...props}/></React.Suspense></VenueBoundary>
  }
}
export default createDeferredVenue(() => import('./AssetVenueWorkspace'))
