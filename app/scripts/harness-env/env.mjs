// LIFE-394 §7.3 / §8.2. The measurement harness must strip the provider session markers it
// inherited, or a child provider treats itself as a nested session and writes no record at all —
// F7 then fails for a reason that has nothing to do with the product.
//
// The removal is an allowlist, not a pattern (review 미확인 6): CODEX_HOME, GROK_HOME and
// CLAUDE_CONFIG_DIR must survive, because dropping them moves the very account and record path
// under measurement. The names below are checked against the product's own constants in
// `src/runtime/runtime.test.ts`, so the two lists cannot drift apart silently.
export const SESSION_MARKER_NAMES = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR']
export const SESSION_MARKER_PREFIXES = ['CLAUDE_CODE_', 'ORCA_AGENT_HOOK_']
export const PRESERVED_NAMES = ['CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR']
const marked = name => SESSION_MARKER_NAMES.includes(name) || SESSION_MARKER_PREFIXES.some(prefix => name.startsWith(prefix))
/** Names that would be removed from this environment, for the raw record. */
export const strippedSessionMarkers = environment => Object.keys(environment).filter(marked).sort()
/** A copy without them. The caller's own process environment is never modified. */
export function withoutSessionMarkers(environment) {
  const copy = { ...environment }
  for (const name of strippedSessionMarkers(environment)) delete copy[name]
  return copy
}
