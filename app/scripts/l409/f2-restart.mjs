// LIFE-409 F2 — the records survive a runtime restart (SIGTERM and SIGKILL) and a fresh client
// connection, field for field. The backend and its pane are deliberately left alone so the only
// thing that changes is the runtime process.
import assert from 'node:assert/strict'
import { fixture } from './lib.mjs'
import { differences, EXCLUDED } from './compare.mjs'

const f = await fixture('f2')
let runtime
try {
  await f.startBackend()
  runtime = await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 F2 persistence'])
  const free = await f.cli(['orchestration', 'task-create', '--spec', 'survives a restart', '--title', 'subject'])
  const dependent = await f.cli(['orchestration', 'task-create', '--spec', 'waits', '--deps', free.result.task.id])
  const target = await f.pane('f2-pane')
  const dispatched = await f.cli(['orchestration', 'dispatch', '--task', free.result.task.id, '--to', target.handle])

  const snapshot = async () => ({
    runCurrent: await f.cli(['orchestration', 'run-current']),
    taskList: await f.cli(['orchestration', 'task-list']),
    dispatchShow: await f.cli(['orchestration', 'dispatch-show', '--id', dispatched.result.dispatch.id]),
  })
  // Warm the reconcile record once so the first observation is already stored; from here on a live
  // pane produces no write at all and the document stays byte-identical.
  await snapshot()
  const before = await snapshot()
  const beforeDigest = f.stateDigest()

  await f.check('F2b-a-fresh-client-connection-sees-the-same-records', async () => {
    const again = await snapshot()
    for (const key of Object.keys(before)) {
      assert.deepEqual(differences(before[key], again[key]), [], `${key} changed between two client runs`)
    }
    assert.equal(f.stateDigest(), beforeDigest, 'reads must not rewrite the document')
    return { excluded: EXCLUDED, digest: beforeDigest }
  })

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    await f.check(`F2a-${signal}-restart-preserves-every-field`, async () => {
      const restarted = await f.restart(runtime, signal)
      runtime = restarted.child
      const after = await snapshot()
      const changes = {}
      for (const key of Object.keys(before)) changes[key] = differences(before[key], after[key])
      for (const [key, rows] of Object.entries(changes)) assert.deepEqual(rows, [], `${key} changed across ${signal} restart`)
      assert.equal(after.dispatchShow.result.terminal.live, true, 'the pane is still alive after a runtime restart')
      assert.equal(after.dispatchShow.result.dispatch.status, 'dispatched')
      assert.equal(f.stateDigest(), beforeDigest, 'an unchanged observation must not rewrite the document')
      return {
        signal, runtimeId: restarted.after.runtimeId,
        instanceIdBefore: restarted.before.instanceId, instanceIdAfter: restarted.after.instanceId,
        excluded: EXCLUDED, digest: f.stateDigest(), after,
      }
    })
  }

  await f.check('F2c-the-pending-dependent-and-the-attempt-are-both-still-there', async () => {
    const tasks = (await f.cli(['orchestration', 'task-list'])).result.tasks
    assert.deepEqual(tasks.map(task => [task.id, task.status]), [[free.result.task.id, 'dispatched'], [dependent.result.task.id, 'pending']])
    const shown = await f.cli(['orchestration', 'dispatch-show', '--task', free.result.task.id])
    assert.equal(shown.result.dispatch.id, dispatched.result.dispatch.id)
    assert.equal(shown.result.dispatch.attempt, 1)
    return { tasks, shown }
  })

  f.record('state-after-f2', f.stateJson())
  f.record('f2-before-snapshot', before)
} finally { await f.cleanup() }
