// LIFE-409 F7 — concurrent and repeated transitions. Exactly one of N racing updates takes
// effect; a repeated request id replays its first answer; the same id with different input
// conflicts; a receipt that is still pending is unknown and is never re-executed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture, requestId } from './lib.mjs'

const RACERS = 6
const f = await fixture('f7')
try {
  await f.startBackend()
  await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 F7 idempotency'])

  /** A task already bound to a live pane, ready to be settled. */
  const dispatchedTask = async (name) => {
    const task = await f.cli(['orchestration', 'task-create', '--spec', name])
    const pane = await f.pane(name)
    const dispatched = await f.cli(['orchestration', 'dispatch', '--task', task.result.task.id, '--to', pane.handle])
    return { taskId: task.result.task.id, dispatchId: dispatched.result.dispatch.id, version: dispatched.result.task.version }
  }

  await f.check('F7a-six-racing-updates-take-effect-exactly-once', async () => {
    const subject = await dispatchedTask('f7-race')
    const args = ['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed']
    // Distinct request ids, so this is a race between six different requests, not a replay.
    const results = await Promise.all(Array.from({ length: RACERS }, () => f.cliRaw([...args, '--request-id', requestId()])))
    const winners = results.filter(entry => entry.json?.ok === true)
    const losers = results.filter(entry => entry.json?.ok === false)
    assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`)
    assert.equal(losers.length, RACERS - 1)
    for (const loser of losers) {
      assert.ok(['illegal_transition', 'version_conflict'].includes(loser.json.error.code), loser.json.error.code)
      assert.equal(loser.json._meta.outcome, 'not_started')
    }
    const after = f.stateJson().tasks.find(entry => entry.id === subject.taskId)
    assert.equal(after.status, 'completed')
    assert.equal(after.version, subject.version + 1, 'exactly one version step for N racing updates')
    return { codes: losers.map(entry => entry.json.error.code), version: after.version, winner: winners[0].json.result.task }
  })

  await f.check('F7b-an-old---expected-version-is-version_conflict-and-changes-nothing', async () => {
    const subject = await dispatchedTask('f7-version')
    await f.cli(['orchestration', 'run-current'])
    const before = f.stateDigest()
    const stale = await f.cli(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed', '--expected-version', '1'], { fail: true })
    assert.equal(stale.error.code, 'version_conflict')
    assert.equal(stale.error.resources.currentVersion, subject.version)
    assert.equal(stale.error.resources.expectedVersion, 1)
    assert.equal(f.stateDigest(), before)
    const correct = await f.cli(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed', '--expected-version', String(subject.version)])
    assert.equal(correct.result.task.version, subject.version + 1)
    return { stale, correct }
  })

  await f.check('F7c-the-same-request-id-replays-and-changes-nothing', async () => {
    const subject = await dispatchedTask('f7-replay')
    const id = requestId()
    const args = ['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed', '--request-id', id]
    const first = await f.cli(args)
    assert.equal(first.result.replayed, false)
    assert.equal(first.result.requestId, id)
    const digest = f.stateDigest()
    const replay = await f.cli(args)
    assert.equal(replay.result.replayed, true)
    assert.deepEqual(replay.result.task, first.result.task)
    assert.equal(f.stateDigest(), digest, 'a replay must not rewrite the document')
    return { first, replay, digest }
  })

  await f.check('F7d-the-same-id-with-different-input-is-request_conflict', async () => {
    const subject = await dispatchedTask('f7-conflict')
    const id = requestId()
    await f.cli(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed', '--request-id', id])
    await f.cli(['orchestration', 'run-current'])
    const before = f.stateDigest()
    const conflict = await f.cli(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'failed', '--request-id', id], { fail: true })
    assert.equal(conflict.error.code, 'request_conflict')
    assert.equal(f.stateDigest(), before)
    // The same rule covers creation, not only transitions.
    const createId = requestId()
    const created = await f.cli(['orchestration', 'task-create', '--spec', 'once', '--request-id', createId])
    const replayedCreate = await f.cli(['orchestration', 'task-create', '--spec', 'once', '--request-id', createId])
    assert.equal(replayedCreate.result.replayed, true)
    assert.equal(replayedCreate.result.task.id, created.result.task.id)
    const changedCreate = await f.cli(['orchestration', 'task-create', '--spec', 'different body', '--request-id', createId], { fail: true })
    assert.equal(changedCreate.error.code, 'request_conflict')
    const tasksNamedOnce = f.stateJson().tasks.filter(entry => entry.spec === 'once')
    assert.equal(tasksNamedOnce.length, 1, 'a replayed create must not create a second task')
    return { conflict, created, replayedCreate, changedCreate }
  })

  await f.check('F7e-a-pending-receipt-is-outcome_unknown-and-is-never-re-executed', async () => {
    const subject = await dispatchedTask('f7-pending')
    const id = requestId()
    const args = ['orchestration', 'task-update', '--id', subject.taskId, '--status', 'blocked', '--request-id', id]
    await f.cli(args)
    const receipt = path.join(f.env.CORRAL_USER_DATA, 'runtime/terminal-receipts', id + '.json')
    const stored = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    // Rewind the receipt to the state a crash between admission and completion would leave.
    fs.writeFileSync(receipt, JSON.stringify({ hash: stored.hash, state: 'pending', createdAt: stored.createdAt }))
    await f.cli(['orchestration', 'run-current'])
    const before = f.stateDigest()
    const unknown = await f.cli(args, { fail: true })
    assert.equal(unknown.error.code, 'outcome_unknown')
    assert.equal(unknown.error.stage, 'receipt')
    assert.equal(unknown._meta.outcome, 'unknown')
    assert.equal(f.stateDigest(), before, 'a pending receipt must not be re-executed')
    assert.match(String(unknown.error.resources.recovery), /orchestration/)
    // And a lost receipt for an admitted id is refused the same way, not re-run.
    fs.unlinkSync(receipt)
    const lost = await f.cli(args, { fail: true })
    assert.equal(lost.error.code, 'outcome_unknown')
    assert.equal(f.stateDigest(), before)
    return { stored, unknown, lost, digest: before }
  })

  await f.check('F7f-a-mint-free-call-still-gets-a-request-id', async () => {
    const subject = await dispatchedTask('f7-minted')
    const response = await f.cli(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed'])
    assert.match(response.result.requestId, /^r1\.\d{13}\.[0-9a-f-]{36}$/)
    assert.equal(response.result.replayed, false)
    return { response }
  })

  f.record('state-after-f7', f.stateJson())
} finally { await f.cleanup() }
