// LIFE-410 F8 — what survives a restart, and what a crash mid-write can leave behind.
//
// The crash injection is the part worth reading. `worker_done` stores the report and settles the
// attempt in one value, so there is no moment at which one exists without the other; the way to
// show that is to kill the runtime *while* the write is being made, many times, and check every
// resulting file. The kill is aimed at the window by SIGKILLing the runtime a few milliseconds
// after the report is sent, repeatedly, so some attempts land before the rename and some after.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'

const f = await fixture('f8', { expectedChecks: 4 })
try {
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  let runtime = await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F8 — restart and atomicity'])
  const task = async title => (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble', '--title', title])).result.task.id
  const launch = async taskId => {
    const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
    assert.ok(started.result.dispatchId, JSON.stringify(started.result))
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', started.result.dispatchId])
    return { dispatchId: started.result.dispatchId, paneId: shown.result.paneId, handle: shown.result.terminal }
  }

  await f.check('F8-an-outstanding-batch-and-an-unanswered-question-survive-a-restart', async () => {
    const taskId = await task('survives')
    const worker = await launch(taskId)
    const pane = { ...f.env, HERDR_PANE_ID: worker.paneId }
    // A question nobody has answered yet, and a batch nobody has acknowledged yet.
    const pending = await f.cli(['orchestration', 'ask', '--question', 'survives a restart?', '--task-id', taskId,
      '--dispatch-id', worker.dispatchId, '--timeout-ms', '2000'], { env: pane, timeout: 40000 })
    assert.equal(pending.result.state, 'pending')
    const batch = await f.cli(['orchestration', 'check'])
    assert.ok(batch.result.count >= 1, JSON.stringify(batch.result))

    const restarted = await f.restart(runtime, 'SIGKILL')
    runtime = restarted.child
    // The same batch, the same id, still outstanding.
    const replayed = await f.cli(['orchestration', 'check'])
    assert.equal(replayed.result.deliveryId, batch.result.deliveryId, JSON.stringify(replayed.result))
    assert.equal(replayed.result.deliveryReplayed, true)
    assert.deepEqual(replayed.result.messages.map(entry => entry.id), batch.result.messages.map(entry => entry.id))
    // The question is answerable, and the worker's resume collects the answer.
    await f.cli(['orchestration', 'reply', '--id', pending.result.messageId, '--body', 'it did'])
    const resumed = await f.cli(['orchestration', 'ask', '--resume', pending.result.messageId, '--task-id', taskId,
      '--dispatch-id', worker.dispatchId, '--timeout-ms', '30000'], { env: pane, timeout: 60000 })
    assert.equal(resumed.result.state, 'answered', JSON.stringify(resumed.result))
    assert.equal(resumed.result.reply.body, 'it did')
    // The attempt's pane outlived the runtime, so the attempt is still open.
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', worker.dispatchId])
    assert.equal(shown.result.dispatch.status, 'dispatched')
    assert.equal(shown.result.observation.live, true)
    return { delivery: batch.result.deliveryId, resumed: resumed.result, worker: shown.result.worker }
  })

  await f.check('F8-a-pane-that-died-while-corral-was-down-is-unknown-and-refuses-a-late-report', async () => {
    const taskId = await task('lost')
    const worker = await launch(taskId)
    const pane = { ...f.env, HERDR_PANE_ID: worker.paneId }
    // The pane's own shell, so it can be ended while corral is not running. The CLI cannot be used
    // for that: it is a socket client, and the socket is exactly what is about to go away.
    const shellPid = (await f.cli(['terminal', 'show', '--terminal', worker.handle], { timeout: 60000 })).result.process.shellPid
    assert.ok(Number.isSafeInteger(shellPid) && shellPid > 0, `no shell pid for the pane: ${String(shellPid)}`)
    await f.stop(runtime, 'SIGKILL')
    // The pane goes while nothing is watching. Only this fixture's own pane is signalled.
    process.kill(shellPid, 'SIGKILL')
    runtime = await f.serve()
    // The runtime-start sweep settles it without anyone issuing a command.
    const settled = await f.untilState(state => state !== null
      && state.dispatches.find(entry => entry.id === worker.dispatchId)?.status === 'unknown', 'startup sweep settles the lost attempt')
    const entry = settled.dispatches.find(row => row.id === worker.dispatchId)
    assert.equal(entry.settledBy, 'reconcile')
    assert.equal(entry.reconcile.reason, 'pane_gone')
    const late = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'late', '--body', 'x',
      '--task-id', taskId, '--dispatch-id', worker.dispatchId, '--outcome', 'succeeded'], { env: pane, fail: true })
    assert.equal(late.error.code, 'stale_dispatch', JSON.stringify(late))
    return { dispatch: entry, late: late.error }
  })

  await f.check('F8-a-crash-during-a-worker_done-leaves-both-or-neither', async () => {
    // Calibrate first. A fixed delay is either always before the write or always after it, and both
    // both prove nothing: the sweep has to be measured against how long the report actually takes on
    // this machine, then walked across that point from below to above.
    const baselineTask = await task('crash-baseline')
    const baselineWorker = await launch(baselineTask)
    const startedAt = Date.now()
    await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'baseline', '--body', 'x',
      '--task-id', baselineTask, '--dispatch-id', baselineWorker.dispatchId, '--outcome', 'succeeded'],
    { env: { ...f.env, HERDR_PANE_ID: baselineWorker.paneId } })
    const baseline = Date.now() - startedAt
    const ROUNDS = 16
    const delayFor = round => Math.max(1, Math.round(baseline * (0.55 + (0.75 * round) / (ROUNDS - 1))))
    const outcomes = []
    for (let round = 0; round < ROUNDS; round++) {
      const taskId = await task(`crash-${round}`)
      const worker = await launch(taskId)
      const pane = { ...f.env, HERDR_PANE_ID: worker.paneId }
      const reporting = f.cliRaw(['orchestration', 'send', '--type', 'worker_done', '--subject', `crash-${round}`,
        '--body', 'x', '--task-id', taskId, '--dispatch-id', worker.dispatchId, '--outcome', 'succeeded'],
      { env: pane, timeout: 30000 })
      // Aim at the window: the runtime is killed a few milliseconds into the report, so across the
      // rounds some reports land before the rename and some after.
      await f.pause(delayFor(round))
      await f.stop(runtime, 'SIGKILL')
      await reporting
      runtime = await f.serve()
      // Whatever the file holds, it has to be readable and internally consistent — the store guard
      // refuses a document whose message and settlement disagree, so `worker-show` succeeding at
      // all is the check, and the two fields are then compared directly.
      const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', worker.dispatchId])
      const stored = f.stateJson()
      const reported = stored.messages.some(entry => entry.type === 'worker_done' && entry.dispatchId === worker.dispatchId)
      const settled = shown.result.dispatch.status === 'completed'
      assert.equal(reported, settled, `round ${round}: message ${reported} but settlement ${settled}`)
      outcomes.push({ round, killAfterMs: delayFor(round), reported, settled, status: shown.result.dispatch.status })
    }
    // A run in which nothing ever landed would prove nothing, and neither would one in which
    // everything did: the window has to have been hit from both sides.
    const landed = outcomes.filter(entry => entry.settled).length
    f.record('f8-crash-rounds', { baselineMs: baseline, outcomes })
    assert.ok(landed > 0 && landed < outcomes.length,
      `the injection never straddled the write (baseline ${baseline}ms): ${landed} of ${outcomes.length} landed — ${JSON.stringify(outcomes)}`)
    return { rounds: outcomes.length, landed, baselineMs: baseline }
  })

  await f.check('F8-a-LIFE-409-document-loads-unchanged-in-this-build', async () => {
    // The stored document of the previous task, written by LIFE-409's own build: the arrays and the
    // worker block this task added are simply absent from it.
    const legacy = path.join(f.app, '../specs/LIFE-409-cli-orchestration-core/raw/worker/claude')
    const found = []
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.json')) {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
          if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.dispatches) && parsed.dispatches.length > 0
            && parsed.messages === undefined) found.push({ file: path.relative(path.join(f.app, '..'), full), state: parsed })
        }
      }
    }
    walk(legacy)
    assert.ok(found.length > 0, 'no LIFE-409 state document with attempts was found to load')
    const sample = found[0]
    const profile = f.client('legacy')
    const file = path.join(profile.CORRAL_USER_DATA, 'runtime/orchestration/state.json')
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(sample.state, null, 2) + '\n')
    const child = await f.serve(profile, 'serve-legacy')
    const listed = await f.cli(['orchestration', 'run-list'], { env: profile })
    assert.equal(listed.result.totalCount, sample.state.runs.length, JSON.stringify(listed.result))
    const workers = await f.cli(['orchestration', 'worker-list', '--run', sample.state.runs[0].id], { env: profile })
    assert.equal(workers.result.totalCount, 0, 'a LIFE-409 attempt was never started as a worker')
    const inbox = await f.cli(['orchestration', 'inbox', '--run', sample.state.runs[0].id], { env: profile })
    assert.equal(inbox.result.totalCount, 0)
    await f.stop(child, 'SIGTERM')
    return { file: sample.file, runs: listed.result.totalCount, dispatches: sample.state.dispatches.length }
  })
  f.record('f8-state', f.stateJson())
} finally { await f.cleanup() }
