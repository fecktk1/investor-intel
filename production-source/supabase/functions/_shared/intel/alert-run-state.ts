export function thesisEvidencePass(body: unknown, now: Date): { run: boolean; limit: number } {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const explicit = input.thesisEvidenceNow === true
  const requested = Number(input.thesisEvidenceLimit)
  return {
    run: explicit || (now.getUTCHours() % 6 === 0 && now.getUTCMinutes() < 15),
    limit: explicit ? Math.max(1, Math.min(50, Number.isFinite(requested) ? Math.floor(requested) : 1)) : 50,
  }
}

export function alertRunState(chartFailed: boolean, thesisFailures: number, maintenanceFailed: boolean,otherFailures=0) {
  const partial = chartFailed || thesisFailures > 0 || maintenanceFailed || otherFailures>0
  return { ok: !partial, partial, status: partial ? 503 : 200 }
}
