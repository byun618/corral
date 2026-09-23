// LIFE-410 F6 — waiting, the lane, and the time ceiling.
//
// (b) is the check this whole design exists for: while a coordinator is blocked in
// `check --block`, another orchestration command must run *immediately*, not when the wait ends.
// The proof is timestamps — the second command's own wall-clock duration, measured while the first
// one is provably still blocked — because a lane that was held would make it wait out the deadline.
import assert from 'node:assert/strict'
import { fixture } from './lib.mjs'

const f = await fixture('f6', { expectedChecks: 5 })
const ms = async body => { const at = Date.now(); const value = await body(); return { value, elapsed: Date.now() - at } }
try {
  await f.startBackend()
  await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F6 — waiting and the lane'])

  await f.check('F6a-an-empty-wait-ends-at-its-deadline-as-a-normal-answer', async () => {
    const waited = await ms(() => f.cli(['orchestration', 'check', '--block', '--timeout-ms', '5000'], { timeout: 30000 }))
    assert.equal(waited.value.result.count, 0, JSON.stringify(waited.value.result))
    assert.equal(waited.value.result.timedOut, true)
    assert.equal(waited.value.ok, true, 'a deadline is an answer, not an error')
    assert.ok(waited.elapsed >= 4000 && waited.elapsed < 20000, `waited ${waited.elapsed}ms`)
    return { elapsed: waited.elapsed, result: waited.value.result }
  })

  await f.check('F6b-a-blocked-wait-holds-no-lane', async () => {
    // Start a ten-minute wait and let it get as far as its first poll.
    const started = Date.now()
    let finished = null
    // A rejection is captured rather than left floating: an unhandled one would end the run before
    // the finally block could write down what happened.
    const waiting = f.cli(['orchestration', 'check', '--block', '--timeout-ms', '600000', '--types', 'worker_done,escalation,question,status'], { timeout: 620000 })
      .then(value => { finished = Date.now(); return value }, error => { finished = Date.now(); return { failed: String(error) } })
    await f.pause(1500)
    assert.equal(finished, null, 'the wait must still be blocked when the concurrent commands run')

    // A read and a write, both while that wait is provably still in flight.
    const read = await ms(() => f.cli(['orchestration', 'task-list']))
    const write = await ms(() => f.cli(['orchestration', 'send', '--type', 'status', '--subject', 'unblock', '--body', 'sent while check --block was waiting']))
    assert.ok(read.elapsed < 10000, `task-list took ${read.elapsed}ms behind a ten-minute wait`)
    assert.ok(write.elapsed < 10000, `send took ${write.elapsed}ms behind a ten-minute wait`)

    // …and the wait then returns that very message rather than timing out ten minutes later.
    const delivered = await waiting
    const elapsed = (finished ?? Date.now()) - started
    assert.ok(delivered.result !== undefined, `the waiting check failed: ${JSON.stringify(delivered)}`)
    assert.equal(delivered.result.count, 1, JSON.stringify(delivered.result))
    assert.equal(delivered.result.messages[0].subject, 'unblock')
    assert.equal(delivered.result.timedOut, false)
    assert.ok(elapsed < 60000, `the wait ended after ${elapsed}ms, which is not "as soon as the message arrived"`)
    return { readElapsed: read.elapsed, writeElapsed: write.elapsed, waitElapsed: elapsed, delivered: delivered.result }
  })

  await f.check('F6c-only-the-two-waiting-commands-may-ask-for-ten-minutes', async () => {
    const accepted = await f.cli(['orchestration', 'check', '--timeout-ms', '600000'])
    const refusedCheck = await f.cli(['orchestration', 'check', '--timeout-ms', '600001'], { fail: true })
    assert.equal(refusedCheck.error.code, 'invalid_argument', JSON.stringify(refusedCheck))
    assert.match(refusedCheck.error.message, /1\.\.600000/)
    const refusedOther = await f.cli(['orchestration', 'task-list', '--timeout-ms', '120001'], { fail: true })
    assert.equal(refusedOther.error.code, 'invalid_argument', JSON.stringify(refusedOther))
    assert.match(refusedOther.error.message, /1\.\.120000/)
    const otherAccepted = await f.cli(['orchestration', 'task-list', '--timeout-ms', '120000'])
    assert.equal(otherAccepted.ok, true)
    // A terminal command keeps its own ceiling too.
    const terminal = await f.cli(['terminal', 'list', '--timeout-ms', '120001'], { fail: true })
    assert.equal(terminal.error.code, 'invalid_argument')
    return { accepted: accepted.ok, refusedCheck: refusedCheck.error, refusedOther: refusedOther.error, terminal: terminal.error }
  })

  await f.check('F6c-ask-shares-the-same-ceiling', async () => {
    // The ceiling is decided before anything is looked up, so it answers even for ids that do not
    // exist: this is the argument rule, not the sender rule.
    const refused = await f.cli(['orchestration', 'ask', '--question', 'q', '--task-id', 'task_0123456789ab',
      '--dispatch-id', 'ctx_0123456789ab', '--timeout-ms', '600001'], { fail: true })
    assert.equal(refused.error.code, 'invalid_argument', JSON.stringify(refused))
    assert.match(refused.error.message, /1\.\.600000/)
    return refused.error
  })

  await f.check('F6d-a-cancelled-wait-leaves-its-delivery-for-the-next-call', async () => {
    // Ctrl-C on a `check --block` that already opened a batch: the batch stays outstanding and the
    // next check replays it rather than losing the messages it named.
    // Clear whatever batch is outstanding first, or the replay rule (correctly) hands that one
    // back instead of the message this check is about.
    const outstanding = (await f.cli(['orchestration', 'check'])).result.deliveryId
    if (outstanding !== null) await f.cli(['orchestration', 'check', '--ack', outstanding])
    await f.cli(['orchestration', 'send', '--type', 'status', '--subject', 'survives-cancel'])
    let child
    const cancelled = f.cliRaw(['orchestration', 'check', '--block', '--timeout-ms', '600000'],
      { timeout: 60000, onSpawn: value => { child = value } })
    await f.until(() => child !== undefined, 'check child spawned')
    await f.pause(1200)
    child.kill('SIGINT')
    const outcome = await cancelled
    const after = await f.cli(['orchestration', 'check'])
    assert.ok(after.result.count >= 1, JSON.stringify(after.result))
    assert.ok(after.result.messages.some(entry => entry.subject === 'survives-cancel'), JSON.stringify(after.result.messages.map(entry => entry.subject)))
    return { cancelledExit: outcome.exit, cancelledStdout: outcome.stdout.slice(0, 400), replayed: after.result.deliveryReplayed, count: after.result.count }
  })
  f.record('f6-state', f.stateJson())
} finally { await f.cleanup() }
