// LIFE-409 F8 — one mutation is one atomic write.
//
// Three separate claims, measured separately:
//  (a) while a four-record mutation runs, the file on disk only ever holds the old content or the
//      new one — never anything in between. Sampled at full speed from a second process's point of
//      view, so a torn or half-written document would be caught as a third distinct digest.
//  (b) killing the runtime mid-write leaves the document at one of those same two states, and a
//      restart reads it without complaint. Repeated with varied timing.
//  (c) a damaged document is reported as storage_corrupt and is never rewritten or truncated.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fixture, pause } from './lib.mjs'

const f = await fixture('f8')
let runtime
try {
  await f.startBackend()
  runtime = await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 F8 atomicity'])

  // One pane hosts every attempt in this fixture: a pane is a dispatch target, not a lock, and
  // creating a fresh one per round would only add PTY churn to a test about file writes.
  const host = await f.pane('f8-host')
  const dispatchedTask = async (name, deps = []) => {
    const task = await f.cli(['orchestration', 'task-create', '--spec', name, ...(deps.length ? ['--deps', deps.join(',')] : [])])
    if (deps.length) return { taskId: task.result.task.id, dispatchId: null }
    const dispatched = await f.cli(['orchestration', 'dispatch', '--task', task.result.task.id, '--to', host.handle])
    return { taskId: task.result.task.id, dispatchId: dispatched.result.dispatch.id }
  }

  await f.check('F8a-a-four-record-mutation-is-never-observed-half-applied', async () => {
    const subject = await dispatchedTask('f8-subject')
    const b = await dispatchedTask('f8-dependent-b', [subject.taskId])
    const c = await dispatchedTask('f8-dependent-c', [subject.taskId])
    await f.cli(['orchestration', 'run-current'])
    const file = f.stateFile()
    const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const seen = new Map([[before, 'before']])
    let sampling = true, samples = 0
    const sampler = (async () => {
      while (sampling) {
        try {
          const bytes = fs.readFileSync(file)
          const digest = createHash('sha256').update(bytes).digest('hex')
          samples++
          if (!seen.has(digest)) seen.set(digest, bytes.toString('utf8'))
        } catch (error) { seen.set('READ_FAILED', String(error)) }
        await pause(0)
      }
    })()
    const updated = await f.cli(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed', '--result', '{"done":true}'])
    sampling = false
    await sampler
    const after = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const unexpected = [...seen.keys()].filter(digest => digest !== before && digest !== after)
    assert.deepEqual(unexpected.map(key => seen.get(key)), [], 'a third document state was observable mid-write')
    // All four record changes are in that one committed document.
    const document = JSON.parse(fs.readFileSync(file, 'utf8'))
    const task = document.tasks.find(entry => entry.id === subject.taskId)
    const attempt = document.dispatches.find(entry => entry.id === subject.dispatchId)
    assert.equal(task.status, 'completed')
    assert.deepEqual(task.result, { done: true })
    assert.equal(attempt.status, 'completed')
    assert.deepEqual([b, c].map(entry => document.tasks.find(row => row.id === entry.taskId).status), ['ready', 'ready'])
    assert.deepEqual(updated.result.promoted.map(row => row.id).sort(), [b.taskId, c.taskId].sort())
    return { samples, distinctDocuments: seen.size, before, after, promoted: updated.result.promoted.map(row => row.id) }
  })

  await f.check('F8b-killing-the-runtime-mid-write-leaves-one-of-the-two-states', async () => {
    // Calibrate first. A fixed small delay kills the runtime before the CLI has even connected,
    // which only ever exercises the "nothing was written" branch — an empty result that would read
    // as a pass. The delays below straddle a measured round trip, and the check fails unless both
    // branches were actually reached.
    const calibration = await dispatchedTask('f8-calibrate')
    const started = Date.now()
    await f.cli(['orchestration', 'task-update', '--id', calibration.taskId, '--status', 'completed'])
    const roundTrip = Date.now() - started
    const delays = [0.45, 0.6, 0.7, 0.8, 0.88, 0.94, 1.0, 1.06, 1.15, 1.3, 1.6, 2.2].map(factor => Math.round(roundTrip * factor))
    const rounds = []
    for (const [round, delayMs] of delays.entries()) {
      const subject = await dispatchedTask(`f8-crash-${round}`)
      const before = JSON.parse(fs.readFileSync(f.stateFile(), 'utf8'))
      const pending = f.cliRaw(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed'])
      await pause(delayMs)
      runtime.kill('SIGKILL')
      const outcome = await pending
      runtime = await f.serve(f.env, `serve-crash-${round}`)
      // The killed runtime may or may not have committed; both are legal, nothing else is.
      const document = JSON.parse(fs.readFileSync(f.stateFile(), 'utf8'))
      const task = document.tasks.find(entry => entry.id === subject.taskId)
      const attempt = document.dispatches.find(entry => entry.id === subject.dispatchId)
      assert.ok(['dispatched', 'completed'].includes(task.status), `unexpected task status ${task.status}`)
      assert.equal(attempt.status, task.status, 'the Task and its attempt must never disagree after a crash')
      if (task.status === 'dispatched') {
        assert.deepEqual(task, before.tasks.find(entry => entry.id === subject.taskId), 'an uncommitted write must leave the record untouched')
      } else {
        assert.equal(attempt.settledBy, 'task-update')
        assert.equal(task.version, before.tasks.find(entry => entry.id === subject.taskId).version + 1)
      }
      // The restarted runtime reads the document without complaint.
      const listed = await f.cli(['orchestration', 'task-list'])
      assert.equal(listed.result.tasks.find(entry => entry.id === subject.taskId).status, task.status)
      rounds.push({ round, delayMs, status: task.status, cliExit: outcome.exit, cliCode: outcome.json?.error?.code ?? null, cliOutcome: outcome.json?._meta?.outcome ?? null })
    }
    const statuses = [...new Set(rounds.map(entry => entry.status))].sort()
    // Positive control: a run that only ever saw one branch has not measured atomicity at all.
    assert.deepEqual(statuses, ['completed', 'dispatched'], `the kill window never straddled the commit: ${JSON.stringify(rounds)}`)
    const leftovers = fs.readdirSync(path.dirname(f.stateFile())).filter(name => name !== 'state.json')
    assert.deepEqual(leftovers, [], `uncommitted temporary files survived: ${leftovers.join(', ')}`)
    return { roundTripMs: roundTrip, rounds, statuses, leftoverFiles: leftovers }
  })

  await f.check('F8c-a-leftover-temporary-file-is-ignored-and-the-committed-document-wins', async () => {
    const stray = `${f.stateFile()}.${randomUUID()}.tmp`
    fs.writeFileSync(stray, '{"schemaVersion":1,"currentRunId":null,"runs":[],"tasks":[],"dispatches":[]}', { mode: 0o600 })
    const listed = await f.cli(['orchestration', 'task-list'])
    assert.ok(listed.result.tasks.length > 0, 'a stray temporary file must not shadow the committed document')
    const created = await f.cli(['orchestration', 'task-create', '--spec', 'after a stray temp file'])
    assert.equal(created.result.task.status, 'ready')
    assert.equal(fs.existsSync(stray), true, 'corral does not delete files it did not create')
    fs.unlinkSync(stray)
    return { stray, tasks: listed.result.tasks.length }
  })

  await f.check('F8d-a-damaged-document-is-storage_corrupt-and-is-left-exactly-as-found', async () => {
    const good = fs.readFileSync(f.stateFile())
    const damaged = good.subarray(0, Math.floor(good.length / 2)) // a torn write
    fs.writeFileSync(f.stateFile(), damaged)
    const digest = createHash('sha256').update(fs.readFileSync(f.stateFile())).digest('hex')
    const responses = {}
    for (const args of [['orchestration', 'task-list'], ['orchestration', 'run-current'], ['orchestration', 'task-create', '--spec', 'should not be created']]) {
      const response = await f.cli(args, { fail: true })
      assert.equal(response.error.code, 'storage_corrupt', JSON.stringify(response.error))
      responses[args.join(' ')] = response
    }
    assert.equal(createHash('sha256').update(fs.readFileSync(f.stateFile())).digest('hex'), digest, 'a damaged document must never be rewritten')
    // A foreign but well-formed JSON document is refused too, rather than read as an empty profile.
    fs.writeFileSync(f.stateFile(), '{"schemaVersion":1,"currentRunId":"run_deadbeefcafe","runs":[],"tasks":[],"dispatches":[]}')
    const dangling = await f.cli(['orchestration', 'run-current'], { fail: true })
    assert.equal(dangling.error.code, 'storage_corrupt')
    fs.writeFileSync(f.stateFile(), good)
    const recovered = await f.cli(['orchestration', 'task-list'])
    assert.ok(recovered.result.tasks.length > 0)
    return { responses, dangling, recoveredTasks: recovered.result.tasks.length }
  })

  f.record('state-after-f8', f.stateJson())
} finally { await f.cleanup() }
