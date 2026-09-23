// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// Stands in for: supabase/functions/_shared/org-authz.ts
// What that is:  The platform's cross-tenant authorization layer. It is not
//                published, deliberately.
//
// Authorization is NOT stood in. requireOrgMember and orgAuthzErrorResponse
// throw when used (test-support/stand-ins/unavailable.ts), so every test that
// checks who may act on an organization stays out of the published run and is
// listed in production-source/excluded-tests.md.
//
// The one export that is not a refusal is OrgAuthzError, and it is an error
// TYPE, not a decision. Intel's own code throws it when Intel itself decides the
// outcome (intel-surface-access.ts: a caller with no organization is 403, an
// unreadable entitlement is 503), and the tests check the status Intel chose.
// It carries a message and the status the thrower passes, and nothing else: no
// default status, no check, no response.

import { unavailable } from '../unavailable.ts'

export class OrgAuthzError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const requireOrgMember = unavailable('supabase/functions/_shared/org-authz.ts requireOrgMember')
export const orgAuthzErrorResponse = unavailable('supabase/functions/_shared/org-authz.ts orgAuthzErrorResponse')
