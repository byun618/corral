// LIFE-410 F7 — recovery: which pane a release may close, and which it must leave alone.
//
// The whole table is exercised against a real backend, with `terminal list` as the witness for
// "the pane is gone" and "the pane is still there". The provider is the same stand-in F1 uses: a
// release decides on ownership and pane generation, never on what is running inside the pane.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'

const f = await fixture('f7', { expectedChecks: 9 })
try {
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F7 — recovery and ownership'])
  const task = async title => (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble', '--title', title])).result.task.id
  const asPane = paneId => ({ ...f.env, HERDR_PANE_ID: paneId })
  const start = async (taskId, extra = []) => {
    const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, ...extra], { timeout: 180000 })
    assert.ok(started.result.dispatchId, JSON.stringify(started.result))
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', started.result.dispatchId])
    return { ...started.result, paneId: shown.result.paneId, handle: shown.result.terminal }
  }
  const launch = taskId => start(taskId, ['--agent', 'claude', '--worktree', f.repo])
  const finish = async (taskId, worker) => f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'done',
    '--body', 'finished.', '--task-id', taskId, '--dispatch-id', worker.dispatchId, '--outcome', 'succeeded'], { env: asPane(worker.paneId) })
  const panes = async () => (await f.cli(['terminal', 'list'])).result.terminals.map(entry => entry.handle)

  await f.check('F7c-an-open-attempt-is-not-released', async () => {
    const taskId = await task('open')
    const worker = await launch(taskId)
    const before = f.stateDigest()
    const refused = await f.cli(['orchestration', 'worker-release', '--dispatch', worker.dispatchId], { fail: true })
    assert.equal(refused.error.code, 'dispatch_active', JSON.stringify(refused))
    assert.match(refused.error.resources.recovery, /worker-stop/)
    assert.equal(f.stateDigest(), before)
    // …and worker-stop is refused on an attempt that has already ended, which is the other half.
    await finish(taskId, worker)
    const late = await f.cli(['orchestration', 'worker-stop', '--dispatch', worker.dispatchId], { fail: true })
    assert.equal(late.error.code, 'dispatch_not_active', JSON.stringify(late))
    return { refused: refused.error, late: late.error, worker }
  })

  await f.check('F7a-an-owned-pane-whose-generation-matches-is-closed', async () => {
    const taskId = await task('owned')
    const worker = await launch(taskId)
    await finish(taskId, worker)
    const before = await panes()
    const released = await f.cli(['orchestration', 'worker-release', '--dispatch', worker.dispatchId], { timeout: 60000 })
    assert.equal(released.result.state, 'released', JSON.stringify(released.result))
    assert.equal(released.result.processAction, 'closed')
    assert.equal(released.result.reason, 'owned_generation_matches')
    const after = await panes()
    assert.ok(before.includes(worker.handle) && !after.includes(worker.handle), 'the owned pane must be gone')
    // Releasing again answers from the record and writes nothing at all.
    const digest = f.stateDigest()
    const again = await f.cli(['orchestration', 'worker-release', '--dispatch', worker.dispatchId])
    assert.equal(again.result.alreadyReleased, true, JSON.stringify(again.result))
    assert.equal(f.stateDigest(), digest)
    return { released: released.result, again: again.result, before: before.length, after: after.length }
  })

  await f.check('F7d-a-declared-retain-is-honoured-once-and-then-spent', async () => {
    const taskId = await task('retained')
    const worker = await launch(taskId)
    await finish(taskId, worker)
    const retained = await f.cli(['orchestration', 'worker-retain', '--dispatch', worker.dispatchId, '--reason', 'user_takeover'])
    assert.equal(retained.result.state, 'retained')
    assert.equal(retained.result.processAction, 'none')
    const first = await f.cli(['orchestration', 'worker-release', '--dispatch', worker.dispatchId], { timeout: 60000 })
    assert.equal(first.result.state, 'retained', JSON.stringify(first.result))
    assert.equal(first.result.reason, 'user_takeover')
    assert.ok((await panes()).includes(worker.handle), 'a retained pane must still be there')
    const second = await f.cli(['orchestration', 'worker-release', '--dispatch', worker.dispatchId], { timeout: 60000 })
    assert.equal(second.result.state, 'released', JSON.stringify(second.result))
    assert.ok(!(await panes()).includes(worker.handle), 'the second release closes it')
    return { retained: retained.result, first: first.result, second: second.result }
  })

  await f.check('F7e-a-pane-that-is-already-gone-is-retained-without-an-error', async () => {
    const taskId = await task('gone')
    const worker = await launch(taskId)
    await finish(taskId, worker)
    await f.cli(['terminal', 'close', '--terminal', worker.handle], { timeout: 60000 })
    const released = await f.cli(['orchestration', 'worker-release', '--dispatch', worker.dispatchId], { timeout: 60000 })
    assert.equal(released.result.state, 'retained', JSON.stringify(released.result))
    assert.equal(released.result.reason, 'pane_gone')
    assert.equal(released.result.processAction, 'none')
    return released.result
  })

  await f.check('F7b-re-using-a-pane-moves-ownership-and-the-old-release-closes-nothing', async () => {
    const taskOne = await task('first-owner')
    const first = await launch(taskOne)
    await finish(taskOne, first)
    const taskTwo = await task('second-owner')
    const second = await start(taskTwo, ['--terminal', first.handle])
    assert.equal(second.launch, 'reused')
    assert.equal(second.stages.terminal.action, 'reused')
    const shownSecond = await f.cli(['orchestration', 'worker-show', '--dispatch', second.dispatchId])
    assert.equal(shownSecond.result.worker.ownership, 'owned', 'the new attempt takes the pane over')
    assert.equal(shownSecond.result.worker.originDispatchId, first.dispatchId, 'it remembers who created the pane')
    const shownFirst = await f.cli(['orchestration', 'worker-show', '--dispatch', first.dispatchId])
    assert.equal(shownFirst.result.worker.ownership, 'borrowed', 'the old attempt gave the pane up')
    assert.equal(shownFirst.result.worker.ownershipTransferredTo, second.dispatchId)
    // The old attempt's release must not close the pane the new worker is using.
    const old = await f.cli(['orchestration', 'worker-release', '--dispatch', first.dispatchId], { timeout: 60000 })
    assert.equal(old.result.state, 'retained', JSON.stringify(old.result))
    assert.equal(old.result.reason, 'borrowed')
    assert.ok((await panes()).includes(first.handle), 'the pane the new worker holds must survive')
    // The current owner's release does close it, once its own attempt has ended.
    await finish(taskTwo, { ...second, paneId: shownSecond.result.paneId })
    const now = await f.cli(['orchestration', 'worker-release', '--dispatch', second.dispatchId], { timeout: 60000 })
    assert.equal(now.result.state, 'released', JSON.stringify(now.result))
    assert.ok(!(await panes()).includes(first.handle))
    return { first: shownFirst.result.worker, second: shownSecond.result.worker, old: old.result, now: now.result }
  })

  await f.check('F7-a-pane-no-attempt-owns-is-borrowed-and-is-never-closed', async () => {
    // A pane a person started themselves with `terminal create --agent`: corral did not launch it
    // for any attempt, so corral does not close it.
    const created = await f.cli(['terminal', 'create', '--worktree', f.repo, '--title', 'hand-started', '--agent', 'claude'], { timeout: 180000 })
    const handle = created.result.terminal.handle
    const taskId = await task('borrowed')
    const worker = await start(taskId, ['--terminal', handle])
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', worker.dispatchId])
    assert.equal(shown.result.worker.ownership, 'borrowed', JSON.stringify(shown.result.worker))
    assert.equal(shown.result.worker.originDispatchId, null)
    await finish(taskId, { ...worker, paneId: shown.result.paneId })
    const released = await f.cli(['orchestration', 'worker-release', '--dispatch', worker.dispatchId], { timeout: 60000 })
    assert.equal(released.result.state, 'retained', JSON.stringify(released.result))
    assert.equal(released.result.reason, 'borrowed')
    assert.ok((await panes()).includes(handle), 'a borrowed pane must survive its release')
    // A stop cannot claim it either, whatever the pane looks like.
    const taskAgain = await task('borrowed-stop')
    const again = await start(taskAgain, ['--terminal', handle])
    const refused = await f.cli(['orchestration', 'worker-stop', '--dispatch', again.dispatchId], { fail: true, timeout: 60000 })
    assert.equal(refused.error.code, 'identity_unproven', JSON.stringify(refused))
    assert.ok((await panes()).includes(handle), 'a refused stop must touch nothing')
    return { worker: shown.result.worker, released: released.result, refused: refused.error }
  })

  await f.check('F7b-a-retained-pane-is-still-owned-and-hands-itself-over-the-same-way', async () => {
    // A retain is not a handover. The attempt is over, the pane is still there, and it is still
    // the thing that may close it — so a re-use has to take ownership from it just as it would
    // from an attempt that was never retained. Reading "still owns it" as `release === null`
    // missed exactly this, so the transfer never happened and the first attempt's own release
    // closed a pane the second was working in (V2).
    const taskOne = await task('retained-owner')
    const first = await launch(taskOne)
    await finish(taskOne, first)
    await f.cli(['orchestration', 'worker-retain', '--dispatch', first.dispatchId, '--reason', 'user_requested'])
    const retained = await f.cli(['orchestration', 'worker-release', '--dispatch', first.dispatchId], { timeout: 60000 })
    assert.equal(retained.result.state, 'retained', JSON.stringify(retained.result))
    assert.equal(retained.result.reason, 'user_requested')
    assert.ok((await panes()).includes(first.handle), 'a retained pane stays')
    const afterRetain = await f.cli(['orchestration', 'worker-show', '--dispatch', first.dispatchId])
    assert.equal(afterRetain.result.worker.ownership, 'owned', 'a retain does not give the pane up')

    const taskTwo = await task('retained-reuse')
    const second = await start(taskTwo, ['--terminal', first.handle])
    assert.equal(second.launch, 'reused', JSON.stringify(second))
    const shownSecond = await f.cli(['orchestration', 'worker-show', '--dispatch', second.dispatchId])
    assert.equal(shownSecond.result.worker.ownership, 'owned', 'the new attempt takes the retained pane over')
    assert.equal(shownSecond.result.worker.originDispatchId, first.dispatchId)
    const shownFirst = await f.cli(['orchestration', 'worker-show', '--dispatch', first.dispatchId])
    assert.equal(shownFirst.result.worker.ownership, 'borrowed', 'the retained attempt gave the pane up')
    assert.equal(shownFirst.result.worker.ownershipTransferredTo, second.dispatchId)
    // The whole point: releasing the old attempt again must not close the pane the new worker has.
    const old = await f.cli(['orchestration', 'worker-release', '--dispatch', first.dispatchId], { timeout: 60000 })
    assert.equal(old.result.state, 'retained', JSON.stringify(old.result))
    assert.ok((await panes()).includes(first.handle), 'the pane the new worker holds must survive')
    return { retained: retained.result, first: shownFirst.result.worker, second: shownSecond.result.worker, old: old.result }
  })

  await f.check('F7-an-open-attempt-holds-its-pane-whether-or-not-it-owns-it', async () => {
    // Whether a pane is busy and who may close it are separate questions. A borrowed pane has no
    // owner at all and can still hold a worker mid-task, so asking the *owner* whether the pane was
    // free answered "nobody is here" for every borrowed pane — and a second Task was started on
    // top of a running one (V9).
    const created = await f.cli(['terminal', 'create', '--worktree', f.repo, '--title', 'busy-borrowed', '--agent', 'claude'], { timeout: 180000 })
    const handle = created.result.terminal.handle
    const taskOne = await task('borrowed-busy')
    const busy = await start(taskOne, ['--terminal', handle])
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', busy.dispatchId])
    assert.equal(shown.result.worker.ownership, 'borrowed', JSON.stringify(shown.result.worker))
    assert.equal(shown.result.dispatch.status, 'dispatched')
    const taskTwo = await task('borrowed-duplicate')
    const before = f.stateDigest()
    const refused = await f.cli(['orchestration', 'worker-start', '--task', taskTwo, '--terminal', handle], { fail: true, timeout: 180000 })
    assert.equal(refused.error.code, 'dispatch_active', JSON.stringify(refused))
    assert.equal(refused.error.resources.dispatchId, busy.dispatchId, JSON.stringify(refused.error.resources))
    assert.equal(refused._meta.outcome, 'not_started', JSON.stringify(refused._meta))
    assert.equal(f.stateDigest(), before, 'a refused re-use must not write')
    // …and once that attempt ends, the same pane takes the next Task.
    await finish(taskOne, { ...busy, paneId: shown.result.paneId })
    const next = await start(taskTwo, ['--terminal', handle])
    assert.equal(next.launch, 'reused', JSON.stringify(next))
    return { busy: shown.result.worker, refused: refused.error, next: next.dispatchId }
  })

  await f.check('F7fg-stop-closes-what-it-owns-and-abandon-touches-nothing', async () => {
    const taskId = await task('stop')
    const worker = await launch(taskId)
    const stopped = await f.cli(['orchestration', 'worker-stop', '--dispatch', worker.dispatchId], { timeout: 60000 })
    assert.equal(stopped.result.state, 'released', JSON.stringify(stopped.result))
    assert.equal(stopped.result.dispatch.status, 'failed')
    assert.equal(stopped.result.dispatch.settledBy, 'task-update')
    assert.equal(stopped.result.task.result.reason, 'worker_stopped')
    assert.ok(!(await panes()).includes(worker.handle), 'a stopped worker loses its pane')

    const abandonTask = await task('abandon')
    const abandoned = await launch(abandonTask)
    const before = await panes()
    const result = await f.cli(['orchestration', 'worker-abandon', '--dispatch', abandoned.dispatchId])
    assert.equal(result.result.state, 'retained')
    assert.equal(result.result.reason, 'abandoned')
    assert.equal(result.result.dispatch.worker.release.processAction, 'none')
    assert.deepEqual(await panes(), before, 'abandon must leave every pane exactly where it was')
    return { stopped: stopped.result, abandoned: result.result }
  })
  f.record('f7-state', f.stateJson())
  f.record('f7-worker-list', (await f.cli(['orchestration', 'worker-list', '--limit', '100'])).result)
} finally { await f.cleanup() }
