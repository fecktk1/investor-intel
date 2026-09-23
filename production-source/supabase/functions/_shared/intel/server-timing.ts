// Investor Intel: where a public read spends its time, as a Server-Timing header.
//
// The two public demo endpoints (intel-rwa-lookup, intel-demo-read) answer a
// visitor with no account, so the only way to see why one answer took 15 seconds
// is to have the answer say so. Each named phase is timed once and the finished
// list goes out as a standard Server-Timing header, which a browser exposes to
// the page through PerformanceResourceTiming.serverTiming when the response also
// carries Timing-Allow-Origin. No figure, parameter or identity is ever put in a
// phase name: they are fixed words chosen by the code.

export interface PhaseTimer {
  /** Time one phase. Phases may overlap; each keeps its own duration. */
  time<T>(name: string, run: () => Promise<T>): Promise<T>
  /** Record a phase measured elsewhere. */
  note(name: string, ms: number): void
  /** The Server-Timing header value, ending with `total`. */
  header(): string
  /** The phases so far, for tests and logs. */
  phases(): ReadonlyArray<readonly [string, number]>
}

const NAME = /^[a-z][a-z0-9_]{0,39}$/

export function phaseTimer(now: () => number = () => performance.now()): PhaseTimer {
  const started = now()
  const list: [string, number][] = []
  const push = (name: string, ms: number) => {
    if (!NAME.test(name) || !Number.isFinite(ms)) return
    if (list.length < 24) list.push([name, Math.max(0, Math.round(ms))])
  }
  return {
    async time(name, run) {
      const at = now()
      try { return await run() } finally { push(name, now() - at) }
    },
    note: push,
    header() {
      return [...list.map(([name, ms]) => `${name};dur=${ms}`), `total;dur=${Math.max(0, Math.round(now() - started))}`].join(', ')
    },
    phases: () => list.slice(),
  }
}

/** The headers that let a page on another origin read the timing. */
export const TIMING_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Timing-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Server-Timing',
})

/** A no-op timer, for callers that do not measure. */
export const NO_TIMER: PhaseTimer = {
  time: (_name, run) => run(),
  note: () => {},
  header: () => '',
  phases: () => [],
}
