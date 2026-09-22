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
import { spawn } from 'node:child_process'
import { fixture } from './lib.mjs'
import { foregroundExecutable, screenIdentifiesProvider, waitForLaunch } from './native-checks.mjs'

const NATIVE = process.env.L409_NATIVE_CLAUDE ?? path.join(process.env.HOME ?? '', '.local/bin/claude')
const f = await fixture('fake', { expectedChecks: 2 })
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

  // N10 = G10 = R12. The second control is about the identity check itself: r1 accepted anything
  // under the install root, so a binary planted at `<root>/2.1.251/claude` — Codex planted a copy
  // of `sleep` — passed for a gate that quotes 2.1.252 from `claude --version`. Nothing here goes
  // near the user's install: the whole tree is built inside the fixture and torn down with it.
  await f.check('R6-negative-control-a-binary-beside-the-real-install-is-not-the-real-install', async () => {
    const install = path.join(f.root, 'install')
    // A *copy* of this node binary, planted under the fake install as `claude`. It has to be a
    // copy: a hard link shares the inode, and macOS then reports one of the other names for it, so
    // the impostor would read back as the genuine path — the scaffolding, not the check, deciding
    // the result. (A copy of a macOS system binary such as `/bin/sleep` is SIGKILLed by code
    // signing, so that shortcut is not available either.) On APFS this is a clone, not 90 MB of
    // I/O, and the whole tree dies with the fixture.
    const planted = version => {
      const file = path.join(install, 'versions', version, 'claude')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.copyFileSync(process.execPath, file)
      fs.chmodSync(file, 0o700)
      return file
    }
    const real = planted('2.1.252'), impostor = planted('2.1.251')
    const launcher = path.join(install, 'bin', 'claude')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.symlinkSync(real, launcher)
    const running = []
    const stub = pid => ({ cli: async () => ({ result: { process: { foreground: [{ pid, name: 'claude', argv: ['claude', '--session-id', 'x'] }], shellPid: pid } } }) })
    try {
      for (const binary of [impostor, real]) {
        const child = spawn(binary, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
        running.push(child)
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      const [fake, genuine] = running
      let refused = null
      try { await foregroundExecutable(stub(fake.pid), 'handle', launcher) }
      catch (error) { refused = String(error).split('\n')[0].slice(0, 400) }
      assert.ok(refused, `a 2.1.251 binary beside the install satisfied the identity check (pid ${fake.pid})`)
      // Positive control: the same function, same stub shape, the executable the launcher resolves to.
      const accepted = await foregroundExecutable(stub(genuine.pid), 'handle', launcher)
      assert.equal(accepted.expected, fs.realpathSync(launcher))
      assert.equal(accepted.match.realpath, fs.realpathSync(real))
      return { launcher, real, impostor, refused, accepted }
    } finally { for (const child of running) child.kill('SIGKILL') }
  })

  f.record('state-after-negative-control', f.stateJson())
} finally { await f.cleanup() }
