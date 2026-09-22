// LIFE-409 F6 — an old report cannot settle the current attempt, and a settled Task cannot be
// settled twice. The two codes differ and the order of the checks is what makes them differ.
//
// r1 (R2): the warm-up `run-current` that used to precede each digest is gone. The second attempt
// is live while these refusals run, so a sweep that persisted from the rejected command's own call
// would now show up as a digest change — which is the point of the Codex `f6-no-warmup` repro.
import assert from 'node:assert/strict'
import { fixture } from './lib.mjs'

const f = await fixture('f6', { expectedChecks: 3 })
try {
  await f.startBackend()
  await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 F6 stale reports'])
  const task = await f.cli(['orchestration', 'task-create', '--spec', 'gets two attempts'])
  const taskId = task.result.task.id

  const first = await f.pane('f6-pane-1')
  const d1 = (await f.cli(['orchestration', 'dispatch', '--task', taskId, '--to', first.handle])).result.dispatch
  await f.cli(['terminal', 'close', '--terminal', first.handle])
  await f.cli(['orchestration', 'dispatch-show', '--id', d1.id]) // reconcile settles attempt 1 unknown
  const second = await f.pane('f6-pane-2')
  const d2 = (await f.cli(['orchestration', 'dispatch', '--task', taskId, '--to', second.handle])).result.dispatch

  await f.check('F6a-the-superseded-attempt-cannot-settle-the-task', async () => {
    const before = f.stateDigest()
    const response = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'completed', '--dispatch', d1.id], { fail: true })
    assert.equal(response.error.code, 'stale_dispatch')
    assert.equal(response.error.resources.activeDispatchId, d2.id)
    assert.equal(response.error.resources.dispatchStatus, 'unknown')
    assert.equal(response._meta.outcome, 'not_started')
    assert.equal(f.stateDigest(), before, 'a stale report must change nothing')
    const current = await f.cli(['orchestration', 'dispatch-show', '--id', d2.id])
    assert.equal(current.result.dispatch.status, 'dispatched')
    assert.equal(current.result.task.status, 'dispatched')
    return { response, current, digest: before }
  })

  await f.check('F6b-settling-a-settled-task-is-illegal_transition-even-when-naming-its-attempt', async () => {
    const settled = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'completed', '--dispatch', d2.id])
    assert.equal(settled.result.task.status, 'completed')
    assert.equal(settled.result.dispatch.id, d2.id)
    assert.equal(settled.result.dispatch.status, 'completed')
    assert.equal(settled.result.dispatch.settledBy, 'task-update')
    const before = f.stateDigest()
    const again = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'completed', '--dispatch', d2.id], { fail: true })
    assert.equal(again.error.code, 'illegal_transition')
    assert.deepEqual(again.error.resources.allowed, [])
    const withoutDispatch = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'failed'], { fail: true })
    assert.equal(withoutDispatch.error.code, 'illegal_transition')
    assert.equal(f.stateDigest(), before)
    return { settled, again, withoutDispatch, digest: before }
  })

  await f.check('F6c-an-unknown-attempt-id-is-dispatch_not_found-not-a-silent-pass', async () => {
    const other = await f.cli(['orchestration', 'task-create', '--spec', 'second subject'])
    const pane = await f.pane('f6-pane-3')
    await f.cli(['orchestration', 'dispatch', '--task', other.result.task.id, '--to', pane.handle])
    await f.cli(['orchestration', 'run-current'])
    const before = f.stateDigest()
    const response = await f.cli(['orchestration', 'task-update', '--id', other.result.task.id, '--status', 'completed', '--dispatch', 'ctx_' + '0'.repeat(12)], { fail: true })
    assert.equal(response.error.code, 'dispatch_not_found')
    assert.equal(f.stateDigest(), before)
    // An attempt belonging to another Task is stale, not "not found".
    const foreign = await f.cli(['orchestration', 'task-update', '--id', other.result.task.id, '--status', 'completed', '--dispatch', d1.id], { fail: true })
    assert.equal(foreign.error.code, 'stale_dispatch')
    assert.equal(f.stateDigest(), before)
    return { response, foreign, digest: before }
  })

  f.record('state-after-f6', f.stateJson())
} finally { await f.cleanup() }
