// LIFE-409 F5 — the reconcile table (00-analysis §4.5), measured row by row against a real
// backend. The claim being tested is negative as much as positive: nothing here ever becomes
// `failed`, nothing is retried on corral's own initiative, and a backend corral cannot reach
// leaves the stored document byte-identical.
import assert from 'node:assert/strict'
import { fixture, until } from './lib.mjs'

const f = await fixture('f5', { expectedChecks: 8 })
let runtime
const rows = []
try {
  let backend = await f.startBackend('backend-1')
  runtime = await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 F5 reconcile'])
  const task = await f.cli(['orchestration', 'task-create', '--spec', 'attempt survives, or does not'])
  const taskId = task.result.task.id

  const first = await f.pane('f5-pane-1')
  const d1 = (await f.cli(['orchestration', 'dispatch', '--task', taskId, '--to', first.handle])).result.dispatch

  await f.check('F5a-a-live-pane-keeps-the-attempt-open', async () => {
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', d1.id])
    assert.equal(shown.result.terminal.live, true)
    assert.equal(shown.result.terminal.observed, true)
    assert.equal(shown.result.dispatch.status, 'dispatched')
    assert.equal(shown.result.dispatch.reconcile.reason, 'pane_live')
    rows.push({ row: 'same generation alive', observed: true, live: true, dispatch: 'dispatched', task: 'dispatched', reason: 'pane_live', raw: 'f5/run.json#F5a' })
    return { shown }
  })

  await f.check('F5b-a-closed-pane-becomes-unknown-and-the-task-stays-dispatched', async () => {
    await f.cli(['terminal', 'close', '--terminal', first.handle])
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', d1.id])
    assert.equal(shown.result.terminal.live, false)
    assert.equal(shown.result.terminal.source, 'observation', 'an attempt that was open when the call started is observed')
    assert.equal(shown.result.terminal.reason, 'pane_gone')
    assert.equal(shown.result.dispatch.status, 'unknown')
    assert.equal(shown.result.dispatch.settledBy, 'reconcile')
    assert.equal(shown.result.dispatch.reconcile.observed, true)
    assert.equal(shown.result.task.status, 'dispatched', 'the Task is not settled by an observation')
    assert.notEqual(shown.result.dispatch.status, 'failed')
    rows.push({ row: 'pane absent', observed: true, live: false, dispatch: 'unknown', task: 'dispatched', reason: 'pane_gone', raw: 'f5/run.json#F5b' })
    return { shown }
  })

  const second = await f.pane('f5-pane-2')
  let d2
  await f.check('F5c-an-unknown-attempt-can-be-dispatched-again-as-attempt-2', async () => {
    const again = await f.cli(['orchestration', 'dispatch', '--task', taskId, '--to', second.handle])
    d2 = again.result.dispatch
    assert.equal(d2.attempt, 2)
    assert.equal(again.result.task.attempts, 2)
    assert.equal(again.result.task.currentDispatchId, d2.id)
    // The superseded attempt is untouched by the retry, and (C11) reading it contacts no backend:
    // a finished attempt is answered from its own record, with live null and source record.
    const old = await f.cli(['orchestration', 'dispatch-show', '--id', d1.id])
    assert.equal(old.result.dispatch.status, 'unknown')
    assert.equal(old.result.dispatch.attempt, 1)
    assert.equal(old.result.terminal.source, 'record')
    assert.equal(old.result.terminal.live, null)
    assert.equal(old.result.terminal.observed, false)
    assert.equal(old.result.terminal.reason, 'pane_gone', 'the stored reconcile is what is repeated')
    return { again, old }
  })

  await f.check('F5d-an-unreachable-backend-records-nothing-at-all', async () => {
    await f.cli(['orchestration', 'dispatch-show', '--id', d2.id]) // warm: records pane_live
    await f.stop(backend, 'SIGTERM')
    await until(async () => (await f.cli(['orchestration', 'dispatch-show', '--id', d2.id])).result.terminal.observed === false, 'backend became unreachable')
    const before = f.stateDigest()
    const restarted = await f.restart(runtime, 'SIGTERM', f.env, 'serve-no-backend')
    runtime = restarted.child
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', d2.id])
    assert.equal(shown.result.terminal.observed, false)
    assert.equal(shown.result.terminal.live, 'unknown')
    assert.ok(['backend_unavailable', 'observation_failed'].includes(shown.result.terminal.reason), shown.result.terminal.reason)
    assert.equal(shown.result.dispatch.status, 'dispatched', 'could-not-look must never settle an attempt')
    assert.equal(shown.result.dispatch.reconcile.reason, 'pane_live', 'the stored observation is the last real one')
    assert.equal(f.stateDigest(), before, 'an unobserved sweep must leave the document byte-identical')
    rows.push({ row: 'backend unreachable', observed: false, live: 'unknown', dispatch: 'dispatched (unchanged)', task: 'dispatched', reason: shown.result.terminal.reason, raw: 'f5/run.json#F5d' })
    return { shown, digest: before }
  })

  await f.check('F5e-a-new-backend-generation-is-epoch_changed', async () => {
    backend = await f.startBackend('backend-2')
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', d2.id])
    assert.equal(shown.result.terminal.observed, true)
    assert.equal(shown.result.terminal.live, false)
    assert.equal(shown.result.terminal.reason, 'epoch_changed')
    assert.equal(shown.result.dispatch.status, 'unknown')
    assert.equal(shown.result.dispatch.settledBy, 'reconcile')
    assert.equal(shown.result.task.status, 'dispatched')
    rows.push({ row: 'backend generation moved', observed: true, live: false, dispatch: 'unknown', task: 'dispatched', reason: 'epoch_changed', raw: 'f5/run.json#F5e' })
    return { shown }
  })

  await f.check('F5f-the-sweep-settles-on-the-first-command-after-a-restart-not-only-dispatch-show', async () => {
    const other = await f.cli(['orchestration', 'task-create', '--spec', 'settled by the startup sweep'])
    const third = await f.pane('f5-pane-3')
    const d3 = (await f.cli(['orchestration', 'dispatch', '--task', other.result.task.id, '--to', third.handle])).result.dispatch
    await f.cli(['terminal', 'close', '--terminal', third.handle])
    const restarted = await f.restart(runtime, 'SIGKILL', f.env, 'serve-after-sweep')
    runtime = restarted.child
    // task-list, not dispatch-show: the sweep runs before every orchestration command.
    const listed = await f.cli(['orchestration', 'task-list'])
    const stored = f.stateJson().dispatches.find(entry => entry.id === d3.id)
    assert.equal(stored.status, 'unknown')
    assert.equal(stored.reconcile.reason, 'pane_gone')
    assert.equal(stored.reconcile.runtimeInstanceId, restarted.after.instanceId)
    assert.equal(listed.result.tasks.find(entry => entry.id === other.result.task.id).status, 'dispatched')
    return { d3, stored, listed }
  })

  await f.check('F5h-the-runtime-start-sweep-settles-a-dead-pane-with-no-command-at-all', async () => {
    // R5 (계약 해석 2). Not "the next command reconciles": the runtime itself reconciles as it
    // becomes ready. Nothing here issues an orchestration command after the restart — the stored
    // document is polled directly until the attempt is `unknown`, and the runtime instance that
    // recorded it has to be the new one.
    const other = await f.cli(['orchestration', 'task-create', '--spec', 'settled by the runtime start sweep'])
    const fourth = await f.pane('f5-pane-4')
    const d4 = (await f.cli(['orchestration', 'dispatch', '--task', other.result.task.id, '--to', fourth.handle])).result.dispatch
    await f.cli(['terminal', 'close', '--terminal', fourth.handle])
    const stored = f.stateJson().dispatches.find(entry => entry.id === d4.id)
    assert.equal(stored.status, 'dispatched', 'the attempt is still open on disk before the restart')
    await f.stop(runtime, 'SIGKILL')
    const startedAt = Date.now()
    runtime = await f.serve(f.env, 'serve-startup-sweep')
    const document = await f.untilState(doc => doc?.dispatches.some(entry => entry.id === d4.id && entry.status === 'unknown') === true,
      'runtime-start sweep settles the dead attempt', 20000)
    const settled = document.dispatches.find(entry => entry.id === d4.id)
    assert.equal(settled.reconcile.reason, 'pane_gone')
    assert.equal(settled.settledBy, 'reconcile')
    assert.equal(document.tasks.find(entry => entry.id === other.result.task.id).status, 'dispatched')
    const status = await f.cli(['status'])
    assert.equal(settled.reconcile.runtimeInstanceId, status.result.runtime.instanceId, 'the new instance is the one that recorded it')
    return { d4, settled, elapsedMs: Date.now() - startedAt, commandsAfterRestart: ['status (foundation, not orchestration)'] }
  })

  await f.check('F5g-nothing-ever-became-failed-and-a-human-can-still-settle', async () => {
    const document = f.stateJson()
    assert.equal(document.dispatches.filter(entry => entry.status === 'failed').length, 0, 'reconcile must never produce failed')
    assert.deepEqual(document.dispatches.map(entry => entry.status).sort(), ['unknown', 'unknown', 'unknown', 'unknown'])
    // §4.5: the human settle path is task-update with no --dispatch, because reconcile already
    // closed the attempt.
    const settled = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'failed', '--result', '{"reason":"operator called it"}'])
    assert.equal(settled.result.task.status, 'failed')
    assert.equal(settled.result.dispatch, null, 'there was no open attempt left to settle')
    assert.deepEqual(settled.result.task.result, { reason: 'operator called it' })
    return { document, settled }
  })

  f.record('recovery-vs-unknown', { rows, note: 'pty_replaced is not reachable through the CLI (a pane id cannot be rebound to a new PTY from outside herdr); it is pinned by the unit tests in src/runtime/orchestration/orchestration.test.ts instead.' })
  f.record('state-after-f5', f.stateJson())
} finally { await f.cleanup() }
