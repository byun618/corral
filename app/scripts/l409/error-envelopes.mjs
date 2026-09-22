// LIFE-409 N8 = R13 — the shipped prose about error envelopes, measured instead of asserted.
//
// r1's README said every rejection carries `stage: "preflight"` and `outcome: "not_started"`, with
// `outcome_unknown` as the only exception. Codex read the actual responses and found two ways that
// was wrong: the borrowed codes (`request_conflict`, `stale_terminal`, …) carry no `stage` at all,
// and in r1 a `stale_terminal` rejection left a pending receipt behind. This check records the
// envelope of every rejection the group can answer with and asserts exactly what the README now
// says — so the next person to change the prose has to change a check with it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture, requestId } from './lib.mjs'

/** Codes this module decides itself; everything else is borrowed and carries no stage. */
const OWN = ['run_not_found', 'task_not_found', 'dispatch_not_found', 'illegal_transition', 'stale_dispatch', 'version_conflict', 'task_not_startable', 'dependency_cycle']
/**
 * M8 = C21. r1 gave these a recovery by accident — the receipt wrapper's generic advice filled the
 * field. N3 moved them before the receipt and the field went `null`, so the four codes a caller is
 * most likely to hit stopped naming the command that answers them. They carry their own now.
 */
const MUST_ADVISE = ['illegal_transition', 'stale_dispatch', 'version_conflict', 'task_not_found']

const f = await fixture('n8', { expectedChecks: 2 })
try {
  await f.startBackend()
  await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 N8 error envelopes'])

  const dispatchedTask = async (name) => {
    const task = await f.cli(['orchestration', 'task-create', '--spec', name])
    const pane = await f.pane(name)
    const dispatched = await f.cli(['orchestration', 'dispatch', '--task', task.result.task.id, '--to', pane.handle])
    return { taskId: task.result.task.id, dispatchId: dispatched.result.dispatch.id, handle: pane.handle }
  }

  await f.check('N8-every-rejection-reports-the-envelope-the-README-describes', async () => {
    const settled = await dispatchedTask('n8-settled')
    await f.cli(['orchestration', 'task-update', '--id', settled.taskId, '--status', 'completed'])
    const open = await dispatchedTask('n8-open')
    const closed = await dispatchedTask('n8-closed')
    await f.cli(['terminal', 'close', '--terminal', closed.handle])

    const before = f.stateDigest()
    const rejections = []
    const rejected = async (label, args) => {
      const id = requestId()
      const response = await f.cli([...args, '--request-id', id], { fail: true })
      const receipt = path.join(f.env.CORRAL_USER_DATA, 'runtime/terminal-receipts', id + '.json')
      const entry = {
        label, code: response.error.code, stage: response.error.stage ?? null,
        outcome: response._meta.outcome, receiptWritten: fs.existsSync(receipt),
        recovery: response.error.resources?.recovery ?? null,
      }
      rejections.push(entry)
      return entry
    }

    await rejected('illegal_transition', ['orchestration', 'task-update', '--id', settled.taskId, '--status', 'blocked'])
    await rejected('stale_dispatch', ['orchestration', 'task-update', '--id', open.taskId, '--status', 'completed', '--dispatch', settled.dispatchId])
    await rejected('version_conflict', ['orchestration', 'task-update', '--id', open.taskId, '--status', 'completed', '--expected-version', '1'])
    await rejected('task_not_found', ['orchestration', 'task-update', '--id', 'task_' + 'b'.repeat(12), '--status', 'completed'])
    await rejected('task_not_startable', ['orchestration', 'dispatch', '--task', open.taskId, '--to', open.handle])
    await rejected('invalid_terminal', ['orchestration', 'dispatch', '--task', settled.taskId, '--to', 't1.forged.handle'])
    await rejected('stale_terminal', ['orchestration', 'dispatch', '--task', settled.taskId, '--to', closed.handle])
    // A `--deps` entry that is not in the Run is `task_not_found`, as the README says.
    // `dependency_cycle` is unreachable from the CLI: it fires when a Task names its own id, and
    // the id is minted inside `createTask` after the deps are read. It is documented as a code the
    // module can raise, not as one a caller can provoke.
    await rejected('task_not_found', ['orchestration', 'task-create', '--spec', 'needs a stranger', '--deps', 'task_' + 'c'.repeat(12)])
    // Every call above was refused, so nothing — not even the reconcile they each ran — is stored.
    assert.equal(f.stateDigest(), before, 'a rejected mutation writes nothing')

    // Not effect-free in the same sense: this id belongs to a mutation that *did* take effect.
    const reused = requestId()
    await f.cli(['orchestration', 'task-create', '--spec', 'first use', '--request-id', reused])
    const conflict = await f.cli(['orchestration', 'task-create', '--spec', 'different input', '--request-id', reused], { fail: true })
    const expired = await f.cli(['orchestration', 'task-create', '--spec', 'too old', '--request-id', `r1.${Date.now() - 25 * 60 * 60 * 1000}.${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`], { fail: true })
    const borrowed = [
      { label: 'request_conflict', code: conflict.error.code, stage: conflict.error.stage ?? null, outcome: conflict._meta.outcome },
      { label: 'request_expired', code: expired.error.code, stage: expired.error.stage ?? null, outcome: expired._meta.outcome },
    ]

    for (const entry of [...rejections, ...borrowed]) {
      assert.equal(entry.code, entry.label, `${entry.label} answered ${entry.code}`)
      assert.equal(entry.outcome, 'not_started', `${entry.label} reported outcome ${entry.outcome}`)
      // What the README claims about `stage`: this module's own checks carry it, borrowed ones do not.
      assert.equal(entry.stage, OWN.includes(entry.code) ? 'preflight' : null, `${entry.label} reported stage ${entry.stage}`)
    }
    // N3 = C13: none of the refusals above may spend the caller's request id.
    const burned = rejections.filter(entry => entry.receiptWritten)
    assert.deepEqual(burned, [], `rejections left receipts behind: ${JSON.stringify(burned)}`)
    for (const entry of rejections)
      assert.doesNotMatch(String(entry.recovery ?? ''), /same --request-id/, `${entry.label} still advises retrying the same id`)
    // M8: and the four table-based rejections name the command that answers them.
    for (const entry of rejections.filter(item => MUST_ADVISE.includes(item.code))) {
      assert.notEqual(entry.recovery, null, `${entry.label} carries no recovery`)
      assert.match(String(entry.recovery), /corral orchestration|orchestration task-list|--expected-version/, `${entry.label} recovery names no command: ${entry.recovery}`)
    }
    for (const code of MUST_ADVISE)
      assert.ok(rejections.some(entry => entry.code === code), `no rejection exercised ${code}`)
    return { rejections, borrowed }
  })

  await f.check('M1-an-unknown-outcome-is-not-told-to-send-a-new-request-id', async () => {
    // M1 = R14 = C20. `receipts.ts` raises `outcome_unknown` itself, with `{requestId, recovery}`
    // and no `detail`; in r2 `flattenReceiptError` read that `requestId` as the body wrapper and
    // replaced the recovery with "spent — send a new --request-id". The coordinator followed that
    // advice against a pending receipt and got the same Task twice. The envelope is the check.
    const id = requestId()
    const args = ['orchestration', 'task-create', '--spec', 'm1-pending', '--request-id', id]
    const first = await f.cli(args)
    const receipt = path.join(f.env.CORRAL_USER_DATA, 'runtime/terminal-receipts', id + '.json')
    const stored = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    assert.equal(stored.state, 'completed')
    // Exactly the bytes a crash between the pending write and the completed write leaves behind.
    fs.writeFileSync(receipt, JSON.stringify({ hash: stored.hash, state: 'pending', createdAt: stored.createdAt }))
    const before = f.stateDigest()
    const unknown = await f.cli(args, { fail: true })
    const recovery = String(unknown.error.resources?.recovery ?? '')
    assert.equal(unknown.error.code, 'outcome_unknown')
    assert.equal(unknown.error.stage, 'receipt')
    assert.equal(unknown._meta.outcome, 'unknown')
    assert.equal(f.stateDigest(), before, 'a pending receipt must not be re-executed')
    // Semantic, not textual: it must point at the orchestration reads, and must not send the
    // caller back with the same input under any id — that is how the duplicate was made.
    assert.match(recovery, /orchestration run-show|dispatch-show/, `recovery names no read command: ${recovery}`)
    assert.doesNotMatch(recovery, /send a new --request-id/, `recovery still advises a new id: ${recovery}`)
    assert.doesNotMatch(recovery, /spent/, `recovery still calls an unknown outcome spent: ${recovery}`)
    // A replayable receipt is unaffected: put it back and the first result returns, once.
    fs.writeFileSync(receipt, JSON.stringify(stored))
    const replayed = await f.cli(args)
    assert.equal(replayed.result.replayed, true)
    assert.equal(replayed.result.task.id, first.result.task.id)
    assert.equal(f.stateJson().tasks.filter(task => task.spec === 'm1-pending').length, 1, 'the replay must not create a second task')
    return { unknown: { code: unknown.error.code, stage: unknown.error.stage, outcome: unknown._meta.outcome, recovery, message: unknown.error.message }, replayedTask: replayed.result.task.id }
  })

  f.record('state-after-n8', f.stateJson())
} finally { await f.cleanup() }
