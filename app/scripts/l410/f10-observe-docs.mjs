// LIFE-410 F10 and F13 — what the observation commands report, and what the CLI documents.
//
// F13 is checked against the shipped artefacts rather than by eye: every one of the fourteen
// commands has to appear in `--help`, in `agent-context`, and in `app/cli/README.md`, and the
// `--help` text is written out verbatim so a reviewer reads what a user reads.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture, requestId } from './lib.mjs'

const COMMANDS = ['worker-start', 'worker-list', 'worker-show', 'worker-read', 'send', 'ask', 'reply',
  'check', 'inbox', 'request-show', 'worker-retain', 'worker-release', 'worker-stop', 'worker-abandon']

const f = await fixture('f10', { expectedChecks: 5 })
try {
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F10 — observation and documentation'])
  const taskId = (await f.cli(['orchestration', 'task-create', '--spec', 'follow the preamble', '--title', 'observe'])).result.task.id
  const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
  const dispatchId = started.result.dispatchId
  assert.ok(dispatchId, JSON.stringify(started.result))
  const paneId = (await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])).result.paneId
  const pane = { ...f.env, HERDR_PANE_ID: paneId }

  await f.check('F10-worker-show-reports-the-attempt-its-ownership-and-its-live-pane', async () => {
    await f.cli(['orchestration', 'send', '--type', 'heartbeat', '--subject', 'alive', '--task-id', taskId,
      '--dispatch-id', dispatchId, '--phase', 'implementing'], { env: pane })
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
    const result = shown.result
    assert.equal(result.dispatchId, dispatchId)
    assert.equal(result.workerState, 'working')
    assert.equal(result.worker.ownership, 'owned')
    assert.equal(result.worker.capabilityRevokedAt, null)
    assert.match(result.worker.lastHeartbeatAt, /^\d{4}-/, 'the heartbeat has to be recorded')
    assert.equal(result.observation.live, true)
    assert.equal(result.observation.observed, true)
    assert.equal(result.observation.source, 'observation')
    assert.equal(result.messageCounts.heartbeat, 1)
    assert.equal(result.lastMessage.type, 'heartbeat')
    assert.equal(result.lastMessage.payload.phase, 'implementing')
    // --task answers with the most recent attempt of that Task.
    const byTask = await f.cli(['orchestration', 'worker-show', '--task', taskId])
    assert.equal(byTask.result.dispatchId, dispatchId)
    const both = await f.cli(['orchestration', 'worker-show', '--task', taskId, '--dispatch', dispatchId], { fail: true })
    assert.equal(both.error.code, 'invalid_argument', JSON.stringify(both))
    return result
  })

  await f.check('F10-worker-read-passes-the-pane-output-through-with-a-usable-cursor', async () => {
    const screen = await f.cli(['orchestration', 'worker-read', '--dispatch', dispatchId, '--screen'], { timeout: 60000 })
    assert.equal(screen.result.source, 'terminal')
    assert.equal(screen.result.output.source, 'screen-snapshot')
    assert.match(screen.result.output.text, /STAND_IN_PROVIDER/, 'the pane really is the one this attempt owns')
    const first = await f.cli(['orchestration', 'worker-read', '--dispatch', dispatchId], { timeout: 60000 })
    assert.equal(first.result.output.source, 'raw-pty')
    const next = await f.cli(['orchestration', 'worker-read', '--dispatch', dispatchId, '--cursor', first.result.output.cursor], { timeout: 60000 })
    assert.equal(next.result.output.from, first.result.output.to, 'the cursor has to continue where the last read stopped')
    // Reading a worker never changes the record.
    const digest = f.stateDigest()
    await f.cli(['orchestration', 'worker-read', '--dispatch', dispatchId, '--screen'], { timeout: 60000 })
    assert.equal(f.stateDigest(), digest)
    return { screen: screen.result.output.text.slice(0, 200), from: first.result.output.from, to: first.result.output.to, next: next.result.output.from }
  })

  await f.check('F10-request-show-answers-completed-pending-and-absent', async () => {
    const absent = await f.cli(['orchestration', 'request-show', '--id', requestId()])
    assert.equal(absent.result.state, 'absent', JSON.stringify(absent.result))
    assert.match(absent.result.interpretation, /not proof that nothing happened/)
    const id = requestId()
    await f.cli(['orchestration', 'send', '--type', 'status', '--subject', 'receipted', '--request-id', id])
    const completed = await f.cli(['orchestration', 'request-show', '--id', id])
    assert.equal(completed.result.state, 'completed', JSON.stringify(completed.result))
    assert.ok(completed.result.result !== null)
    // A pending receipt: a mutation that was admitted and whose outcome was never recorded. The
    // receipt file is the runtime's own record, so it is read back rather than fabricated — an
    // interrupted `check --block` leaves exactly this shape.
    // Drain the mailbox first, or the block returns at once with a batch and completes normally.
    for (;;) {
      const batch = await f.cli(['orchestration', 'check'])
      if (batch.result.count === 0) break
      await f.cli(['orchestration', 'check', '--ack', batch.result.deliveryId])
    }
    const interrupted = requestId()
    const blockArgs = ['orchestration', 'check', '--block', '--timeout-ms', '600000', '--request-id', interrupted]
    let child
    const blocking = f.cliRaw(blockArgs, { timeout: 60000, onSpawn: value => { child = value } })
    await f.until(() => child !== undefined, 'blocking check spawned')
    await f.pause(1500)
    child.kill('SIGKILL')
    await blocking
    const pending = await f.cli(['orchestration', 'request-show', '--id', interrupted])
    assert.equal(pending.result.state, 'pending', JSON.stringify(pending.result))
    assert.match(pending.result.interpretation, /never re-execute|does not re-execute|never re-executes/i)
    // The same input, so the receipt is a replay rather than a conflict: an admitted request whose
    // outcome was never recorded is never re-executed.
    const replayed = await f.cli(blockArgs, { fail: true, timeout: 60000 })
    assert.equal(replayed.error.code, 'outcome_unknown', JSON.stringify(replayed))
    return { absent: absent.result, completed: completed.result.state, pending: pending.result, replayed: replayed.error }
  })

  await f.check('F13-every-command-is-in-help-and-in-agent-context', async () => {
    const help = await f.run(process.execPath, [path.join(f.app, 'cli/corral.mjs'), '--help'], f.env)
    assert.equal(help.exit, 0)
    const context = await f.run(process.execPath, [path.join(f.app, 'cli/corral.mjs'), 'agent-context'], f.env)
    const schema = JSON.parse(context.stdout)
    const missing = []
    for (const name of COMMANDS) {
      const full = `orchestration ${name}`
      if (!help.stdout.includes(`corral ${full} `)) missing.push(`help:${full}`)
      const spec = schema.commands.find(entry => entry.command === full)
      if (!spec) { missing.push(`agent-context:${full}`); continue }
      if (!spec.usage.startsWith(`corral ${full} `)) missing.push(`usage:${full}`)
      if (!spec.notes.length) missing.push(`notes:${full}`)
      if (!spec.examples.length) missing.push(`examples:${full}`)
      // Every flag a command answers to has to be in its own spec, or the parser refuses it.
      for (const flag of ['help', 'json', 'timeout-ms', 'socket', 'instance']) if (!spec.flags.includes(flag)) missing.push(`flag:${full}:${flag}`)
    }
    assert.deepEqual(missing, [], JSON.stringify(missing))
    assert.equal(schema.commandCount, schema.commands.length)
    // The per-command help is what a worker reads when it is stuck; write it out verbatim.
    const texts = {}
    for (const name of COMMANDS) {
      const one = await f.run(process.execPath, [path.join(f.app, 'cli/corral.mjs'), 'orchestration', name, '--help'], f.env, { record: false })
      assert.equal(one.exit, 0, one.stderr)
      texts[name] = one.stdout
    }
    fs.writeFileSync(path.join(f.raw, 'help.txt'), `$ corral --help\n\n${help.stdout}\n` +
      COMMANDS.map(name => `\n$ corral orchestration ${name} --help\n\n${texts[name]}`).join(''))
    f.record('agent-context', schema.commands.filter(entry => COMMANDS.some(name => entry.command === `orchestration ${name}`)))
    return { commands: COMMANDS.length, commandCount: schema.commandCount }
  })

  await f.check('F13-the-README-documents-the-fourteen-commands-and-the-rules-behind-them', async () => {
    const readme = fs.readFileSync(path.join(f.app, 'cli/README.md'), 'utf8')
    const missing = COMMANDS.filter(name => !readme.includes(`orchestration ${name}`))
    assert.deepEqual(missing, [], `README is missing: ${missing.join(', ')}`)
    const topics = ['sender_mismatch', 'stale_dispatch', 'capability_revoked', 'delivery_stale', 'illegal_transition',
      'HERDR_PANE_ID', 'deliveryReplayed', 'worker-release', 'preamble', '600000']
    const absent = topics.filter(topic => !readme.includes(topic))
    assert.deepEqual(absent, [], `README is missing: ${absent.join(', ')}`)
    // The preamble in the README has to be the one the product builds, not a paraphrase of it.
    const between = readme.split('```text\nYou are a corral worker.')[1]
    assert.ok(between, 'the README must carry the preamble verbatim')
    return { commands: COMMANDS.length, topics: topics.length }
  })
} finally { await f.cleanup() }
