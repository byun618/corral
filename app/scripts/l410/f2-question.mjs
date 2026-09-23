// LIFE-410 F2 — the question round trip, including the two ways it is interrupted.
//
// The worker side runs with the pane environment herdr gives a pane shell (see `f4-rejections.mjs`
// for why that is the rule rather than a shortcut); the coordinator side runs without it. The same
// round trip driven by a real provider session is `native.mjs`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib.mjs'

const f = await fixture('f2', { expectedChecks: 4 })
try {
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F2 — questions'])
  const taskId = (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble', '--title', 'q'])).result.task.id
  const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
  const dispatchId = started.result.dispatchId
  assert.ok(dispatchId, JSON.stringify(started.result))
  const paneId = (await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])).result.paneId
  const worker = { ...f.env, HERDR_PANE_ID: paneId }
  const ask = (args, options = {}) => f.cli(['orchestration', 'ask', '--task-id', taskId, '--dispatch-id', dispatchId, ...args], { env: worker, ...options })

  await f.check('F2-the-worker-asks-the-coordinator-answers-and-the-ask-returns-it', async () => {
    let answered = null
    const asking = ask(['--question', 'first or second approach?', '--options', 'first,second', '--timeout-ms', '600000'], { timeout: 620000 })
      .then(value => { answered = Date.now(); return value }, error => { answered = Date.now(); return { failed: String(error) } })
    // The coordinator receives it through the ordinary batch, with the ids in the payload.
    const received = await f.cli(['orchestration', 'check', '--block', '--types', 'question', '--timeout-ms', '60000'], { timeout: 80000 })
    assert.equal(received.result.count, 1, JSON.stringify(received.result))
    const question = received.result.messages[0]
    assert.equal(question.type, 'question')
    assert.equal(question.taskId, taskId)
    assert.equal(question.dispatchId, dispatchId)
    assert.deepEqual(question.question.options, ['first', 'second'])
    assert.equal(question.from.kind, 'worker')
    assert.equal(question.from.paneId, paneId)
    assert.equal(answered, null, 'the ask must still be blocked while the coordinator reads it')
    const reply = await f.cli(['orchestration', 'reply', '--id', question.id, '--body', 'the second one'])
    assert.equal(reply.result.reply.type, 'reply')
    assert.equal(reply.result.reply.replyTo, question.id)
    const returned = await asking
    assert.ok(returned.result !== undefined, JSON.stringify(returned))
    assert.equal(returned.result.state, 'answered', JSON.stringify(returned.result))
    assert.equal(returned.result.reply.body, 'the second one')
    assert.equal(returned.result.messageId, question.id)
    // A second reply cannot overwrite an answer the worker may already have read.
    const digest = f.stateDigest()
    const again = await f.cli(['orchestration', 'reply', '--id', question.id, '--body', 'no, the first'], { fail: true })
    assert.equal(again.error.code, 'already_answered', JSON.stringify(again))
    assert.equal(f.stateDigest(), digest)
    await f.cli(['orchestration', 'check', '--ack', received.result.deliveryId])
    return { question, reply: reply.result, returned: returned.result, again: again.error }
  })

  await f.check('F2-a-deadline-is-a-pending-answer-with-the-command-that-keeps-waiting', async () => {
    const pending = await ask(['--question', 'the one that times out', '--timeout-ms', '3000'], { timeout: 40000 })
    assert.equal(pending.result.state, 'pending', JSON.stringify(pending.result))
    assert.equal(pending.result.timedOut, true)
    assert.match(pending.result.messageId, /^msg_[0-9a-f]{12}$/)
    assert.match(pending.result.resumeCommand, /orchestration ask --resume msg_[0-9a-f]{12}/)
    assert.match(pending.result.resumeCommand, /--socket /)
    const stored = f.stateJson().messages.filter(entry => entry.body === 'the one that times out')
    assert.equal(stored.length, 1, 'one question, stored before the wait began')
    return pending.result
  })

  await f.check('F2-resume-keeps-waiting-for-the-same-question-and-creates-no-second-one', async () => {
    const outstanding = (await f.cli(['orchestration', 'check'])).result
    const question = outstanding.messages.find(entry => entry.body === 'the one that times out')
    assert.ok(question, JSON.stringify(outstanding.messages.map(entry => entry.body)))
    const before = f.stateJson().messages.length
    const resumed = ask(['--resume', question.id, '--timeout-ms', '600000'], { timeout: 620000 })
    await f.pause(1000)
    assert.equal(f.stateJson().messages.length, before, 'a resume must not create a second question')
    await f.cli(['orchestration', 'reply', '--id', question.id, '--body', 'answered late'])
    const returned = await resumed
    assert.equal(returned.result.state, 'answered', JSON.stringify(returned.result))
    assert.equal(returned.result.reply.body, 'answered late')
    // …and a resume of a question that is already answered returns at once.
    const immediate = await ask(['--resume', question.id, '--timeout-ms', '600000'], { timeout: 30000 })
    assert.equal(immediate.result.state, 'answered')
    assert.equal(f.stateJson().messages.filter(entry => entry.body === 'the one that times out').length, 1)
    return { question: question.id, returned: returned.result, immediate: immediate.result }
  })

  await f.check('F2-a-question-belongs-to-the-attempt-that-asked-it', async () => {
    const stored = f.stateJson().messages.find(entry => entry.type === 'question')
    const digest = f.stateDigest()
    // Another pane may not resume it, and neither may a caller with no pane at all.
    const foreign = await f.cli(['orchestration', 'ask', '--resume', stored.id, '--task-id', taskId,
      '--dispatch-id', dispatchId, '--timeout-ms', '5000'], { env: { ...f.env, HERDR_PANE_ID: 'w1:p99' }, fail: true })
    assert.equal(foreign.error.code, 'sender_mismatch', JSON.stringify(foreign))
    // A reply aimed at something that is not a question is refused by name.
    const reply = f.stateJson().messages.find(entry => entry.type === 'reply')
    const wrong = await f.cli(['orchestration', 'reply', '--id', reply.id, '--body', 'x'], { fail: true })
    assert.equal(wrong.error.code, 'not_a_question', JSON.stringify(wrong))
    const missing = await f.cli(['orchestration', 'reply', '--id', 'msg_0123456789ab', '--body', 'x'], { fail: true })
    assert.equal(missing.error.code, 'message_not_found', JSON.stringify(missing))
    assert.equal(f.stateDigest(), digest)
    return { foreign: foreign.error, wrong: wrong.error, missing: missing.error }
  })
  f.record('f2-state', f.stateJson())
} finally { await f.cleanup() }
