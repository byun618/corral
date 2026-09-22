// LIFE-409 — field-level comparison with a declared exclusion list.
//
// The excluded paths are the ones that are *supposed* to differ across a restart: a re-observation
// says when it happened and which runtime instance made it, and the RPC envelope id identifies the
// call rather than the record. The list is exported so every script that compares writes it into
// its own raw record — a reviewer sees what was excluded, and why, next to the result.
export const EXCLUDED = {
  'id': 'the RPC envelope id is minted per request and identifies the call, not the record',
  '_meta.instanceId': 'a new runtime process has a new instance id; runtimeId is asserted equal instead',
  'result.terminal.observedAt': 'the response carries the observation this call made, not a stored one',
  'result.terminal.runtimeInstanceId': 'same: the instance that looked, this time',
  'result.dispatch.reconcile.at': 'only written when the observation changes; excluded so the check does not depend on that',
  'result.dispatch.reconcile.runtimeInstanceId': 'same',
}
export function differences(before, after, prefix = '') {
  const out = []
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const key of keys) {
    const at = prefix ? `${prefix}.${key}` : key
    if (at in EXCLUDED) continue
    const left = before?.[key], right = after?.[key]
    const nested = value => value !== null && typeof value === 'object'
    if (nested(left) && nested(right)) out.push(...differences(left, right, at))
    else if (JSON.stringify(left) !== JSON.stringify(right)) out.push({ at, before: left, after: right })
  }
  return out
}
