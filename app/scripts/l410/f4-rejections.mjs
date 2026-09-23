// LIFE-410 F4 — every way a worker report is refused, and the byte check that it stored nothing.
//
// A worker's own calls are proved by the pane environment herdr gives the shell it starts
// (`probe-pane-env.mjs`). Here the harness supplies that environment itself, which is exactly what
// the rule is: the runtime compares what the caller presents with what the Dispatch records. That
// makes the *rule* measurable without a model in the loop; that a real provider session presents it
// and is accepted is what `native.mjs` measures, and only that counts for gate ②.
//
// Every refusal is followed by a sha256 of the stored document, taken before and after.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fixture, requestId } from './lib.mjs'

const f = await fixture('f4', { expectedChecks: 8 })
try {
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  let runtime = await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F4 — refused reports'])
  const task = async title => (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble', '--title', title])).result.task.id
  /** The environment a pane shell carries. `null` is the coordinator's own shell, which has none. */
  const asPane = paneId => ({ ...f.env, ...(paneId === null ? {} : { HERDR_PANE_ID: paneId }) })
  const start = async taskId => {
    const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
    assert.ok(started.result.dispatchId, `worker-start made no attempt: ${JSON.stringify(started.result)}`)
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', started.result.dispatchId])
    return { dispatchId: started.result.dispatchId, paneId: shown.result.paneId, terminal: shown.result.terminal, live: shown.result.observation }
  }
  /**
   * Run one call that must be refused, and prove nothing it could have written moved: the stored
   * document, and the receipt store beside it. The receipts matter for their own reason — a receipt
   * admitted for a call that is then refused spends the caller's `--request-id`, and the next try
   * with that id answers `outcome_unknown` for something that never happened (V10).
   */
  const refused = async (label, args, env, code) => {
    const before = f.stateDigest(), receipts = f.receiptsDigest()
    const result = await f.cli(args, { env, fail: true })
    assert.equal(result.error.code, code, `${label}: ${JSON.stringify(result)}`)
    assert.equal(result._meta.outcome, 'not_started', `${label}: ${JSON.stringify(result._meta)}`)
    assert.equal(f.stateDigest(), before, `${label}: the stored bytes moved`)
    assert.equal(f.receiptsDigest(), receipts, `${label}: the receipt store moved`)
    return { label, error: result.error, bytesUnchanged: true, receiptsUnchanged: true }
  }

  const taskA = await task('a')
  const a = await start(taskA)

  await f.check('F4c-a-report-from-outside-the-pane-and-from-another-pane', async () => {
    const done = ['orchestration', 'send', '--type', 'worker_done', '--subject', 'forged', '--body', 'x',
      '--task-id', taskA, '--dispatch-id', a.dispatchId, '--outcome', 'succeeded']
    return [
      await refused('coordinator shell, no pane at all', done, asPane(null), 'sender_mismatch'),
      await refused('another pane id', done, asPane('w1:p99'), 'sender_mismatch'),
      await refused('the right pane, another backend session', [...done], { ...asPane(a.paneId), HERDR_SESSION: 'another-session' }, 'sender_mismatch'),
      await refused('the right pane, the wrong Task', ['orchestration', 'send', '--type', 'worker_done', '--subject', 'x', '--body', 'x',
        '--task-id', await task('other'), '--dispatch-id', a.dispatchId, '--outcome', 'succeeded'], asPane(a.paneId), 'sender_mismatch'),
      await refused('a dispatch that never existed', ['orchestration', 'send', '--type', 'heartbeat', '--subject', 'x',
        '--task-id', taskA, '--dispatch-id', 'ctx_0123456789ab'], asPane(a.paneId), 'dispatch_not_found'),
    ]
  })

  const settled = await f.check('F4-the-pane-the-attempt-was-bound-to-is-accepted-and-settles-it', async () => {
    const reported = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'done',
      '--body', 'three sentences would go here.', '--task-id', taskA, '--dispatch-id', a.dispatchId,
      '--outcome', 'succeeded', '--files-modified', 'one,two', '--report-path', 'report.md'], { env: asPane(a.paneId) })
    assert.equal(reported.result.dispatch.status, 'completed', JSON.stringify(reported.result.dispatch))
    assert.equal(reported.result.dispatch.settledBy, 'worker_done')
    assert.equal(reported.result.task.status, 'completed')
    assert.equal(reported.result.message.type, 'worker_done')
    assert.equal(reported.result.message.outcome, 'succeeded')
    assert.deepEqual(reported.result.message.payload.filesModified, ['one', 'two'])
    assert.equal(reported.result.message.payload.reportPath, 'report.md')
    // The report and the settlement are in the same document, so they arrived in the same rename.
    const stored = f.stateJson()
    assert.equal(stored.messages.filter(entry => entry.type === 'worker_done').length, 1)
    assert.equal(stored.dispatches.find(entry => entry.id === a.dispatchId).status, 'completed')
    assert.equal(stored.dispatches.find(entry => entry.id === a.dispatchId).worker.capabilityRevokedReason, 'settled')
    return reported.result
  })

  await f.check('F4be-a-second-report-of-a-settled-attempt-is-illegal-and-stores-nothing', async () => {
    const before = f.stateJson().messages.length
    const again = await refused('second worker_done', ['orchestration', 'send', '--type', 'worker_done', '--subject', 'done again',
      '--body', 'x', '--task-id', taskA, '--dispatch-id', a.dispatchId, '--outcome', 'succeeded'], asPane(a.paneId), 'illegal_transition')
    // A heartbeat after the attempt ended is stale rather than illegal: there is nothing to settle.
    const late = await refused('heartbeat after the attempt ended', ['orchestration', 'send', '--type', 'heartbeat',
      '--subject', 'alive', '--task-id', taskA, '--dispatch-id', a.dispatchId], asPane(a.paneId), 'stale_dispatch')
    assert.equal(f.stateJson().messages.length, before, 'a refused report must not be stored')
    return { again, late, messages: before, settledAt: settled.dispatch.settledAt }
  })

  await f.check('F4d-a-stopped-attempt-loses-the-right-to-report-while-its-process-lives', async () => {
    const taskB = await task('b')
    const b = await start(taskB)
    const stopped = await f.cli(['orchestration', 'worker-stop', '--dispatch', b.dispatchId], { timeout: 60000 })
    assert.equal(stopped.result.state, 'released', JSON.stringify(stopped.result))
    assert.equal(stopped.result.dispatch.status, 'failed')
    assert.equal(stopped.result.task.result.reason, 'worker_stopped')
    assert.equal(stopped.result.dispatch.worker.capabilityRevokedReason, 'stopped')
    const after = await refused('report after worker-stop', ['orchestration', 'send', '--type', 'worker_done', '--subject', 'late',
      '--body', 'x', '--task-id', taskB, '--dispatch-id', b.dispatchId, '--outcome', 'succeeded'], asPane(b.paneId), 'capability_revoked')
    const asked = await refused('ask after worker-stop', ['orchestration', 'ask', '--question', 'still there?',
      '--task-id', taskB, '--dispatch-id', b.dispatchId, '--timeout-ms', '5000'], asPane(b.paneId), 'capability_revoked')
    return { stopped: stopped.result, after, asked }
  })

  await f.check('F4d-an-abandoned-attempt-loses-the-right-too-and-its-pane-is-left-alone', async () => {
    const taskC = await task('c')
    const c = await start(taskC)
    const panes = (await f.cli(['terminal', 'list'])).result.totalCount
    const abandoned = await f.cli(['orchestration', 'worker-abandon', '--dispatch', c.dispatchId])
    assert.equal(abandoned.result.state, 'retained', JSON.stringify(abandoned.result))
    assert.equal(abandoned.result.reason, 'abandoned')
    assert.equal(abandoned.result.processAction, 'none')
    assert.equal(abandoned.result.dispatch.status, 'failed')
    assert.equal((await f.cli(['terminal', 'list'])).result.totalCount, panes, 'abandon must not close a pane')
    const after = await refused('report after worker-abandon', ['orchestration', 'send', '--type', 'escalation', '--subject', 'late',
      '--body', 'x', '--task-id', taskC, '--dispatch-id', c.dispatchId], asPane(c.paneId), 'capability_revoked')
    return { abandoned: abandoned.result, after, panes }
  })

  await f.check('F4a-a-superseded-attempt-is-stale-and-the-task-stays-open', async () => {
    const taskD = await task('d')
    const d = await start(taskD)
    // Close the pane and let reconcile settle the attempt `unknown` — the attempt ends, the Task
    // does not. A late report naming it is stale, not illegal: there is a Task to attempt again.
    await f.cli(['terminal', 'close', '--terminal', d.terminal], { timeout: 60000 })
    await f.cli(['orchestration', 'worker-show', '--dispatch', d.dispatchId])
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', d.dispatchId])
    assert.equal(shown.result.dispatch.status, 'unknown', JSON.stringify(shown.result.dispatch))
    assert.equal(shown.result.dispatch.settledBy, 'reconcile')
    assert.equal(shown.result.task.status, 'dispatched', 'reconcile never settles the Task')
    const late = await refused('report naming a reconcile-settled attempt',
      ['orchestration', 'send', '--type', 'worker_done', '--subject', 'late', '--body', 'x',
        '--task-id', taskD, '--dispatch-id', d.dispatchId, '--outcome', 'succeeded'], asPane(d.paneId), 'stale_dispatch')
    return { dispatch: shown.result.dispatch, late }
  })

  await f.check('F4-the-pane-itself-is-asked-and-a-refusal-spends-no-receipt', async () => {
    // The stored ids and the caller's environment still agree after the pane they name is gone —
    // which is exactly when a report is most misleading. Only a look at the pane can tell, and the
    // look is taken before anything is admitted (V8).
    const taskE = await task('e')
    const e = await start(taskE)
    const requestId = `r1.${String(Date.now()).padStart(13, '0')}.${crypto.randomUUID()}`
    // Still live: the same call with the same ids is accepted, so what changes below is the pane
    // and nothing else. A heartbeat is the cheapest report that goes through the whole check.
    const alive = await f.cli(['orchestration', 'send', '--type', 'heartbeat', '--subject', 'alive',
      '--task-id', taskE, '--dispatch-id', e.dispatchId], { env: asPane(e.paneId) })
    assert.equal(alive.result.sessionVerified, true, JSON.stringify(alive.result))
    // Take the pane away underneath it. The record still says `dispatched`, the environment still
    // carries the same pane id, and the report is still refused.
    await f.cli(['terminal', 'close', '--terminal', e.terminal], { timeout: 60000 })
    const stateBefore = f.stateDigest(), receiptsBefore = f.receiptsDigest()
    const gone = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'late', '--body', 'x',
      '--task-id', taskE, '--dispatch-id', e.dispatchId, '--outcome', 'succeeded', '--request-id', requestId],
    { env: asPane(e.paneId), fail: true })
    assert.equal(gone.error.code, 'stale_dispatch', JSON.stringify(gone))
    assert.equal(gone.error.resources.observation, 'pane_gone', JSON.stringify(gone.error.resources))
    assert.equal(gone._meta.outcome, 'not_started', JSON.stringify(gone._meta))
    // The document is one thing; the receipt store is another, and a rejection that reached the
    // receipt would spend this id for a report that never happened.
    assert.equal(f.stateDigest(), stateBefore, 'a refused report must not write the document')
    assert.equal(f.receiptsDigest(), receiptsBefore, 'a refused report must not write a receipt')
    const unspent = await f.cli(['orchestration', 'request-show', '--id', requestId])
    assert.equal(unspent.result.state, 'absent', JSON.stringify(unspent.result))
    return { alive: { sessionVerified: alive.result.sessionVerified }, gone: gone.error, requestState: unspent.result.state }
  })
  await f.check('F4-a-full-mailbox-refuses-every-message-path-before-its-receipt-exists', async () => {
    // V25. r1 closed this for `worker_done` only. A coordinator `status` returned from the plan
    // before the capacity dry-run ran, and `ask` appended inside its mutation — so both reached
    // `message_capacity` *after* the receipt was admitted, leaving a pending receipt behind an
    // effect that never happened. The next try with that id then answered `outcome_unknown` about
    // a message nobody ever stored.
    //
    // The ceiling is reached by writing the mailbox full in the shape the product writes it, with
    // the runtime stopped, and starting it again on that document — 10,000 messages is a real Run
    // ceiling and sending them one call at a time is not a test, it is an afternoon.
    const taskF = await task('f')
    const g = await start(taskF)
    await f.stop(runtime, 'SIGTERM')
    const document = f.stateJson()
    const runId = document.currentRunId
    const sample = document.messages[0]
    assert.ok(sample, 'the fixture must have sent at least one message to copy the shape from')
    const filler = []
    for (let index = 0; index < 10000 - document.messages.length; index++) filler.push({
      ...sample, id: 'msg_' + index.toString(16).padStart(12, '0'), runId,
      taskId: null, dispatchId: null, type: 'status', outcome: null, question: null, replyTo: null,
      subject: 'filler', body: '', payload: {}, from: { kind: 'coordinator', dispatchId: null, paneId: null },
      sequence: index + 1, deliveredIn: null, acknowledgedAt: null,
    })
    const renumbered = document.messages.map((entry, index) => ({ ...entry, sequence: filler.length + index + 1 }))
    fs.writeFileSync(f.stateFile(),
      JSON.stringify({ ...document, messages: [...filler, ...renumbered] }, null, 2) + '\n')
    runtime = await f.serve()
    assert.equal(f.stateJson().messages.length, 10000)

    const full = async (label, args, env) => {
      const id = requestId()
      const before = f.stateDigest(), receipts = f.receiptsDigest()
      const result = await f.cli([...args, '--request-id', id], { env, fail: true })
      assert.equal(result.error.code, 'message_capacity', `${label}: ${JSON.stringify(result)}`)
      assert.equal(result._meta.outcome, 'not_started', `${label}: ${JSON.stringify(result._meta)}`)
      assert.equal(f.stateDigest(), before, `${label}: the stored bytes moved`)
      assert.equal(f.receiptsDigest(), receipts, `${label}: the receipt store moved`)
      const shown = await f.cli(['orchestration', 'request-show', '--id', id])
      assert.equal(shown.result.state, 'absent', `${label}: ${JSON.stringify(shown.result)}`)
      // The same id again: an unspent id is still spendable, and answers the same way.
      const again = await f.cli([...args, '--request-id', id], { env, fail: true })
      assert.equal(again.error.code, 'message_capacity', `${label} (retry): ${JSON.stringify(again)}`)
      assert.equal(f.receiptsDigest(), receipts, `${label} (retry): the receipt store moved`)
      return { label, error: result.error, requestState: shown.result.state }
    }
    const status = await full('coordinator status',
      ['orchestration', 'send', '--type', 'status', '--subject', 'no room', '--body', 'x'], f.env)
    const asking = await full('worker ask',
      ['orchestration', 'ask', '--question', 'no room', '--task-id', taskF, '--dispatch-id', g.dispatchId, '--timeout-ms', '2000'],
      asPane(g.paneId))
    const report = await full('worker_done',
      ['orchestration', 'send', '--type', 'worker_done', '--subject', 'no room', '--body', 'x',
        '--task-id', taskF, '--dispatch-id', g.dispatchId, '--outcome', 'succeeded'], asPane(g.paneId))
    return { messages: f.stateJson().messages.length, status, asking, report }
  })
  f.record('f4-state', f.stateJson())
} finally { await f.cleanup() }
