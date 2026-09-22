// LIFE-409 F1 — creation, listing, counts and the profile-wide Run binding.
// No backend is needed: a profile with no open attempt never contacts one.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fixture } from './lib.mjs'

const f = await fixture('f1')
try {
  await f.serve()

  await f.check('F1a-empty-profile-has-no-run-and-refuses-task-list', async () => {
    const current = await f.cli(['orchestration', 'run-current'])
    assert.equal(current.result.run, null)
    const refused = await f.cli(['orchestration', 'task-list'], { fail: true })
    assert.equal(refused.error.code, 'run_required')
    assert.equal(refused._meta.outcome, 'not_started')
    assert.match(String(refused.error.resources.recovery), /run-create/)
    // Nothing was written: the document does not exist yet at all.
    assert.equal(fs.existsSync(f.stateFile()), false, 'run_required must leave no trace')
    return { current, refused, stateFileExists: false }
  })

  const ids = {}
  await f.check('F1b-run-create-binds-and-run-current-returns-it', async () => {
    const created = await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 F1'])
    ids.runA = created.result.run.id
    assert.match(ids.runA, /^run_[0-9a-f]{12}$/)
    assert.equal(created.result.currentRunId, ids.runA)
    const current = await f.cli(['orchestration', 'run-current'])
    assert.equal(current.result.run.id, ids.runA)
    assert.equal(current.result.run.version, 1)
    return { created, current }
  })

  await f.check('F1c-deps-decide-ready-versus-pending', async () => {
    const free = await f.cli(['orchestration', 'task-create', '--spec', 'no dependencies', '--title', 'free'])
    ids.free = free.result.task.id
    assert.equal(free.result.task.status, 'ready')
    assert.deepEqual(free.result.task.deps, [])
    const blockedByDep = await f.cli(['orchestration', 'task-create', '--spec', 'waits for the first', '--deps', ids.free])
    ids.dependent = blockedByDep.result.task.id
    assert.equal(blockedByDep.result.task.status, 'pending')
    assert.deepEqual(blockedByDep.result.task.deps, [ids.free], 'deps is a real array, not a JSON string')
    const ready = await f.cli(['orchestration', 'task-list', '--ready'])
    assert.deepEqual(ready.result.tasks.map(task => task.id), [ids.free])
    const all = await f.cli(['orchestration', 'task-list'])
    assert.deepEqual(all.result.tasks.map(task => task.id), [ids.free, ids.dependent])
    assert.equal(all.result.totalCount, 2)
    const filtered = await f.cli(['orchestration', 'task-list', '--status', 'pending'])
    assert.deepEqual(filtered.result.tasks.map(task => task.id), [ids.dependent])
    return { free, blockedByDep, ready, all, filtered }
  })

  await f.check('F1d-run-show-counts-match-the-listing', async () => {
    const shown = await f.cli(['orchestration', 'run-show', '--id', ids.runA])
    assert.deepEqual(shown.result.counts.tasks, { pending: 1, ready: 1, dispatched: 0, completed: 0, failed: 0, blocked: 0, total: 2 })
    assert.deepEqual(shown.result.counts.dispatches, { dispatched: 0, completed: 0, failed: 0, unknown: 0, total: 0 })
    const missing = await f.cli(['orchestration', 'run-show', '--id', 'run_' + 'f'.repeat(12)], { fail: true })
    assert.equal(missing.error.code, 'run_not_found')
    return { shown, missing }
  })

  await f.check('F1e---run-selects-without-rebinding-and-run-use-rebinds', async () => {
    const second = await f.cli(['orchestration', 'run-create', '--objective', 'second run'])
    ids.runB = second.result.run.id
    assert.equal((await f.cli(['orchestration', 'run-current'])).result.run.id, ids.runB, 'run-create rebinds')
    // A --run selection answers about that Run and leaves the binding alone.
    const scoped = await f.cli(['orchestration', 'task-list', '--run', ids.runA])
    assert.deepEqual(scoped.result.tasks.map(task => task.id), [ids.free, ids.dependent])
    const stillB = await f.cli(['orchestration', 'run-current'])
    assert.equal(stillB.result.run.id, ids.runB, '--run must not rebind the profile')
    const emptyB = await f.cli(['orchestration', 'task-list'])
    assert.deepEqual(emptyB.result.tasks, [])
    const rebound = await f.cli(['orchestration', 'run-use', '--id', ids.runA])
    assert.equal(rebound.result.currentRunId, ids.runA)
    assert.equal((await f.cli(['orchestration', 'run-current'])).result.run.id, ids.runA)
    const unknownRun = await f.cli(['orchestration', 'run-use', '--id', 'run_' + '0'.repeat(12)], { fail: true })
    assert.equal(unknownRun.error.code, 'run_not_found')
    assert.equal((await f.cli(['orchestration', 'run-current'])).result.run.id, ids.runA, 'a failed run-use keeps the binding')
    const list = await f.cli(['orchestration', 'run-list'])
    assert.deepEqual(list.result.runs.map(run => run.id), [ids.runB, ids.runA], 'newest first')
    assert.equal(list.result.totalCount, 2)
    const limited = await f.cli(['orchestration', 'run-list', '--limit', '1'])
    assert.deepEqual(limited.result.runs.map(run => run.id), [ids.runB])
    assert.equal(limited.result.truncated, true)
    return { second, scoped, stillB, emptyB, rebound, unknownRun, list, limited }
  })

  await f.check('F1f-cross-run-task-lookup-is-task_not_found', async () => {
    const crossed = await f.cli(['orchestration', 'task-update', '--run', ids.runB, '--id', ids.free, '--status', 'blocked'], { fail: true })
    assert.equal(crossed.error.code, 'task_not_found')
    assert.equal(crossed._meta.outcome, 'not_started')
    return { crossed }
  })

  f.record('state-after-f1', f.stateJson())
} finally { await f.cleanup() }
