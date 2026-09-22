// LIFE-409 R6 — the negative control for the native gate.
//
// Codex's finding was that a fake `claude` on PATH which prints a line and exits satisfied every
// assertion r0's native gate made. This script puts exactly that fake first on PATH, launches it
// the same way the gate does, and then runs the gate's own three R6 checks against it. Each one has
// to **fail**: a control that passes proves the checks measure nothing.
//
// It never touches the user's installed provider, and nothing is submitted to any pane.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'
import { foregroundExecutable, screenIdentifiesProvider, waitForLaunch } from './native-checks.mjs'

const NATIVE = process.env.L409_NATIVE_CLAUDE ?? path.join(process.env.HOME ?? '', '.local/bin/claude')
const f = await fixture('fake', { expectedChecks: 1 })
try {
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  const fake = path.join(fakebin, 'claude')
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "FAKE_PROVIDER_EXITED\\n"\nexit 0\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 R6 negative control'])
  const task = await f.cli(['orchestration', 'task-create', '--spec', 'a fake provider must not pass the gate'])

  await f.check('R6-negative-control-a-fake-provider-fails-every-gate-check', async () => {
    const launched = await f.cli(['terminal', 'create', '--worktree', f.repo, '--title', 'fake-provider', '--agent', 'claude'], { timeout: 180000 })
    // The r0 assertions still pass against the fake — that is the whole finding.
    assert.equal(launched.result.stages.agent.status, 'completed')
    assert.equal(launched.result.stages.prompt.status, 'not_started')
    assert.equal(launched.result.agent.kind, 'claude')
    const handle = launched.result.terminal.handle
    const dispatched = await f.cli(['orchestration', 'dispatch', '--task', task.result.task.id, '--to', handle])
    assert.notEqual(dispatched.result.dispatch.agent, null, 'r0 recorded an agent snapshot for the fake too')

    const attempted = async (id, fn) => {
      try { const detail = await fn(); return { id, failedAsRequired: false, detail } }
      catch (error) { return { id, failedAsRequired: true, error: String(error).split('\n')[0].slice(0, 400) } }
    }
    const results = [
      await attempted('waitForLaunch', () => waitForLaunch(f, handle, { timeoutMs: 20000, label: 'fake provider leaves launching' })),
      await attempted('foregroundExecutable', () => foregroundExecutable(f, handle, NATIVE)),
      await attempted('screenIdentifiesProvider', () => screenIdentifiesProvider(f, handle, /Claude Code|claude\.ai|Welcome to Claude|2\.1\.252/i, 'fake-screen')),
    ]
    const passed = results.filter(entry => !entry.failedAsRequired)
    assert.deepEqual(passed, [], `a fake provider satisfied a gate check: ${JSON.stringify(passed)}`)
    // The marker proves the fake really ran in that pane, so the failures above are about identity
    // rather than about a pane that never started anything.
    const read = await f.cli(['terminal', 'read', '--terminal', handle])
    assert.match(read.result.text, /FAKE_PROVIDER_EXITED/)
    return { fake, nativeCompared: fs.realpathSync(NATIVE), r0AssertionsPassed: ['stages.agent', 'stages.prompt', 'agent.kind', 'dispatch.agent'], results }
  })

  f.record('state-after-negative-control', f.stateJson())
} finally { await f.cleanup() }
