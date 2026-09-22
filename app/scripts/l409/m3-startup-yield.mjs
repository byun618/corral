// LIFE-409 M3 = R16 = C24 — a command the runtime *rejects* must not cancel the startup sweep.
//
// N2 = R10 gave the runtime-start reconcile a way out: the first orchestration command aborts it,
// because that command re-observes under its own deadline anyway. In r2 the abort was the first
// line of `validateOrchestration`, which runs *before* the lane — so a command that never ran at
// all, a typo in a flag, still ended the one-shot pass, and a pane that died while corral was down
// stayed `dispatched` until some later command happened to look. Codex reproduced it through the
// runtime's own RPC socket (`raw/review/codex/r2/startup-rpc/rpc-result.json`).
//
// The window is made deterministic instead of raced: the backend here is a stand-in that answers
// every request after a fixed delay, so the sweep is provably still in flight when the rejected
// command arrives. The stored document is real — written by the product, through a real backend,
// before the stand-in takes over.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fixture, rpc, until } from './lib.mjs'

/** Per-request delay of the stand-in backend: two calls per sweep, well inside the 2 s budget. */
const DELAY_MS = 400
const f = await fixture('m3', { expectedChecks: 1 })
let runtime, slow
try {
  const backend = await f.startBackend()
  runtime = await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 M3 startup sweep yield'])
  const task = await f.cli(['orchestration', 'task-create', '--spec', 'open when the runtime restarts'])
  const pane = await f.pane('m3-pane')
  const dispatched = await f.cli(['orchestration', 'dispatch', '--task', task.result.task.id, '--to', pane.handle])

  // Take the real backend away and answer for it slowly. A different epoch is enough for §4.5 to
  // settle the attempt `unknown`; what matters here is only that each answer takes DELAY_MS.
  await f.stop(runtime, 'SIGTERM')
  await f.stop(backend, 'SIGKILL')
  try { fs.unlinkSync(f.socket) } catch { /* the backend removed it on the way out */ }
  const served = []
  slow = net.createServer(socket => {
    let text = ''
    socket.on('error', () => {})
    socket.on('data', chunk => {
      text += chunk
      if (!text.includes('\n')) return
      const request = JSON.parse(text.split('\n')[0])
      const method = request.params?.operation?.method ?? 'epoch'
      served.push({ at: Date.now(), method })
      setTimeout(() => {
        if (socket.destroyed) return
        socket.end(JSON.stringify({ id: request.id, result: request.params?.operation
          ? { snapshot: { panes: [], tabs: [], workspaces: [] } }
          : { guard_version: 1, epoch: 'm3-stand-in-epoch' } }) + '\n')
      }, DELAY_MS)
    })
  })
  await new Promise(resolve => slow.listen(f.socket, resolve))
  fs.chmodSync(f.socket, 0o600)

  await f.check('M3-a-rejected-command-does-not-cancel-the-runtime-start-sweep', async () => {
    const before = f.stateDigest()
    const started = Date.now()
    runtime = await f.serve(f.env, 'serve-slow-backend')
    const ready = Date.now()
    // Straight at the runtime socket: the CLI would refuse this locally, and what has to be
    // measured is the runtime's own validation — the code path that used to abort the sweep.
    const rejected = await rpc(path.join(f.env.CORRAL_USER_DATA, 'runtime/rpc.sock'),
      { version: 1, id: 'm3-rejected', invocation: { command: 'orchestration task-update', flags: { id: 'not-a-task-id', status: 'completed' }, args: [], cwd: process.cwd() } }, 5000)
    const answered = Date.now()
    assert.equal(rejected.ok, false, JSON.stringify(rejected))
    assert.equal(rejected.error.code, 'invalid_argument', JSON.stringify(rejected.error))
    assert.equal(rejected._meta.outcome, 'not_started')
    // The rejection has to land while the sweep is still looking, or this proves nothing.
    assert.ok(answered - ready < DELAY_MS, `the rejection took ${answered - ready} ms; the sweep was already over`)
    assert.equal(f.stateDigest(), before, 'a rejected command writes nothing itself')
    // And the sweep, left alone, finishes its pass: the attempt it was looking at is settled.
    await until(() => f.stateJson().dispatches.some(entry => entry.id === dispatched.result.dispatch.id && entry.status === 'unknown'),
      'the startup sweep settles the open attempt', 8000)
    const entry = f.stateJson().dispatches.find(item => item.id === dispatched.result.dispatch.id)
    assert.equal(entry.status, 'unknown')
    assert.equal(entry.reconcile.reason, 'epoch_changed')
    // The Task stays `dispatched` so it can be dispatched again — reconcile never settles a Task.
    assert.equal(f.stateJson().tasks.find(item => item.id === task.result.task.id).status, 'dispatched')
    return { rejected, msToReady: ready - started, msToRejection: answered - ready, served, dispatch: entry }
  })

  f.record('state-after-m3', f.stateJson())
} finally {
  slow?.close()
  await f.cleanup()
}
