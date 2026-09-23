// LIFE-410 F9 — one pane, two Tasks: what a re-used worker keeps and what it must not.
//
// Re-use is the case where a stale id is most likely to be used by accident, because the pane, the
// provider and the session are all still the ones the first attempt talked to. The record is what
// separates them: the second attempt is `attempt 1` of its own Task, the pane's ownership moves to
// it, and a report naming the attempt that finished first is `stale_dispatch` and stores nothing.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'

const f = await fixture('f9', { expectedChecks: 5 })
try {
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F9 — re-using a worker'])
  const task = async title => (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble', '--title', title])).result.task.id
  const asPane = paneId => ({ ...f.env, HERDR_PANE_ID: paneId })
  const show = async dispatchId => (await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])).result
  const finish = (taskId, dispatchId, paneId) => f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'done',
    '--body', 'finished.', '--task-id', taskId, '--dispatch-id', dispatchId, '--outcome', 'succeeded'], { env: asPane(paneId) })

  const firstTask = await task('the first job')
  const firstStart = await f.cli(['orchestration', 'worker-start', '--task', firstTask, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
  const first = { dispatchId: firstStart.result.dispatchId, ...await show(firstStart.result.dispatchId) }
  assert.ok(first.dispatchId, JSON.stringify(firstStart.result))
  const handle = first.terminal
  await finish(firstTask, first.dispatchId, first.paneId)

  const secondTask = await task('the second job')
  const secondStart = await f.check('F9-a-second-task-into-the-same-pane-is-attempt-1-of-its-own-dispatch', async () => {
    const started = await f.cli(['orchestration', 'worker-start', '--task', secondTask, '--terminal', handle], { timeout: 180000 })
    assert.notEqual(started.result.dispatchId, first.dispatchId, 'a re-used pane still gets its own attempt')
    assert.equal(started.result.launch, 'reused')
    assert.equal(started.result.stages.terminal.action, 'reused')
    assert.equal(started.result.dispatch.attempt, 1, 'attempt counts within a Task, and this Task has had one')
    // Nothing about the pane's agent is re-requested: the snapshot is the one it was started with.
    const shown = await show(started.result.dispatchId)
    assert.equal(shown.dispatch.agent.kind, 'claude')
    assert.equal(shown.paneId, first.paneId, 'the same pane, by identity')
    return started.result
  })
  const second = { dispatchId: secondStart.dispatchId, ...await show(secondStart.dispatchId) }

  await f.check('F9-a-second-start-resumes-the-same-attempt-rather-than-making-another', async () => {
    // What a stand-in provider can show here is the resume, not the submission. This fixture's
    // `claude` passes the pane's liveness checks but not the agent-ready gate, so `stages.input`
    // never completes — which is the product being right, not the fixture being weak.
    const input = secondStart.stages.input
    // `not_started` when the readiness gate simply never held, `failed` when the backend refused the
    // submission outright (this stand-in execs `sleep`, so the pane's foreground stops being the
    // agent). Either way nothing reached the pane, which is what the next assertions are about.
    assert.ok(['not_started', 'failed'].includes(input.status), JSON.stringify(secondStart.stages))
    // The digest of the body is recorded when the attempt is created, before anything is sent — it
    // is what a resume compares against (V4). What says a body was *delivered* is
    // `promptRequestId`, and nothing was delivered here.
    assert.match(second.worker.preambleSha256, /^[0-9a-f]{64}$/, JSON.stringify(second.worker))
    assert.equal(second.worker.promptRequestId, null, 'nothing was delivered, so nothing is recorded as delivered')
    // Calling again for that Task resumes into the same attempt — the documented exception to
    // once-per-Dispatch, and the only reason it applies is that nothing was submitted yet. A Task
    // whose preamble *was* delivered answers task_not_startable(dispatch_active); that needs a real
    // provider to reach, and `native.mjs` is where it is measured.
    const dispatches = f.stateJson().dispatches.length
    const resumed = await f.cli(['orchestration', 'worker-start', '--task', secondTask, '--terminal', handle], { timeout: 180000 })
    assert.equal(resumed.result.dispatchId, second.dispatchId, 'a resume never opens a second attempt')
    assert.equal(f.stateJson().dispatches.length, dispatches, 'and never adds a record')
    assert.equal(resumed.result.stages.dispatch.dispatchId, second.dispatchId, JSON.stringify(resumed.result.stages))
    assert.equal(resumed.result.launch, 'resumed', JSON.stringify(resumed.result))
    // The body the resume would deliver is the one the attempt was created against, unchanged.
    const after = await show(second.dispatchId)
    assert.equal(after.worker.preambleSha256, second.worker.preambleSha256, 'a resume must not rebuild a different body')
    return { input, preambleSha256: second.worker.preambleSha256, resumed: resumed.result }
  })

  await f.check('F9-a-reused-pane-started-from-a-file-resumes-from-that-file', async () => {
    // V26, on the reuse path. An attempt whose body came from `--spec-file` was unresumable in r1 —
    // the resume rebuilt from `task.spec`, so the digest never matched and the only way out was to
    // kill a worker that might be mid-task. The file is read at resume time and *compared*, so the
    // same file resumes and a changed one is still refused (V4 intact).
    const third = (await f.cli(['orchestration', 'task-create', '--spec', 'the stored task spec', '--title', 'from-file'])).result.task.id
    const file = path.join(f.root, 'f9-spec.md')
    fs.writeFileSync(file, 'the body that only this file holds\n')
    // The pane is busy with `secondTask`, so this attempt gets a pane of its own.
    const made = await f.cli(['orchestration', 'worker-start', '--task', third, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', file], { timeout: 180000 })
    assert.equal(made.result.state, 'incomplete', JSON.stringify(made.result))
    const dispatches = f.stateJson().dispatches.length
    const resumed = await f.cli(['orchestration', 'worker-start', '--task', third, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', file], { timeout: 180000 })
    assert.equal(resumed.result.launch, 'resumed', JSON.stringify(resumed.result))
    assert.equal(resumed.result.dispatchId, made.result.dispatchId)
    assert.ok(!resumed.result.ignoredOptions.includes('--spec-file'), JSON.stringify(resumed.result.ignoredOptions))
    assert.equal(f.stateJson().dispatches.length, dispatches, 'a resume never adds a record')
    fs.writeFileSync(file, 'a body that is not the one this attempt was made against\n')
    const before = f.stateDigest()
    const refused = await f.cli(['orchestration', 'worker-start', '--task', third, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', file], { fail: true, timeout: 180000 })
    assert.equal(refused.error.code, 'preamble_mismatch', JSON.stringify(refused))
    assert.equal(f.stateDigest(), before, 'a refused resume must not write')
    await f.cli(['orchestration', 'worker-stop', '--dispatch', made.result.dispatchId], { timeout: 60000 })
    return { made: made.result.state, resumed: resumed.result.launch, refused: refused.error }
  })

  await f.check('F9-the-old-attempt-id-is-stale-and-the-new-one-settles', async () => {
    const digest = f.stateDigest()
    const stale = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'wrong attempt',
      '--body', 'x', '--task-id', firstTask, '--dispatch-id', first.dispatchId, '--outcome', 'succeeded'],
    { env: asPane(first.paneId), fail: true })
    assert.equal(stale.error.code, 'illegal_transition', JSON.stringify(stale))
    // …and naming the first attempt under the *second* Task is a mismatch, not a transition at all.
    const crossed = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'wrong pairing',
      '--body', 'x', '--task-id', secondTask, '--dispatch-id', first.dispatchId, '--outcome', 'succeeded'],
    { env: asPane(first.paneId), fail: true })
    assert.equal(crossed.error.code, 'sender_mismatch', JSON.stringify(crossed))
    assert.equal(f.stateDigest(), digest, 'neither refusal stores anything')
    const settled = await finish(secondTask, second.dispatchId, second.paneId)
    assert.equal(settled.result.dispatch.status, 'completed')
    assert.equal(settled.result.dispatch.settledBy, 'worker_done')
    assert.equal(settled.result.task.status, 'completed')
    return { stale: stale.error, crossed: crossed.error, settled: settled.result }
  })

  await f.check('F9-worker-list-shows-both-attempts-and-where-the-pane-went', async () => {
    const listed = (await f.cli(['orchestration', 'worker-list', '--limit', '100'])).result
    const rows = Object.fromEntries(listed.workers.map(entry => [entry.dispatchId, entry]))
    assert.ok(rows[first.dispatchId] && rows[second.dispatchId], JSON.stringify(listed))
    assert.equal(rows[first.dispatchId].worker.ownership, 'borrowed', 'the first attempt gave the pane up')
    assert.equal(rows[first.dispatchId].worker.ownershipTransferredTo, second.dispatchId)
    assert.equal(rows[second.dispatchId].worker.ownership, 'owned')
    assert.equal(rows[second.dispatchId].worker.originDispatchId, first.dispatchId, 'the new owner remembers who created the pane')
    assert.equal(rows[first.dispatchId].terminal, rows[second.dispatchId].terminal, 'one pane, two attempts')
    // The release that matters is the current owner's; the first attempt's closes nothing.
    const old = await f.cli(['orchestration', 'worker-release', '--dispatch', first.dispatchId], { timeout: 60000 })
    assert.equal(old.result.state, 'retained')
    assert.equal(old.result.reason, 'borrowed')
    const panes = async () => (await f.cli(['terminal', 'list'])).result.terminals.map(entry => entry.handle)
    assert.ok((await panes()).includes(handle))
    const now = await f.cli(['orchestration', 'worker-release', '--dispatch', second.dispatchId], { timeout: 60000 })
    assert.equal(now.result.state, 'released')
    assert.ok(!(await panes()).includes(handle), 'the owner closes it')
    return { first: rows[first.dispatchId], second: rows[second.dispatchId], old: old.result, now: now.result }
  })
  f.record('f9-state', f.stateJson())
} finally { await f.cleanup() }
