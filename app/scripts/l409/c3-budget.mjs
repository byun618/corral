// LIFE-409 C3 — corral's own re-observation must not hold a read command hostage.
//
// A backend that accepts the connection and then says nothing is the shape that matters: the socket
// is there, so "is the backend reachable" answers yes, and every open attempt is re-observed before
// the command runs. In r0 that cost `run-list` the whole 10 s client timeout and ended in
// `outcome_unknown` — an effect-free read reported as "result unknown". The sweep now has its own
// 2 s budget and falls back to `observed: false`, which is §4.5's "could not look": nothing stored,
// command answered.
//
// The negative control is the same call with no open attempt at all: the backend is never contacted
// then, so a fast answer there would prove nothing about the budget.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import { fixture } from './lib.mjs'

const BUDGET_MS = 2000
const f = await fixture('c3', { expectedChecks: 5 })
let runtime, silent
let contacts = 0
try {
  const backend = await f.startBackend()
  runtime = await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 C3 observation budget'])
  const task = await f.cli(['orchestration', 'task-create', '--spec', 'bound to a pane whose backend goes silent'])
  const pane = await f.pane('c3-pane')
  const dispatched = await f.cli(['orchestration', 'dispatch', '--task', task.result.task.id, '--to', pane.handle])

  // M5 = R18. The negative half of this file (a silent backend, a timeout below the floor) passes
  // just as well when no observation is ever made — Codex proved it by running C3 against a bundle
  // whose `budgeted()` always returned null and getting 4/4. This is the half that fails there: a
  // command with its whole default budget really does look, and says so in the response.
  await f.check('C3-a-command-with-budget-to-spare-actually-observes-the-pane', async () => {
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', dispatched.result.dispatch.id])
    assert.equal(shown.result.terminal.observed, true, 'a live backend and a full budget must produce an observation')
    assert.equal(shown.result.terminal.live, true)
    assert.equal(shown.result.terminal.source, 'observation')
    assert.equal(shown.result.dispatch.status, 'dispatched')
    return { shown }
  })

  const timed = async (args, options = {}) => {
    const started = Date.now()
    const response = await f.cliRaw(args, options)
    return { args, ms: Date.now() - started, exit: response.exit, ok: response.json?.ok ?? null, code: response.json?.error?.code ?? null, outcome: response.json?._meta?.outcome ?? null }
  }
  const baseline = await timed(['orchestration', 'run-list'])

  // Take the real backend away and leave a listener that accepts and never answers.
  await f.stop(runtime, 'SIGTERM')
  await f.stop(backend, 'SIGKILL')
  try { fs.unlinkSync(f.socket) } catch { /* the backend removed it on the way out */ }
  // M5 = R18: every connection to this socket is a backend contact, counted so a check can
  // assert the observation was *skipped* rather than merely unanswered.
  silent = net.createServer(socket => { contacts += 1; socket.on('data', () => {}) })
  await new Promise(resolve => silent.listen(f.socket, resolve))
  fs.chmodSync(f.socket, 0o600)
  runtime = await f.serve(f.env, 'serve-silent-backend')

  await f.check('C3-a-silent-backend-does-not-turn-a-read-into-outcome_unknown', async () => {
    const before = f.stateDigest()
    const reads = []
    for (const args of [['orchestration', 'run-list'], ['orchestration', 'run-current'], ['orchestration', 'task-list']]) {
      const measured = await timed(args)
      assert.equal(measured.ok, true, `${args.join(' ')} failed: ${JSON.stringify(measured)}`)
      assert.equal(measured.outcome, 'completed')
      assert.notEqual(measured.code, 'outcome_unknown')
      // Two budgets plus the baseline round trip and a little slack: the sweep may spend its
      // share and the command still has to run. The r0 behaviour was the full 10 s client timeout.
      assert.ok(measured.ms < baseline.ms + BUDGET_MS * 2 + 1500, `${args.join(' ')} took ${measured.ms} ms`)
      reads.push(measured)
    }
    // §4.5: could-not-look writes nothing.
    assert.equal(f.stateDigest(), before, 'an unobserved sweep must leave the document byte-identical')
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', dispatched.result.dispatch.id])
    assert.equal(shown.result.terminal.observed, false)
    assert.equal(shown.result.dispatch.status, 'dispatched', 'a silent backend never settles an attempt')
    assert.equal(f.stateDigest(), before)
    return { baseline, reads, shown }
  })

  await f.check('C3-a-shorter---timeout-ms-still-wins-and-a-profile-with-no-open-attempt-is-untouched', async () => {
    const short = await timed(['orchestration', 'run-list', '--timeout-ms', '1000'])
    assert.equal(short.ok, true, JSON.stringify(short))
    assert.ok(short.ms < 3000, `--timeout-ms 1000 took ${short.ms} ms`)
    // Negative control: a profile with no open attempt never contacts the backend at all, so its
    // speed says nothing about the budget — it is here to show the two cases are different.
    const quiet = f.client('quiet')
    const quietRuntime = await f.serve(quiet, 'serve-quiet')
    try {
      await f.cli(['orchestration', 'run-create', '--objective', 'no attempts here'], { env: quiet })
      const noAttempts = await timed(['orchestration', 'run-list'], { env: quiet })
      assert.equal(noAttempts.ok, true, JSON.stringify(noAttempts))
      // G9: "it answered" is not the control — "it answered without waiting on anything" is.
      // M10 = C23: measured at 40 ms against a 182 ms baseline, so 1500 ms of slack could not tell
      // "never contacted the backend" from "contacted it and waited out a budget". 500 ms can.
      assert.ok(noAttempts.ms < baseline.ms + 500, `a profile with no open attempt took ${noAttempts.ms} ms`)
      return { short, noAttempts }
    } finally { await f.stop(quietRuntime, 'SIGTERM') }
  })

  // N2 = R10. Two windows the r1 budget still lost. Cold: the startup sweep holds the
  // orchestration lane while it looks at a backend that never answers, so a short `--timeout-ms`
  // read queued behind it died at the client deadline (`request_cancelled` / `outcome_unknown`)
  // without the command ever running. Warm: below the 250 ms floor the *share* itself exceeded
  // what the caller had left, so the observation spent the whole deadline.
  await f.check('C3-a-cold-read-behind-the-startup-sweep-answers-inside-its-own---timeout-ms', async () => {
    await f.stop(runtime, 'SIGTERM')
    const before = f.stateDigest()
    runtime = await f.serve(f.env, 'serve-cold-sweep')
    const cold = await timed(['orchestration', 'run-list', '--timeout-ms', '1000'])
    assert.equal(cold.ok, true, JSON.stringify(cold))
    assert.equal(cold.exit, 0)
    assert.notEqual(cold.code, 'request_cancelled')
    assert.notEqual(cold.code, 'outcome_unknown')
    assert.ok(cold.ms < 1000, `a cold --timeout-ms 1000 read took ${cold.ms} ms`)
    assert.equal(f.stateDigest(), before, 'an unobserved sweep must leave the document byte-identical')
    return { cold }
  })

  await f.check('C3-a-timeout-shorter-than-the-floor-skips-the-observation-instead-of-spending-it', async () => {
    const before = f.stateDigest()
    const short = [], observed = []
    for (const ms of [100, 250, 400]) {
      const measured = await timed(['orchestration', 'run-list', '--timeout-ms', String(ms)])
      assert.equal(measured.ok, true, JSON.stringify(measured))
      assert.ok(measured.ms < Number(ms) + 400, `--timeout-ms ${ms} took ${measured.ms} ms`)
      short.push(measured)
      // M5 = R18: "skipped" is a claim about the response, not only about the clock. Below the
      // floor the share is worth nothing, so the command must say it did not look — and must not
      // have opened a connection to say it.
      const beforeContacts = contacts
      const shown = await f.cli(['orchestration', 'dispatch-show', '--id', dispatched.result.dispatch.id, '--timeout-ms', String(ms)])
      assert.equal(shown.result.terminal.observed, false, `--timeout-ms ${ms} claimed an observation`)
      assert.equal(shown.result.terminal.reason, 'observation_failed')
      assert.equal(shown.result.terminal.live, 'unknown')
      assert.equal(shown.result.dispatch.status, 'dispatched')
      assert.equal(contacts, beforeContacts, `--timeout-ms ${ms} contacted the backend ${contacts - beforeContacts} time(s)`)
      observed.push({ timeoutMs: ms, terminal: shown.result.terminal })
    }
    // The observation is skipped, not shortened into a wrong answer: the attempt stays open.
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', dispatched.result.dispatch.id])
    assert.equal(shown.result.dispatch.status, 'dispatched')
    assert.equal(f.stateDigest(), before)
    return { short, observed, shown, contacts }
  })

  f.record('state-after-c3', f.stateJson())
} finally {
  silent?.close()
  await f.cleanup()
}
