import React from 'react'

// Code-only deferral for panels that are not a route's first content.
//
// Only code moves. Each panel keeps its own data scope, its own reads and its
// own account/organization checks; nothing is shared through this wrapper but
// the props the route already passed. The point is the route's static import
// graph: a statically imported panel puts its whole dependency closure (the
// shared chart kit, the comparison renderer, the artifact reader) in front of
// the route's first authorized read, even when the panel itself is below the
// fold or renders nothing until a generation returns.
//
// A failed code load never blanks the route. The boundary says what could not
// be opened and offers a reload, the same contract as the deferred venue
// workspace, so a chunk that 404s after a deploy degrades to one named section
// instead of an empty page. Callers that reserve height pass a fallback of the
// panel's own loading shape so deferral does not buy bytes with layout shift.
function PanelFailure({ label }) {
  return <section className="intel-open-section">
    <p role="alert">{label ? `${label} could not be opened. Reload this page to retry.` : 'This section could not be opened. Reload this page to retry.'}</p>
    <button type="button" className="btn btn--ghost" onClick={() => window.location.reload()}>Reload page</button>
  </section>
}

class PanelBoundary extends React.Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <PanelFailure label={this.props.label} /> : this.props.children }
}

export function deferredPanel(load, { label = null, fallback = () => null } = {}) {
  const Panel = React.lazy(load)
  return function DeferredPanel(props) {
    return <PanelBoundary label={label}>
      <React.Suspense fallback={fallback(props)}><Panel {...props} /></React.Suspense>
    </PanelBoundary>
  }
}

export default deferredPanel
