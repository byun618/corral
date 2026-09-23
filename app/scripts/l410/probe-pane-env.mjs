// LIFE-410 02-kickoff item 2 — the measurement that decides the sender-proof means.
//
// Question: does the shell herdr starts inside a pane carry an environment variable naming that
// pane, and is its value the same string corral's `list()` reports as `paneId`? If it is, a CLI
// call made from inside the pane can state which pane it came from and the runtime can compare it
// with the Dispatch target (means ⓐ). If it is not, the proof has to travel in the preamble as a
// per-Dispatch launch token (means ⓑ).
//
// Nothing is submitted to a provider here: the pane runs /bin/sh and is only asked to dump its own
// environment. The whole run lives under /tmp/l410-claude-*.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'

const f = await fixture('sender-proof', { expectedChecks: 3 })
try {
  /**
   * V30. The stand-in provider goes on PATH *before* the backend is started, not before the check
   * that needs it. A pane inherits the backend's environment, and the backend inherits the one it
   * was started with — so a fakebin added afterwards was never on the PATH the pane would use, and
   * an `--agent claude` in this fixture could launch the real provider that happened to be on the
   * operator's own PATH. Nothing was ever submitted to one here, but a pane running a real provider
   * that reached ready is a pane that could have been: the isolation, not the outcome, is the rule.
   *
   * The stub prints a marker unique to this run, which is what the checks below assert on: "the
   * pane is running *this* stub" is a stronger statement than "the pane is running something".
   */
  const MARKER = `L410-PROBE-STUB-${f.runId}`
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), `#!/bin/sh\nprintf '${MARKER}\\n'\nexec sleep 600\n`, { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH
  await f.startBackend()
  const runtime = await f.serve()
  await f.registerRepo()

  const observed = await f.check('PROBE-the-pane-shell-names-its-own-pane', async () => {
    const pane = await f.pane('l410-probe')
    // The shell writes its own environment to a file in the fixture root. Reading the file rather
    // than the screen keeps the answer free of terminal rendering.
    const dump = path.join(f.root, 'pane-env.txt')
    await f.cli(['terminal', 'send', '--terminal', pane.handle, '--text', `env | sort > ${dump}`, '--enter'])
    await f.until(() => fs.existsSync(dump) && fs.readFileSync(dump, 'utf8').includes('PATH='), 'pane env dump')
    const text = fs.readFileSync(dump, 'utf8')
    const entries = Object.fromEntries(text.split('\n').filter(line => /^HERDR/.test(line)).map(line => {
      const cut = line.indexOf('=')
      return [line.slice(0, cut), line.slice(cut + 1)]
    }))
    const listed = await f.cli(['terminal', 'list'])
    const row = listed.result.terminals.find(entry => entry.handle === pane.handle)
    assert.ok(row, 'the pane corral just created must appear in terminal list')
    const matches = Object.entries(entries).filter(([, value]) => value === row.paneId).map(([name]) => name)
    return { herdrEnv: entries, corralPaneId: row.paneId, corralPtyId: row.ptyId, corralEpoch: row.epoch,
      namesMatchingPaneId: matches, paneEnvNames: Object.keys(entries) }
  })

  await f.check('PROBE-record-the-means-this-supports', async () => {
    const usable = observed.namesMatchingPaneId.length > 0
    f.record('sender-proof-probe', { ...observed, meansAvailable: usable ? 'a-pane-env' : 'b-launch-token' })
    // Not an assertion about which answer is right — either answer decides the design. The check
    // exists so the run cannot exit 0 without having written the evidence down.
    assert.ok(fs.existsSync(path.join(f.raw, 'sender-proof-probe.json')))
    return { meansAvailable: usable ? 'a-pane-env' : 'b-launch-token', namesMatchingPaneId: observed.namesMatchingPaneId }
  })

  await f.check('PROBE-what-the-session-half-of-the-proof-is-worth-when-there-is-no-session', async () => {
    // Means ⓐ compares two things: the pane id, and the backend session the pane lives in. The
    // second half only exists if the runtime knew a session when the attempt was created — pane
    // ids repeat across sessions, so that comparison is what keeps `w1:p1` in one session from
    // answering for `w1:p1` in another. A runtime that recorded no session has nothing to compare,
    // and then the pane id stands alone: a weaker proof, which must *say* it is weaker rather than
    // look like the stronger one (V8).
    //
    // The unset half cannot be produced by starting a runtime without `CORRAL_SESSION` — this
    // fixture's backend is reached by session name, so such a runtime refuses to start at all
    // (`invalid_backend`). It is produced the way `f8-restart.mjs` produces a LIFE-409 document:
    // the same stored document, with the one field set to null, handed to a second profile on the
    // same backend and the same pane. Both halves live in this fixture's own profiles; the user's
    // default session is not read, named or touched.
    //
    // V30. The runtime is the one this fixture started at the top. Serving the same profile a
    // second time did not start a second runtime — the socket was already held, so the call simply
    // found the first one ready and returned, which made the line read like a setup step it never
    // was. There is one runtime in this half of the probe and it is stopped by name below.
    await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 sender proof — the session half'])
    const taskId = (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble', '--title', 'session'])).result.task.id
    const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
    const dispatchId = started.result.dispatchId
    assert.ok(dispatchId, JSON.stringify(started.result))
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
    const paneId = shown.result.paneId
    // The foreground process of the pane is this fixture's stub and nothing else. Without this the
    // probe would pass just as well against a real provider that the backend found on an inherited
    // PATH — which is the failure V30 names.
    const screen = (await f.cli(['terminal', 'read', '--terminal', shown.result.terminal, '--screen', '--limit', '16384'])).result.text ?? ''
    assert.ok(screen.includes(MARKER), `the pane must be running this run's stand-in provider (${MARKER}), not whatever PATH offered: ${screen.slice(-400)}`)
    const foreground = await f.cli(['terminal', 'show', '--terminal', shown.result.terminal])
    assert.equal(foreground.result.agent?.kind, 'claude', JSON.stringify(foreground.result.agent))
    assert.notEqual(foreground.result.agent?.phase, 'exited', JSON.stringify(foreground.result.agent))
    const report = (env, options = {}) => f.cli(['orchestration', 'send', '--type', 'heartbeat', '--subject', 'alive',
      '--task-id', taskId, '--dispatch-id', dispatchId], { env, ...options })

    // Recorded: both halves are compared.
    const recorded = shown.result.worker.paneSession
    assert.ok(typeof recorded === 'string' && recorded.length > 0, JSON.stringify(shown.result.worker))
    const own = await report({ ...f.env, HERDR_PANE_ID: paneId })
    assert.equal(own.result.sessionVerified, true, JSON.stringify(own.result))
    const foreign = await report({ ...f.env, HERDR_PANE_ID: paneId, HERDR_SESSION: 'a-session-this-attempt-never-lived-in' }, { fail: true })
    assert.equal(foreign.error.code, 'sender_mismatch', JSON.stringify(foreign))
    const sessionless = { ...f.env, HERDR_PANE_ID: paneId }
    delete sessionless.HERDR_SESSION
    const withoutSession = await report(sessionless, { fail: true })
    assert.equal(withoutSession.error.code, 'sender_mismatch', JSON.stringify(withoutSession))

    // Unrecorded: the same pane, the same ids, one field null. Nothing else differs.
    await f.stop(runtime, 'SIGTERM')
    const document = f.stateJson()
    for (const entry of document.dispatches) if (entry.worker !== null) entry.worker = { ...entry.worker, paneSession: null }
    const profile = { ...f.client('session-unrecorded'), PATH: f.base.PATH }
    const file = path.join(profile.CORRAL_USER_DATA, 'runtime/orchestration/state.json')
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n')
    const second = await f.serve(profile, 'serve-session-unrecorded')
    const loose = await f.cli(['orchestration', 'send', '--type', 'heartbeat', '--subject', 'alive',
      '--task-id', taskId, '--dispatch-id', dispatchId],
    { env: { ...profile, HERDR_PANE_ID: paneId, HERDR_SESSION: 'a-session-this-attempt-never-lived-in' } })
    assert.equal(loose.result.sessionVerified, false, JSON.stringify(loose.result))
    await f.stop(second, 'SIGTERM')

    const measured = {
      backendSession: f.session, paneId,
      recorded: { paneSession: recorded, ownSession: { accepted: true, sessionVerified: own.result.sessionVerified },
        foreignSession: { accepted: false, code: foreign.error.code }, noSession: { accepted: false, code: withoutSession.error.code } },
      unrecorded: { paneSession: null, foreignSession: { accepted: true, sessionVerified: loose.result.sessionVerified } },
    }
    f.record('sender-proof-session-asymmetry', measured)
    return measured
  })
} finally { await f.cleanup() }
