// LIFE-409 F8 — one mutation is one atomic write.
//
// Three separate claims, measured separately:
//  (a) while a four-record mutation runs, the file on disk only ever holds the old content or the
//      new one — never anything in between. Sampled at full speed from a second process's point of
//      view, so a torn or half-written document would be caught as a third distinct digest.
//  (b) the commit window is entered on purpose, not guessed at: a preload (`kill-preload.mjs`,
//      loaded into `corral serve` with NODE_OPTIONS, product code untouched) kills the runtime
//      inside `fs.renameSync` for this one file — once before the rename and once after it — and
//      logs the hit, so each branch is evidence rather than an inference from timing.
//  (c) killing the runtime at varied points around a measured round trip leaves the document at one
//      of those same two states, and a restart reads it without complaint.
//  (d) a damaged document is reported as storage_corrupt and is never rewritten or truncated.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fixture, pause, requestId } from './lib.mjs'

const PRELOAD = fileURLToPath(new URL('./kill-preload.mjs', import.meta.url))

const f = await fixture('f8', { expectedChecks: 6 })
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
    // C7 positive control: two distinct documents means the sampler really crossed the write. One
    // means it never looked while the mutation was running, and the "no third state" claim above
    // would then be true of nothing at all.
    assert.ok(seen.size >= 2, `the sampler never observed the write: ${seen.size} distinct document(s) in ${samples} samples`)
    assert.equal(seen.has('READ_FAILED'), false, 'the document was unreadable at some point during the write')
    return { samples, distinctDocuments: seen.size, before, after, promoted: updated.result.promoted.map(row => row.id) }
  })

  /**
   * Bring the runtime up with the crash injector loaded but **disarmed** (R4). The injector only
   * fires once `arm()` creates the trigger file, so the runtime-start reconcile sweep — the first
   * write a fresh runtime makes — cannot be mistaken for the mutation under test.
   */
  const injector = async (window, name) => {
    const log = path.join(f.raw, `kill-${window}.jsonl`)
    const trigger = path.join(f.root, `arm-${window}`)
    const env = { ...f.env, NODE_OPTIONS: `--import ${PRELOAD}`, L409_KILL_WINDOW: window, L409_KILL_TARGET: f.stateFile(), L409_KILL_LOG: log, L409_KILL_ARM_FILE: trigger }
    const child = await f.serve(env, name)
    // One read first: whatever the startup sweep wanted to write is written and done with.
    await f.cli(['orchestration', 'run-current'])
    return { child, log, arm: () => fs.writeFileSync(trigger, 'armed') }
  }
  const hits = log => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.armed !== true)

  await f.check('F8b-i-a-kill-before-the-rename-leaves-the-old-document-and-a-stray-temporary', async () => {
    const subject = await dispatchedTask('f8-window-before')
    await f.stop(runtime, 'SIGTERM')
    const injected = await injector('before_rename', 'serve-window-before')
    runtime = injected.child
    const beforeArm = createHash('sha256').update(fs.readFileSync(f.stateFile())).digest('hex')
    injected.arm()
    const id = requestId()
    const outcome = await f.cliRaw(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed', '--request-id', id])
    const hit = hits(injected.log)
    assert.equal(hit.length, 1, `the window was not entered: ${JSON.stringify(hit)}`)
    assert.equal(hit[0].window, 'before_rename')
    assert.ok(hit[0].tmpBytes > 0, 'the temporary file was written and fsynced before the kill')
    // The committed document is untouched, and the temporary nobody renamed is still lying there.
    assert.equal(createHash('sha256').update(fs.readFileSync(f.stateFile())).digest('hex'), beforeArm, 'the killed write left the document as it was when the injector was armed')
    const strays = fs.readdirSync(path.dirname(f.stateFile())).filter(name => name !== 'state.json')
    assert.equal(strays.length, 1, `expected exactly one stray temporary, found ${strays.join(', ') || 'none'}`)
    runtime = await f.serve(f.env, 'serve-after-window-before')
    const listed = await f.cli(['orchestration', 'task-list'])
    assert.equal(listed.result.tasks.find(entry => entry.id === subject.taskId).status, 'dispatched', 'nothing was committed')
    assert.equal(createHash('sha256').update(fs.readFileSync(f.stateFile())).digest('hex'), beforeArm, 'the restart read the same document, unchanged')
    // The receipt was reserved before the body ran, so the same id is answered, never re-executed.
    const retry = await f.cli(['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed', '--request-id', id], { fail: true })
    assert.equal(retry.error.code, 'outcome_unknown')
    assert.equal(retry._meta.outcome, 'unknown')
    assert.equal(listed.result.tasks.find(entry => entry.id === subject.taskId).status, 'dispatched')
    for (const stray of strays) fs.unlinkSync(path.join(path.dirname(f.stateFile()), stray))
    return { hit, strays, cliExit: outcome.exit, cliCode: outcome.json?.error?.code ?? null, retry }
  })

  await f.check('F8b-ii-a-kill-after-the-rename-commits-the-document-and-leaves-the-receipt-pending', async () => {
    const subject = await dispatchedTask('f8-window-after')
    await f.stop(runtime, 'SIGTERM')
    const injected = await injector('after_rename', 'serve-window-after')
    runtime = injected.child
    injected.arm()
    const id = requestId()
    const args = ['orchestration', 'task-update', '--id', subject.taskId, '--status', 'completed', '--result', '{"window":"after_rename"}', '--request-id', id]
    const outcome = await f.cliRaw(args)
    const hit = hits(injected.log)
    assert.equal(hit.length, 1, `the window was not entered: ${JSON.stringify(hit)}`)
    assert.equal(hit[0].window, 'after_rename')
    // The rename happened: the document is the new one, whole, with the attempt settled with it.
    const document = JSON.parse(fs.readFileSync(f.stateFile(), 'utf8'))
    const task = document.tasks.find(entry => entry.id === subject.taskId)
    const attempt = document.dispatches.find(entry => entry.id === subject.dispatchId)
    assert.equal(task.status, 'completed')
    assert.deepEqual(task.result, { window: 'after_rename' })
    assert.equal(attempt.status, 'completed')
    assert.equal(attempt.settledBy, 'task-update')
    assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile())).filter(name => name !== 'state.json'), [], 'the rename consumed the temporary')
    runtime = await f.serve(f.env, 'serve-after-window-after')
    // The client never learned the outcome, and the receipt is still pending: the same id is
    // `outcome_unknown` for good, and the effect is never applied a second time.
    // The very same request, byte for byte — a different one would be `request_conflict` instead.
    const retry = await f.cli(args, { fail: true })
    assert.equal(retry.error.code, 'outcome_unknown')
    assert.equal(retry.error.stage, 'receipt')
    const after = JSON.parse(fs.readFileSync(f.stateFile(), 'utf8')).tasks.find(entry => entry.id === subject.taskId)
    assert.equal(after.version, task.version, 'the retry must not move the record again')
    return { hit, cliExit: outcome.exit, cliCode: outcome.json?.error?.code ?? null, cliOutcome: outcome.json?._meta?.outcome ?? null, retry }
  })

  await f.check('F8c-killing-the-runtime-around-the-round-trip-leaves-one-of-the-two-states', async () => {
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
    const stateDir = path.dirname(f.stateFile())
    const strays = () => fs.readdirSync(stateDir).filter(name => name !== 'state.json')
    for (const [round, delayMs] of delays.entries()) {
      const subject = await dispatchedTask(`f8-crash-${round}`)
      const before = JSON.parse(fs.readFileSync(f.stateFile(), 'utf8'))
      const straysBefore = strays()
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
      // N4 = K1 = G6 = R11 = C15. A kill *before* the rename is one of the two legal outcomes, and
      // `atomicWrite`'s `finally rmSync(tmp)` never runs when the process is SIGKILLed — so the
      // temporary file it leaves is the expected debris of the branch this check exists to reach,
      // not a defect. F8b-i hits that window deterministically and records the same file. What the
      // check owes is that the debris is only ever a state.json temporary, and only from a round
      // that did not commit; F8d proves the next read ignores it.
      const appeared = strays().filter(name => !straysBefore.includes(name))
      for (const name of appeared) assert.match(name, /^state\.json\.[0-9a-f-]{36}\.tmp$/, `unexpected leftover ${name}`)
      if (appeared.length > 0) assert.equal(task.status, 'dispatched', `a committed round left ${appeared.join(', ')}`)
      rounds.push({ round, delayMs, status: task.status, strays: appeared, cliExit: outcome.exit, cliCode: outcome.json?.error?.code ?? null, cliOutcome: outcome.json?._meta?.outcome ?? null })
    }
    const statuses = [...new Set(rounds.map(entry => entry.status))].sort()
    // Positive control: a run that only ever saw one branch has not measured atomicity at all.
    assert.deepEqual(statuses, ['completed', 'dispatched'], `the kill window never straddled the commit: ${JSON.stringify(rounds)}`)
    const leftovers = strays()
    for (const name of leftovers) assert.match(name, /^state\.json\.[0-9a-f-]{36}\.tmp$/, `unexpected leftover ${name}`)
    return { roundTripMs: roundTrip, rounds, statuses, leftoverFiles: leftovers, strayRounds: rounds.filter(entry => entry.strays.length > 0).map(entry => entry.round) }
  })

  await f.check('F8d-a-leftover-temporary-file-is-ignored-and-the-committed-document-wins', async () => {
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

  await f.check('F8e-a-damaged-document-is-storage_corrupt-and-is-left-exactly-as-found', async () => {
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
    // M7 = R20. N1 = C14 = R9 widened the guard with four shapes the product cannot write; the
    // unit tests pin all four, but 2차 판정 asked for at least one of them *here*, where the answer
    // is a real CLI response and the file on disk is measured before and after. Dangling `deps` is
    // the shape that is otherwise a well-formed document — nothing about it is torn.
    const document = JSON.parse(good.toString())
    document.tasks[0].deps = [`task_${'f'.repeat(12)}`]
    fs.writeFileSync(f.stateFile(), JSON.stringify(document))
    const danglingDigest = createHash('sha256').update(fs.readFileSync(f.stateFile())).digest('hex')
    const deps = {}
    for (const args of [['orchestration', 'task-list'], ['orchestration', 'task-create', '--spec', 'not on a broken document']]) {
      const response = await f.cli(args, { fail: true })
      assert.equal(response.error.code, 'storage_corrupt', JSON.stringify(response.error))
      deps[args.join(' ')] = response
    }
    assert.equal(createHash('sha256').update(fs.readFileSync(f.stateFile())).digest('hex'), danglingDigest,
      'a document with dangling deps must be left exactly as found')
    fs.writeFileSync(f.stateFile(), good)
    const recovered = await f.cli(['orchestration', 'task-list'])
    assert.ok(recovered.result.tasks.length > 0)
    return { responses, dangling, deps, recoveredTasks: recovered.result.tasks.length }
  })

  f.record('state-after-f8', f.stateJson())
} finally { await f.cleanup() }
