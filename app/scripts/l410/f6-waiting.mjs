// LIFE-410 F6 — waiting, the lane, and the time ceiling.
//
// (b) is the check this whole design exists for: while a coordinator is blocked in
// `check --block`, another orchestration command must run *immediately*, not when the wait ends.
// The proof is timestamps — the second command's own wall-clock duration, measured while the first
// one is provably still blocked — because a lane that was held would make it wait out the deadline.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'

const f = await fixture('f6', { expectedChecks: 6 })
const ms = async body => { const at = Date.now(); const value = await body(); return { value, elapsed: Date.now() - at } }
try {
  // (d) needs a worker pane of its own, so this fixture carries the same stand-in provider the
  // others do — first on this fixture's PATH only, nothing global touched.
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  await f.serve()
  await f.registerRepo()
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

  await f.check('F6d-a-cancelled-wait-consumes-nothing-and-the-next-call-gets-it-all', async () => {
    // Ctrl-C on a `check --block`. The earlier shape of this check sent the message *before* the
    // block, so the call returned with a batch at once and the signal landed on a process that had
    // already exited — it measured nothing (V13). The wait has to be a real wait, so the mailbox is
    // emptied first and the signal is sent while the call is still blocked; that the cancellation
    // happened at all is then asserted rather than assumed.
    const outstanding = (await f.cli(['orchestration', 'check'])).result.deliveryId
    if (outstanding !== null) await f.cli(['orchestration', 'check', '--ack', outstanding])
    const before = f.stateDigest()
    let child
    const cancelled = f.cliRaw(['orchestration', 'check', '--block', '--timeout-ms', '600000'],
      { timeout: 60000, onSpawn: value => { child = value } })
    await f.until(() => child !== undefined, 'check child spawned')
    await f.pause(1500)
    assert.equal(child.exitCode, null, 'the block has to still be waiting when the signal arrives')
    child.kill('SIGINT')
    const outcome = await cancelled
    assert.ok(outcome.signal === 'SIGINT' || outcome.exit !== 0, `the wait was not cancelled: ${JSON.stringify(outcome)}`)
    // A wait that ended this way took nothing: no Delivery was opened and the document did not move.
    assert.equal(f.stateDigest(), before, 'a cancelled wait must leave the stored bytes untouched')
    assert.equal((await f.cli(['orchestration', 'inbox'])).result.outstandingDeliveryId, null, 'a cancelled wait must open no Delivery')
    // …and the message that arrives afterwards is delivered whole to the next call.
    await f.cli(['orchestration', 'send', '--type', 'status', '--subject', 'survives-cancel'])
    const after = await f.cli(['orchestration', 'check'])
    assert.ok(after.result.messages.some(entry => entry.subject === 'survives-cancel'), JSON.stringify(after.result.messages.map(entry => entry.subject)))
    await f.cli(['orchestration', 'check', '--ack', after.result.deliveryId])
    return { cancelledExit: outcome.exit, cancelledSignal: outcome.signal, cancelledStdout: outcome.stdout.slice(0, 400), count: after.result.count }
  })

  await f.check('F6d-a-cancelled-ask-is-resumed-and-creates-no-second-question', async () => {
    // The same cancellation on the other waiting command. An `ask` stores its question before it
    // waits, so Ctrl-C leaves an answerable question rather than a lost one — and the resume
    // collects the answer without asking again.
    const taskId = (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble', '--title', 'cancelled-ask'])).result.task.id
    const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
    const dispatchId = started.result.dispatchId
    assert.ok(dispatchId, JSON.stringify(started.result))
    const paneId = (await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])).result.paneId
    const pane = { ...f.env, HERDR_PANE_ID: paneId }
    const before = f.stateJson().messages.length
    let child
    const asking = f.cliRaw(['orchestration', 'ask', '--question', 'is a cancelled ask still answerable?',
      '--task-id', taskId, '--dispatch-id', dispatchId, '--timeout-ms', '600000'],
    { env: pane, timeout: 60000, onSpawn: value => { child = value } })
    await f.until(() => child !== undefined, 'ask child spawned')
    await f.until(() => f.stateJson().messages.length > before, 'the question is stored before the wait')
    await f.pause(500)
    child.kill('SIGINT')
    const outcome = await asking
    assert.ok(outcome.signal === 'SIGINT' || outcome.exit !== 0, `the ask was not cancelled: ${JSON.stringify(outcome)}`)
    const question = f.stateJson().messages.filter(entry => entry.type === 'question' && entry.dispatchId === dispatchId).at(-1)
    assert.ok(question, 'the cancelled ask must leave its question behind')
    const stored = f.stateJson().messages.length
    await f.cli(['orchestration', 'reply', '--id', question.id, '--body', 'it is'])
    const resumed = await f.cli(['orchestration', 'ask', '--resume', question.id, '--task-id', taskId,
      '--dispatch-id', dispatchId, '--timeout-ms', '30000'], { env: pane, timeout: 60000 })
    assert.equal(resumed.result.state, 'answered', JSON.stringify(resumed.result))
    assert.equal(resumed.result.reply.body, 'it is')
    assert.equal(f.stateJson().messages.filter(entry => entry.type === 'question' && entry.dispatchId === dispatchId).length, 1,
      'a resume must not create a second question')
    return { cancelledExit: outcome.exit, cancelledSignal: outcome.signal, questionId: question.id, storedBeforeReply: stored, resumed: resumed.result.state }
  })
  f.record('f6-state', f.stateJson())
} finally { await f.cleanup() }
