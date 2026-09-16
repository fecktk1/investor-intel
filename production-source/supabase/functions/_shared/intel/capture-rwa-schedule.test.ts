import { strict as assert } from 'node:assert'
import { RWA_ISSUER_CAPTURE_SCHEDULE } from './capture-rwa-issuer.ts'
import { RWA_YIELD_CAPTURE_SCHEDULE } from './capture-rwa-yield.ts'

// The read views tell a reader WHEN an empty RWA panel will fill, from the
// constants above. The schedule itself lives in a migration. These tests read
// the migration so the two can never silently disagree, and so the job keeps
// authenticating exactly like every other intel-capture job.

const MIGRATION = new URL('../../../migrations/20260916202000_intel_rwa_capture_cron.sql', import.meta.url)
const INDEX = new URL('../../intel-capture/index.ts', import.meta.url)
const sql = await Deno.readTextFile(MIGRATION)

const scheduled = new Map(
  [...sql.matchAll(/SELECT cron\.schedule\('([^']+)', '([^']+)', \$\$([\s\S]*?)\$\$\);/g)]
    .map((m) => [m[1], { cron: m[2], body: m[3] }]),
)

const lanes = { ...RWA_ISSUER_CAPTURE_SCHEDULE, ...RWA_YIELD_CAPTURE_SCHEDULE }

Deno.test('every rwa lane the read views describe is scheduled by the migration at the stated time', () => {
  assert.equal(scheduled.size, 3)
  for (const [op, lane] of Object.entries(lanes)) {
    const job = scheduled.get(lane.job)
    assert.ok(job, `${lane.job} is not scheduled`)
    assert.equal(job.cron, lane.cron, `${lane.job} schedule drifted`)
    assert.match(job.body, new RegExp(`jsonb_build_object\\('op','${op}'\\)`))
  }
})

Deno.test('the schedule is idempotent and authenticates from vault like the existing capture jobs', () => {
  for (const [name, job] of scheduled) {
    assert.ok(sql.includes(`SELECT cron.unschedule('${name}') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${name}');`), `${name} is not unscheduled first`)
    for (const secret of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET']) {
      assert.ok(job.body.includes(`(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${secret}')`), `${name} does not read ${secret} from vault`)
    }
    assert.match(job.body, /'x-cron-secret'/)
    assert.match(job.body, /timeout_milliseconds := 110000/)
  }
  // No literal credential: no JWT and no bearer token outside a vault read.
  assert.doesNotMatch(sql, /eyJ[A-Za-z0-9_-]{10,}/)
  assert.doesNotMatch(sql, /Bearer [A-Za-z0-9]/)
})

Deno.test('every scheduled op is registered in intel-capture, so a tick never answers unsupported_op', async () => {
  const index = await Deno.readTextFile(INDEX)
  assert.match(index, /\.\.\.RWA_YIELD_CAPTURE_OPS/)
  assert.match(index, /\.\.\.RWA_ISSUER_CAPTURE_OPS/)
  const { RWA_YIELD_CAPTURE_OPS } = await import('./capture-rwa-yield.ts')
  const { RWA_ISSUER_CAPTURE_OPS } = await import('./capture-rwa-issuer.ts')
  for (const op of Object.keys(lanes)) assert.ok(op in { ...RWA_YIELD_CAPTURE_OPS, ...RWA_ISSUER_CAPTURE_OPS }, `${op} is not a registered op`)
})
