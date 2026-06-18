// Investor Intel — frontend feature flags.
//
// THESIS_JOURNAL_ENABLED is the global kill switch for the new Thesis Journal.
// Default ON. Set VITE_THESIS_JOURNAL_ENABLED=false to disable globally and fall
// back to the legacy Thesis Tracker (src/intel/pages/ThesisPage.jsx), which is
// retained as an internal fallback route until one release after global
// verification. This is a build-time switch (Vite env); a production incident is
// resolved by rebuilding/redeploying with the flag off — no per-org canary.
export const THESIS_JOURNAL_ENABLED =
  String(import.meta.env?.VITE_THESIS_JOURNAL_ENABLED ?? 'true').toLowerCase() !== 'false'
