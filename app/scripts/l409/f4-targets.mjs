// LIFE-409 F4 — every refused dispatch leaves the stored document byte-identical.
//
// r1 (R2): there is no warm-up call any more. r0 ran `run-current` first so the pre-command sweep
// had already written whatever it was going to write, which is exactly what hid the finding — the
// sweep used to persist from a rejected command's own call. The digest is now taken immediately
// before each refusal with no preparation at all, so "this rejection wrote nothing" is measured
// against a live pane the sweep would happily have stamped.
import assert from 'node:assert/strict'
import { fixture } from './lib.mjs'

const f = await fixture('f4', { expectedChecks: 7 })
try {
  await f.startBackend()
  await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 F4 refusals'])
  const first = await f.cli(['orchestration', 'task-create', '--spec', 'first'])
  const dependent = await f.cli(['orchestration', 'task-create', '--spec', 'dependent', '--deps', first.result.task.id])
  const live = await f.pane('f4-live')
  const doomed = await f.pane('f4-doomed')
  const doomedHandle = doomed.handle
  await f.cli(['terminal', 'close', '--terminal', doomedHandle])

  /** Run one refusal with the document digested on both sides of exactly that call. */
  const refuses = async (id, args, code) => f.check(id, async () => {
    const before = f.stateDigest()
    const response = await f.cli(args, { fail: true })
    assert.equal(response.error.code, code, JSON.stringify(response.error))
    assert.equal(response._meta.outcome, 'not_started')
    assert.equal(f.stateDigest(), before, `${code} changed the stored document`)
    return { args, response, digest: before }
  })

  // (a) A handle whose signature does not verify. One character of the payload is flipped, which
  //     is exactly the shape a forged or truncated handle has.
  const [prefix, payload, mac] = live.handle.split('.')
  const flipped = [prefix, payload.slice(0, -1) + (payload.at(-1) === 'A' ? 'B' : 'A'), mac].join('.')
  await refuses('F4a-forged-handle-is-invalid_terminal', ['orchestration', 'dispatch', '--task', first.result.task.id, '--to', flipped], 'invalid_terminal')

  // (b) A handle that verified when it was minted but whose pane is gone.
  await refuses('F4b-closed-pane-handle-is-stale_terminal', ['orchestration', 'dispatch', '--task', first.result.task.id, '--to', doomedHandle], 'stale_terminal')

  // (d) A task whose dependencies are not met yet names them in resources.
  await f.check('F4d-pending-task-is-task_not_startable-with-its-unmet-dependencies', async () => {
    const before = f.stateDigest()
    const response = await f.cli(['orchestration', 'dispatch', '--task', dependent.result.task.id, '--to', live.handle], { fail: true })
    assert.equal(response.error.code, 'task_not_startable')
    assert.equal(response.error.resources.reason, 'unmet_dependencies')
    assert.deepEqual(response.error.resources.unmetDependencies, [first.result.task.id])
    assert.equal(response._meta.outcome, 'not_started')
    assert.equal(f.stateDigest(), before)
    return { response, digest: before }
  })

  // (c) A second attempt while the first is still open.
  const dispatched = await f.cli(['orchestration', 'dispatch', '--task', first.result.task.id, '--to', live.handle])
  await f.check('F4c-a-second-attempt-while-one-is-open-is-task_not_startable', async () => {
    const before = f.stateDigest()
    const response = await f.cli(['orchestration', 'dispatch', '--task', first.result.task.id, '--to', live.handle], { fail: true })
    assert.equal(response.error.code, 'task_not_startable')
    assert.equal(response.error.resources.reason, 'dispatch_active')
    assert.equal(response.error.resources.activeDispatchId, dispatched.result.dispatch.id)
    assert.equal(f.stateDigest(), before)
    return { response, digest: before }
  })

  // (g) R1: the detour r0 allowed is refused at its first step. Moving a Task out of `dispatched`
  //     while its attempt is open would leave that attempt with no manual end at all.
  await f.check('F4g-an-open-attempt-refuses-to-be-walked-back-to-blocked', async () => {
    const detour = await f.cli(['orchestration', 'task-create', '--spec', 'walked back to ready'])
    const taskId = detour.result.task.id
    const pane = await f.pane('f4-detour')
    const open = await f.cli(['orchestration', 'dispatch', '--task', taskId, '--to', pane.handle])
    const before = f.stateDigest()
    const refused = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'blocked'], { fail: true })
    assert.equal(refused.error.code, 'illegal_transition')
    assert.equal(refused.error.resources.reason, 'dispatch_active')
    assert.equal(refused.error.resources.activeDispatchId, open.result.dispatch.id)
    assert.match(refused.error.resources.recovery, /task-update|dispatch-show/)
    assert.equal(refused._meta.outcome, 'not_started')
    assert.equal(f.stateDigest(), before, 'the refusal wrote nothing — including no sweep stamp')
    // Settling is always available, and reconcile is the other way out once the pane is gone.
    await f.cli(['terminal', 'close', '--terminal', pane.handle])
    const settledByReconcile = await f.cli(['orchestration', 'dispatch-show', '--id', open.result.dispatch.id])
    assert.equal(settledByReconcile.result.dispatch.status, 'unknown')
    const blocked = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'blocked'])
    assert.equal(blocked.result.task.status, 'blocked')
    return { open, refused, settledByReconcile, blocked }
  })

  await f.check('F4e-a-blocked-and-a-completed-task-are-both-refused', async () => {
    const other = await f.cli(['orchestration', 'task-create', '--spec', 'to be blocked'])
    await f.cli(['orchestration', 'task-update', '--id', other.result.task.id, '--status', 'blocked'])
    let before = f.stateDigest()
    const blocked = await f.cli(['orchestration', 'dispatch', '--task', other.result.task.id, '--to', live.handle], { fail: true })
    assert.equal(blocked.error.resources.reason, 'task_blocked')
    assert.equal(f.stateDigest(), before)
    await f.cli(['orchestration', 'task-update', '--id', first.result.task.id, '--status', 'completed'])
    before = f.stateDigest()
    const completed = await f.cli(['orchestration', 'dispatch', '--task', first.result.task.id, '--to', live.handle], { fail: true })
    assert.equal(completed.error.resources.reason, 'task_completed')
    assert.equal(f.stateDigest(), before)
    // Completing the dependency promoted the dependent inside that same write.
    const promotedNow = (await f.cli(['orchestration', 'task-list', '--ready'])).result.tasks.map(task => task.id)
    assert.ok(promotedNow.includes(dependent.result.task.id), 'dependent should be ready once its dependency completed')
    return { blocked, completed, promotedNow }
  })

  await f.check('F4f-an-unknown-task-or-dispatch-id-is-effect-free', async () => {
    const before = f.stateDigest()
    const missingTask = await f.cli(['orchestration', 'dispatch', '--task', 'task_' + '0'.repeat(12), '--to', live.handle], { fail: true })
    assert.equal(missingTask.error.code, 'task_not_found')
    const missingDispatch = await f.cli(['orchestration', 'dispatch-show', '--id', 'ctx_' + '0'.repeat(12)], { fail: true })
    assert.equal(missingDispatch.error.code, 'dispatch_not_found')
    assert.equal(f.stateDigest(), before)
    return { missingTask, missingDispatch, digest: before }
  })

  f.record('state-after-f4', f.stateJson())
} finally { await f.cleanup() }
