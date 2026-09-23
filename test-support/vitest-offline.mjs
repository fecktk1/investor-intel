// Offline guard for the published Vitest run (test-support/vitest.config.mjs).
//
// The Intel frontend tests hand the code under test their own fake network: a
// Supabase client whose fetch is the demo fetch over an in-memory snapshot. A
// test that reaches the real network is therefore a defect, so the network
// globals fail the test instead. As with the stand-ins, the throw is also
// raised again on the next microtask, so code that catches it and falls back
// quietly still fails the run. A test that swaps in its own fetch (vi.stubGlobal)
// is unaffected.

function refuse(what) {
  const error = new Error(`OFFLINE: a published test reached the network (${what}). The public test run is offline.`)
  queueMicrotask(() => { throw error })
  throw error
}

globalThis.fetch = function fetch(input) {
  return refuse(`fetch ${typeof input === 'string' ? input : input?.url ?? String(input)}`)
}
for (const name of ['WebSocket', 'XMLHttpRequest', 'EventSource']) {
  if (name in globalThis) globalThis[name] = class { constructor(url) { refuse(`${name} ${url ?? ''}`) } }
}
