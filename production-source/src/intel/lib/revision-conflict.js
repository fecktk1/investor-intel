// A stale revision is reported as PT409 (HTTP 409). 40001 is still accepted for a
// database without the 2026-09-14 migration, where PostgREST retried it instead.
export const isRevisionConflict = error => error?.code === 'PT409' || error?.code === '40001'
