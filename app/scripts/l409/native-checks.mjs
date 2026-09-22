// LIFE-409 R6 — what makes the native gate a gate.
//
// r0 asserted that a pane existed and that corral had recorded an agent. Codex showed that a fake
// `claude` on PATH that prints one line and exits satisfies all of that (`raw/review/codex/
// native-negative/`). These three checks are the difference, and `native-negative.mjs` runs the
// same functions against that fake to show each one fails there:
//
//   1. the agent leaves `launching` for a live phase, and is not `exited`;
//   2. the pane's foreground process is the user's own installed executable, by realpath;
//   3. the screen — read once, nothing ever typed — says which provider is on it.
//
// Nothing here submits a prompt, answers a dialog or writes to a pane. `terminal read --screen` is
// a read command; the only input to the pane is the one `terminal create` performed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { until } from './lib.mjs'

/** Phases that mean the provider is up. `blocked` counts: a trust screen is a running provider. */
export const LIVE_PHASES = ['blocked', 'ready', 'accepted', 'responded']

export async function waitForLaunch(f, handle, { timeoutMs = 180000, label = 'agent leaves launching' } = {}) {
  const samples = []
  await until(async () => {
    const shown = await f.cli(['terminal', 'show', '--terminal', handle], { timeout: 60000 })
    const agent = shown.result.agent
    const phase = agent?.phase ?? null
    samples.push({ at: new Date().toISOString(), phase, agentStatus: agent?.evidence?.agentStatus ?? null, launchPending: agent?.evidence?.launchPending ?? null })
    assert.notEqual(phase, 'exited', `the provider exited instead of coming up: ${JSON.stringify(samples.at(-1))}`)
    return LIVE_PHASES.includes(phase)
  }, label, timeoutMs)
  return { phase: samples.at(-1).phase, samples }
}

/**
 * The pane's foreground executable, resolved through the OS rather than through corral's own
 * bookkeeping, compared with the realpath of the provider the gate claims to be exercising.
 *
 * `ps -o comm=` is not enough: for this provider it prints the accounting name (`claude`), not a
 * path. `lsof -a -p <pid> -d txt -Fn` prints the mapped executable itself, which is what a
 * comparison against the user's install has to be about. Both are recorded; the realpath of the
 * executable is what is asserted, so a launcher symlink and its versioned binary are the same thing.
 */
export async function foregroundExecutable(f, handle, expected) {
  const shown = await f.cli(['terminal', 'show', '--terminal', handle], { timeout: 60000 })
  const foreground = shown.result.process?.foreground ?? []
  assert.ok(foreground.length > 0, `the pane has no foreground process: ${JSON.stringify(shown.result.process)}`)
  const target = fs.realpathSync(expected)
  const installRoot = path.dirname(path.dirname(target))
  const observed = foreground.map(entry => {
    const comm = execFileSync('ps', ['-p', String(entry.pid), '-o', 'comm='], { encoding: 'utf8' }).trim()
    let executable = null
    try {
      const listed = execFileSync('lsof', ['-a', '-p', String(entry.pid), '-d', 'txt', '-Fn'], { encoding: 'utf8' })
      executable = listed.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1))
        .find(file => !file.startsWith('/usr/lib/') && !file.startsWith('/System/')) ?? null
    } catch { /* recorded as null; the ps name is still in the raw record */ }
    let real = null
    try { real = fs.realpathSync(executable ?? comm) } catch { /* the process may already be gone */ }
    return { pid: entry.pid, name: entry.name, argv: entry.argv, comm, executable, realpath: real }
  })
  const match = observed.find(entry => entry.realpath === target || (entry.realpath !== null && entry.realpath.startsWith(installRoot + '/')))
  assert.ok(match, `no foreground process resolves to ${target} (install root ${installRoot}): ${JSON.stringify(observed)}`)
  return { expected: target, installRoot, observed, match, shellPid: shown.result.process.shellPid }
}

/** One screen read, no input. The excerpt goes into the raw record whether it matches or not. */
export async function screenIdentifiesProvider(f, handle, pattern, name = 'screen') {
  const read = await f.cli(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '16384'], { timeout: 60000 })
  const text = read.result.text ?? ''
  f.record(name, { pattern: String(pattern), matched: pattern.test(text), text })
  assert.match(text, pattern)
  return { matched: true, bytes: text.length }
}
