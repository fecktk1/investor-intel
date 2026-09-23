// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// What every stand-in is built from. Some Investor Intel modules import a module
// of the private parent platform (an HTTP client for another provider, a
// portfolio helper, the authorization layer). That module is not published, so
// without a stand-in the Intel module cannot even load, and none of its tests
// can run, including the ones that never touch the missing module.
//
// A stand-in therefore exists only so an import LOADS. Nothing in it may be
// USED:
//   - every function throws when called;
//   - every constant throws when it is read;
//   - every class throws when it is constructed.
// Code under test could catch that throw and fall back quietly, so each use
// also raises a second, uncaught error on the next microtask. That fails the
// test run whatever the caller does with the first one. A test that passes has
// therefore never reached a stand-in, and no stand-in imitates the platform.
//
// test-support/deno.json maps the parent paths to these files for the test run
// only. The published production source is unchanged.

function refuse(name: string): never {
  const error = new Error(`TEST STAND-IN reached: ${name} is part of the private platform and is not in this repository. A test that needs it cannot run here.`)
  queueMicrotask(() => { throw error })
  throw error
}

/** A function export that must never be called in a published test. */
export function unavailable(name: string): (...args: unknown[]) => never {
  return () => refuse(name)
}

/** A constant export that must never be read in a published test. */
// deno-lint-ignore no-explicit-any
export function unavailableConstant(name: string): any {
  const trap = () => refuse(name)
  return new Proxy(Object.create(null), {
    get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap, set: trap, defineProperty: trap, deleteProperty: trap,
  })
}

/** A class export that must never be constructed in a published test.
 * `value instanceof` it stays false for every real value, as it would be for a
 * class that nothing in the test ever constructed. */
export function unavailableClass(name: string): new (...args: unknown[]) => never {
  return class {
    constructor() { refuse(name) }
  } as unknown as new (...args: unknown[]) => never
}
