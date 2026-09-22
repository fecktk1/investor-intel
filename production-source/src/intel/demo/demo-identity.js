// Investor Intel public demo: the synthetic visitor.
//
// NOT a real account. No row with these ids exists anywhere, nothing here is
// ever written to localStorage or sent to the backend (demoFetch answers every
// request in the demo), and the access token is a fixed non-JWT string that the
// live API would reject. The identity exists only so the real pages, which were
// written for a signed-in Investor Intel member, render for a visitor.
//
// Tier: Starter. Surfaces are visible; anything that would spend credits or run
// a model ends in the not-in-snapshot message.

export const DEMO_USER_ID = '00000000-0000-4000-8000-00000000d3e0'
export const DEMO_ORG_ID = '00000000-0000-4000-8000-00000000d3e1'
export const DEMO_ACCESS_TOKEN = 'intel-demo-visitor'
export const DEMO_TIER = 'starter'

const EPOCH = '2026-01-01T00:00:00.000Z'

export const DEMO_USER = Object.freeze({
  id: DEMO_USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: '',
  phone: '',
  created_at: EPOCH,
  app_metadata: Object.freeze({ provider: 'demo', providers: [] }),
  user_metadata: Object.freeze({
    display_name: 'Demo visitor',
    product_mode: 'intel',
    active_org_id: DEMO_ORG_ID,
    workspace_org_id: DEMO_ORG_ID,
    default_org_id: DEMO_ORG_ID,
    intel_demo: true,
  }),
})

export const DEMO_SESSION = Object.freeze({
  access_token: DEMO_ACCESS_TOKEN,
  refresh_token: null,
  token_type: 'demo',
  expires_at: null,
  user: DEMO_USER,
  demo: true,
})

export const DEMO_ORG = Object.freeze({
  id: DEMO_ORG_ID,
  name: 'Demo workspace',
  slug: 'intel-demo',
  plan: 'intel_starter',
  plan_overrides: Object.freeze({ intel_tier: DEMO_TIER }),
  is_active: true,
  onboarding_completed: true,
  onboarding_step: null,
  timezone: 'UTC',
  telegram_enabled: false,
  approval_workflow_enabled: false,
  generation_priority: null,
  primary_channels: [],
  content_mix: null,
  org_type: 'Investor',
  web3_subtype: null,
  industry: null,
  async_generation_v2: false,
  bypass_payment: false,
  payment_required_since: null,
  payment_grace_days: 0,
  deleted_at: null,
  product_mode: 'intel',
  trial_ends_at: null,
  is_student_org: false,
  student_variant: null,
  student_variants: [],
  student_plan: null,
  student_credit_balance: null,
  student_credit_period_start: null,
  realty_country: null,
  realty_profile: null,
  created_at: EPOCH,
})

export const DEMO_PROFILE = Object.freeze({
  id: DEMO_USER_ID,
  display_name: 'Demo visitor',
  username: 'demo-visitor',
  is_super_admin: false,
  role: 'member',
  org_id: DEMO_ORG_ID,
  preferred_language: null,
  created_at: EPOCH,
  updated_at: EPOCH,
})

export const DEMO_MEMBERSHIP = Object.freeze({ role: 'owner', org: DEMO_ORG })

/** The org_members row as PostgREST would return it, including the embed. */
export function demoMembershipRow() {
  return {
    id: '00000000-0000-4000-8000-00000000d3e2',
    org_id: DEMO_ORG_ID,
    user_id: DEMO_USER_ID,
    role: 'owner',
    created_at: EPOCH,
    org: { ...DEMO_ORG },
    orgs: { ...DEMO_ORG },
  }
}
