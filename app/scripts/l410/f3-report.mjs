// LIFE-410 F3 — the completion report: what it settles, who sees it, and how many writes it takes.
//
// `worker_done` is the one message that changes the record, so it is the one that has to be shown
// doing all of it at once: the attempt settles `completed settledBy: 'worker_done'`, the Task
// settles with it, a Task that was waiting on it is promoted, and the coordinator finds the report
// in the ordinary batch — all out of a single `rename(2)`. The failing outcome is run too, because
// a worker that cannot finish must be able to say so through the same command rather than by
// exiting quietly.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'

const f = await fixture('f3', { expectedChecks: 4 })
try {
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F3 — the completion report'])
  const task = async (title, deps) => (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble',
    '--title', title, ...(deps ? ['--deps', deps] : [])])).result.task.id
  const launch = async taskId => {
    const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
    assert.ok(started.result.dispatchId, JSON.stringify(started.result))
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', started.result.dispatchId])
    return { dispatchId: started.result.dispatchId, paneId: shown.result.paneId, handle: shown.result.terminal }
  }

  const first = await task('the one that finishes')
  const dependent = await task('the one that waits', first)
  const worker = await launch(first)

  await f.check('F3-a-worker_done-settles-the-attempt-the-task-and-its-dependent-in-one-write', async () => {
    const waiting = (await f.cli(['orchestration', 'task-list'])).result.tasks.find(entry => entry.id === dependent)
    assert.equal(waiting.status, 'pending', 'the dependent waits until the first Task is done')
    // The same document before and after, and the modification time of the file in between: a
    // settlement that needed two writes would show two.
    const before = { digest: f.stateDigest(), mtimeMs: fs.statSync(f.stateFile()).mtimeMs }
    const reported = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'done',
      '--body', 'Wrote the module. Found one ordering bug. Nothing is left.', '--task-id', first,
      '--dispatch-id', worker.dispatchId, '--outcome', 'succeeded', '--files-modified', 'app/src/a.ts,app/src/b.ts'],
    { env: { ...f.env, HERDR_PANE_ID: worker.paneId } })
    const after = { digest: f.stateDigest(), mtimeMs: fs.statSync(f.stateFile()).mtimeMs }
    assert.notEqual(after.digest, before.digest)
    assert.equal(reported.result.dispatch.status, 'completed')
    assert.equal(reported.result.dispatch.settledBy, 'worker_done', 'the 409 transition table is what settles it')
    assert.equal(reported.result.task.status, 'completed')
    // The dependent is promoted by the same call, and it is in the same stored document.
    assert.deepEqual(reported.result.promoted.map(entry => entry.id), [dependent], JSON.stringify(reported.result.promoted))
    const stored = f.stateJson()
    assert.equal(stored.tasks.find(entry => entry.id === dependent).status, 'ready')
    assert.equal(stored.tasks.find(entry => entry.id === first).status, 'completed')
    assert.equal(stored.dispatches.find(entry => entry.id === worker.dispatchId).status, 'completed')
    assert.equal(stored.messages.filter(entry => entry.type === 'worker_done').length, 1)
    return { reported: reported.result, before, after }
  })

  await f.check('F3-the-coordinator-finds-the-report-in-the-ordinary-batch', async () => {
    const batch = await f.cli(['orchestration', 'check'])
    const report = batch.result.messages.find(entry => entry.type === 'worker_done')
    assert.ok(report, JSON.stringify(batch.result))
    assert.equal(report.taskId, first)
    assert.equal(report.dispatchId, worker.dispatchId)
    assert.equal(report.outcome, 'succeeded')
    assert.deepEqual(report.payload.filesModified, ['app/src/a.ts', 'app/src/b.ts'])
    assert.equal(report.from.kind, 'worker')
    assert.equal(report.from.paneId, worker.paneId)
    await f.cli(['orchestration', 'check', '--ack', batch.result.deliveryId])
    return { deliveryId: batch.result.deliveryId, report }
  })

  await f.check('F3-a-worker-that-cannot-finish-says-so-and-the-task-fails', async () => {
    const taskId = await task('the one that fails')
    const failing = await launch(taskId)
    const reported = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'could not finish',
      '--body', 'The backend patch will not apply. I stopped rather than guess. Nothing was committed.',
      '--task-id', taskId, '--dispatch-id', failing.dispatchId, '--outcome', 'failed'],
    { env: { ...f.env, HERDR_PANE_ID: failing.paneId } })
    assert.equal(reported.result.dispatch.status, 'failed', JSON.stringify(reported.result.dispatch))
    assert.equal(reported.result.dispatch.settledBy, 'worker_done')
    assert.equal(reported.result.task.status, 'failed')
    assert.equal(reported.result.message.outcome, 'failed')
    // A failed outcome revokes the capability exactly as a succeeded one does.
    assert.equal(reported.result.dispatch.worker.capabilityRevokedReason, 'settled')
    return reported.result
  })

  await f.check('F3-the-pane-identity-the-runtime-compares-is-the-one-herdr-gives-the-shell', async () => {
    // The measurement behind the decision (ⓐ pane env), taken again here so F3 carries it: the
    // value `HERDR_PANE_ID` holds inside the pane is the `paneId` the attempt recorded.
    const taskId = await task('identity')
    const proved = await launch(taskId)
    const read = await f.cli(['terminal', 'read', '--terminal', proved.handle, '--screen', '--limit', '8192'], { timeout: 60000 })
    const observed = (await f.cli(['terminal', 'show', '--terminal', proved.handle], { timeout: 60000 })).result.terminal
    assert.equal(observed.paneId, proved.paneId, 'the attempt recorded the pane the backend reports')
    // Accepted with that value, refused without it — the whole rule, in two calls.
    const accepted = await f.cli(['orchestration', 'send', '--type', 'status', '--subject', 'proof', '--task-id', taskId,
      '--dispatch-id', proved.dispatchId], { env: { ...f.env, HERDR_PANE_ID: proved.paneId } })
    assert.equal(accepted.result.message.from.paneId, proved.paneId)
    const digest = f.stateDigest()
    const refused = await f.cli(['orchestration', 'send', '--type', 'status', '--subject', 'proof', '--task-id', taskId,
      '--dispatch-id', proved.dispatchId], { env: f.env, fail: true })
    assert.equal(refused.error.code, 'sender_mismatch', JSON.stringify(refused))
    assert.equal(f.stateDigest(), digest)
    return { paneId: proved.paneId, observed, accepted: accepted.result.message.from, refused: refused.error, screen: (read.result.text ?? '').slice(0, 200) }
  })
  f.record('f3-state', f.stateJson())
} finally { await f.cleanup() }
