// LIFE-409 F3 — an attempt records the identity of the pane it is bound to, taken from the
// terminal module's own reading of that handle, and nothing is sent to the pane.
// The native-provider half of F3 lives in native.mjs (gate ②); this one uses a plain shell pane.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fixture } from './lib.mjs'

const f = await fixture('f3')
try {
  await f.startBackend()
  await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 F3 identity'])
  const task = await f.cli(['orchestration', 'task-create', '--spec', 'bound to a real pane'])
  const target = await f.pane('f3-pane')

  await f.check('F3a-target-matches-terminal-show-and-the-task-moves-to-dispatched', async () => {
    const shown = await f.cli(['terminal', 'show', '--terminal', target.handle])
    const before = (await f.cli(['terminal', 'read', '--terminal', target.handle])).result
    const dispatched = await f.cli(['orchestration', 'dispatch', '--task', task.result.task.id, '--to', target.handle])
    const record = dispatched.result.dispatch
    assert.match(record.id, /^ctx_[0-9a-f]{12}$/)
    assert.equal(record.attempt, 1)
    assert.equal(record.status, 'dispatched')
    assert.equal(record.settledBy, null)
    assert.deepEqual(
      { handle: record.target.handle, epoch: record.target.epoch, ptyId: record.target.ptyId, paneId: record.target.paneId },
      { handle: target.handle, epoch: shown.result.terminal.epoch, ptyId: shown.result.terminal.ptyId, paneId: shown.result.terminal.paneId },
    )
    assert.equal(record.target.runtimeId, dispatched._meta.runtimeId)
    // A plain shell pane has no corral-managed agent: the snapshot is null *with a reason*.
    assert.equal(shown.result.agent, null)
    assert.equal(record.agent, null)
    assert.equal(record.agentAbsenceReason, 'no_managed_agent')
    assert.equal(dispatched.result.task.status, 'dispatched')
    assert.equal(dispatched.result.task.attempts, 1)
    assert.equal(dispatched.result.task.currentDispatchId, record.id)
    // Nothing reached the pane: the PTY byte stream did not grow.
    const after = (await f.cli(['terminal', 'read', '--terminal', target.handle])).result
    assert.equal(after.availableTo, before.availableTo, 'dispatch must not write to the pane')
    return { shown, dispatched, ptyBytesBefore: before.availableTo, ptyBytesAfter: after.availableTo }
  })

  await f.check('F3b-the-stored-target-is-what-a-later-read-reports', async () => {
    const stored = f.stateJson().dispatches[0]
    const listed = (await f.cli(['terminal', 'list'])).result.terminals.find(entry => entry.paneId === stored.target.paneId)
    assert.deepEqual({ epoch: listed.epoch, ptyId: listed.ptyId }, { epoch: stored.target.epoch, ptyId: stored.target.ptyId })
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', stored.id])
    assert.equal(shown.result.terminal.live, true)
    assert.equal(shown.result.terminal.observed, true)
    assert.equal(shown.result.terminal.reason, 'pane_live')
    return { stored, listed, shown, stateFile: f.stateFile(), mode: (fs.statSync(f.stateFile()).mode & 0o777).toString(8) }
  })

  f.record('state-after-f3', f.stateJson())
} finally { await f.cleanup() }
