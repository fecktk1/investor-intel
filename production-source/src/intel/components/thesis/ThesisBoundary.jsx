import React from 'react'

// Contains any Thesis Journal render error so an embedded module (market page,
// portfolio page) never takes down the host page. Fails closed: renders nothing.
export default class ThesisBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err) { try { console.warn('[thesis] module error contained:', err?.message) } catch { /* noop */ } }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children }
}
