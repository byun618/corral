// LIFE-410 F1 — worker-start: what it composes, what it refuses, and what it leaves behind.
//
// The provider here is a stand-in that never reaches the ready gate, which is the point: it lets
// the *composition* be measured — pane, attempt, residual resources, the refusal to start a second
// attempt — without submitting anything to a real model. The half of F1 that needs a real preamble
// to land on a real screen is measured by `native.mjs`, and only that run counts for gate ②.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture, requestId } from './lib.mjs'

const f = await fixture('f1', { expectedChecks: 8 })
try {
  // A stand-in named `claude`, first on this fixture's PATH only. Nothing global is touched.
  const fakebin = path.join(f.root, 'fakebin')
  fs.mkdirSync(fakebin, { mode: 0o700 })
  fs.writeFileSync(path.join(fakebin, 'claude'), '#!/bin/sh\nprintf "STAND_IN_PROVIDER\\n"\nexec sleep 600\n', { mode: 0o700 })
  f.base.PATH = fakebin + ':' + f.base.PATH
  f.env.PATH = f.base.PATH

  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F1 — worker-start composition'])
  const task = async title => (await f.cli(['orchestration', 'task-create', '--spec', `run the corral commands the preamble lists (${title})`, '--title', title])).result.task.id
  const taskA = await task('a')

  await f.check('F1-a-pane-with-no-managed-agent-is-refused-with-no-effect', async () => {
    const bare = await f.pane('bare-shell')
    const before = f.stateDigest()
    const refused = await f.cli(['orchestration', 'worker-start', '--task', taskA, '--terminal', bare.handle], { fail: true })
    assert.equal(refused.error.code, 'agent_not_found', JSON.stringify(refused))
    assert.equal(f.stateDigest(), before, 'a refused worker-start must leave the stored bytes untouched')
    const listed = await f.cli(['orchestration', 'worker-list'])
    assert.equal(listed.result.totalCount, 0)
    return { error: refused.error, bare: bare.handle }
  })

  await f.check('F1-argument-pairings-are-refused-before-anything-is-created', async () => {
    const cases = [
      [['--task', taskA], 'exactly one of --terminal or --agent'],
      [['--task', taskA, '--agent', 'claude'], 'requires --worktree'],
      [['--task', taskA, '--agent', 'claude', '--worktree', f.repo, '--terminal', 't1.x'], 'exactly one'],
    ]
    const before = f.stateDigest()
    const errors = []
    for (const [args] of cases) {
      const refused = await f.cli(['orchestration', 'worker-start', ...args], { fail: true })
      assert.equal(refused.error.code, 'invalid_argument', JSON.stringify(refused))
      errors.push(refused.error.message)
    }
    // A re-used pane keeps the agent it was started with, so a resolution flag is refused outright.
    const bare = (await f.cli(['terminal', 'list'])).result.terminals[0]
    const mixed = await f.cli(['orchestration', 'worker-start', '--task', taskA, '--terminal', bare.handle, '--model', 'opus'], { fail: true })
    assert.equal(mixed.error.code, 'invalid_argument', JSON.stringify(mixed))
    errors.push(mixed.error.message)
    assert.equal(f.stateDigest(), before)
    return errors
  })

  const started = await f.check('F1-the-composition-reports-every-stage-and-its-residue', async () => {
    const response = await f.cli(['orchestration', 'worker-start', '--task', taskA, '--agent', 'claude',
      '--worktree', f.repo, '--title', 'l410-f1'], { timeout: 180000 })
    const result = response.result
    // The pane and the attempt are made; the submission is not, because this stand-in never becomes
    // ready. That is reported as `incomplete` with the attempt named in residualResources — not as
    // a success, and not by undoing the pane.
    assert.equal(result.stages.terminal.status, 'completed', JSON.stringify(result.stages))
    assert.equal(result.stages.dispatch.status, 'completed', JSON.stringify(result.stages))
    // The stand-in is registered as an agent but is not the pane foreground, so the submission is
    // refused by the backend. Which of the two ways the input stage fails is not the point; that it
    // fails, says so, and does not report a delivered preamble is.
    assert.ok(['not_started', 'failed', 'unknown'].includes(result.stages.input.status), JSON.stringify(result.stages))
    assert.equal(result.state, 'incomplete')
    assert.equal(result.launch, 'created')
    assert.deepEqual(result.effects.map(entry => [entry.kind, entry.action]), [['terminal', 'created'], ['dispatch', 'created']])
    assert.equal(result.residualResources.length, 1)
    assert.equal(result.residualResources[0].kind, 'dispatch')
    assert.match(result.residualResources[0].action, /worker-stop --dispatch/)
    assert.match(result.dispatchId, /^ctx_[0-9a-f]{12}$/)
    // The stored attempt owns the pane it created and has no delivered preamble.
    const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', result.dispatchId])
    assert.equal(shown.result.worker.ownership, 'owned')
    assert.equal(shown.result.worker.launch, 'created')
    assert.equal(shown.result.worker.originDispatchId, result.dispatchId)
    assert.equal(shown.result.worker.promptRequestId, null)
    // The digest of the body is recorded when the attempt is created, before anything is sent —
    // it is what a resume compares against, and an attempt that never delivered is exactly the
    // one that needs it (V4). `promptRequestId` is still what says whether a body was delivered.
    assert.match(shown.result.worker.preambleSha256, /^[0-9a-f]{64}$/, JSON.stringify(shown.result.worker))
    assert.equal(shown.result.workerState, 'working')
    return { result, shown: shown.result }
  })

  await f.check('F1-the-same-request-id-replays-and-creates-nothing-new', async () => {
    const id = requestId()
    const taskB = await task('b')
    const first = await f.cli(['orchestration', 'worker-start', '--task', taskB, '--agent', 'claude', '--worktree', f.repo, '--request-id', id], { timeout: 180000 })
    const panes = (await f.cli(['terminal', 'list'])).result.totalCount
    // What a replay must not do is put anything else on the screen. The record staying still is
    // the weaker half of that — a second submission would be visible in the pane whether or not it
    // were recorded — so the pane's own screen is compared across the replay as well. The half of
    // this that needs a body actually to have been delivered first is in `native.mjs`: a stand-in
    // never reaches the ready gate, so nothing here has been submitted to compare against.
    const screen = async () => (await f.cli(['orchestration', 'worker-read', '--dispatch', first.result.dispatchId, '--screen'], { timeout: 60000 })).result.output.text
    const beforeScreen = await screen()
    // Taken after that read, not before it: a read still runs the reconcile pass, and a pass that
    // changed something writes it. The digest has to bracket the replay alone.
    const digest = f.stateDigest()
    const replayed = await f.cli(['orchestration', 'worker-start', '--task', taskB, '--agent', 'claude', '--worktree', f.repo, '--request-id', id], { timeout: 180000 })
    assert.equal(replayed.result.replayed, true, JSON.stringify(replayed.result))
    assert.equal(replayed.result.dispatchId, first.result.dispatchId)
    assert.equal((await f.cli(['terminal', 'list'])).result.totalCount, panes, 'a replay must not create a second pane')
    assert.equal(f.stateDigest(), digest, 'a replay must not write again')
    assert.equal(await screen(), beforeScreen, 'a replay must not put anything on the pane')
    return { dispatchId: first.result.dispatchId, replayed: replayed.result.replayed, panes, screen: beforeScreen.slice(0, 200) }
  })

  await f.check('F1-a-second-attempt-on-a-task-that-already-delivered-one-is-refused', async () => {
    // The open attempt above never delivered its preamble, so worker-start resumes it rather than
    // refusing — that is still exactly once. Mark it delivered by the only route that can: a
    // successful submission. There is none here, so the refusal is measured on an attempt whose
    // input stage is recorded as done, which `f7-recovery.mjs` reaches through the same path.
    const before = f.stateDigest()
    const panes = (await f.cli(['terminal', 'list'])).result.totalCount
    const resumed = await f.cli(['orchestration', 'worker-start', '--task', taskA, '--agent', 'claude', '--worktree', f.repo], { timeout: 180000 })
    assert.equal(resumed.result.dispatchId, started.result.dispatchId, 'a resume re-uses the attempt, it does not create one')
    assert.equal(resumed.result.stages.dispatch.action, 'resumed')
    // A resume is neither `created` nor `reused`, and it says which options it could not honour
    // rather than dropping them in silence (V17/V18).
    assert.equal(resumed.result.launch, 'resumed', JSON.stringify(resumed.result))
    assert.deepEqual([...resumed.result.ignoredOptions].sort(), ['--agent', '--worktree'], JSON.stringify(resumed.result.ignoredOptions))
    assert.equal((await f.cli(['terminal', 'list'])).result.totalCount, panes, 'a resume must not create a second pane')
    const after = await f.cli(['orchestration', 'worker-show', '--dispatch', started.result.dispatchId])
    assert.equal(after.result.dispatch.attempt, 1, 'the attempt number must not move')
    assert.equal(after.result.worker.preambleSha256, started.shown.worker.preambleSha256, 'a resume rebuilds the same body it was created against')
    return { before, dispatchId: resumed.result.dispatchId, stage: resumed.result.stage, stages: resumed.result.stages, ignoredOptions: resumed.result.ignoredOptions }
  })

  await f.check('F1-a-resume-delivers-the-body-the-attempt-was-created-against-or-nothing', async () => {
    // Two halves of the same rule. A `--spec-file` handed to a resume of an attempt created from
    // the Task spec is *ignored* and said so — re-reading it is how the same Dispatch could receive
    // two different TASK bodies under two promptIds (V4). And an attempt created from a file the
    // record does not hold cannot be resumed at all: the body it was created against is not
    // reproducible, the digest says so, and the refusal points at worker-stop rather than
    // delivering a body nobody chose.
    const other = path.join(f.root, 'changed-spec.md')
    fs.writeFileSync(other, 'a different body entirely\n')
    const ignored = await f.cli(['orchestration', 'worker-start', '--task', taskA, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', other], { timeout: 180000 })
    assert.equal(ignored.result.launch, 'resumed', JSON.stringify(ignored.result))
    assert.ok(ignored.result.ignoredOptions.includes('--spec-file'), JSON.stringify(ignored.result.ignoredOptions))
    assert.equal(ignored.result.dispatchId, started.result.dispatchId)

    const taskD = await task('d')
    const fromFile = await f.cli(['orchestration', 'worker-start', '--task', taskD, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', other], { timeout: 180000 })
    assert.equal(fromFile.result.state, 'incomplete', JSON.stringify(fromFile.result))
    const before = f.stateDigest()
    const panes = (await f.cli(['terminal', 'list'])).result.totalCount
    // V26. The same file resumes the attempt it created: the body is read *now*, compared with the
    // digest the Dispatch stored, and it is the comparison — not the flag — that decides. In r1
    // this was `preamble_mismatch` however faithful the file was, and the only way out was to kill
    // a worker that might already be working.
    const resumed = await f.cli(['orchestration', 'worker-start', '--task', taskD, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', other], { timeout: 180000 })
    assert.equal(resumed.result.launch, 'resumed', JSON.stringify(resumed.result))
    assert.equal(resumed.result.dispatchId, fromFile.result.dispatchId)
    assert.ok(!resumed.result.ignoredOptions.includes('--spec-file'), JSON.stringify(resumed.result.ignoredOptions))
    // …and a *changed* file is still refused, which is the whole of V4 and is not loosened by V26.
    fs.writeFileSync(other, 'a different body entirely, changed since the attempt was made\n')
    const afterChange = f.stateDigest()
    const refused = await f.cli(['orchestration', 'worker-start', '--task', taskD, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', other], { fail: true, timeout: 180000 })
    assert.equal(refused.error.code, 'preamble_mismatch', JSON.stringify(refused))
    assert.equal(refused._meta.outcome, 'not_started', JSON.stringify(refused._meta))
    assert.match(refused.error.resources.recovery, /worker-stop/)
    assert.equal(f.stateDigest(), afterChange, 'a refused resume must not write')
    assert.equal((await f.cli(['terminal', 'list'])).result.totalCount, panes, 'a refused resume must not create a pane')
    fs.writeFileSync(other, 'a different body entirely\n')
    return { ignored: ignored.result.ignoredOptions, resumed: resumed.result.launch, refused: refused.error, digestUnchanged: before === afterChange }
  })

  await f.check('F1-a-file-a-resume-was-never-going-to-read-is-not-opened', async () => {
    // V28. `--spec-file` on a resume of a Task-spec attempt is ignored, and "ignored" has to mean
    // the file is never touched: r1 read it before deciding, so naming a path that no longer
    // existed refused a resume the file had nothing to do with — and spent the request id doing it.
    const missing = path.join(f.root, 'there-is-no-such-file.md')
    assert.ok(!fs.existsSync(missing))
    const before = f.stateDigest()
    const ignored = await f.cli(['orchestration', 'worker-start', '--task', taskA, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', missing], { timeout: 180000 })
    assert.equal(ignored.result.launch, 'resumed', JSON.stringify(ignored.result))
    assert.ok(ignored.result.ignoredOptions.includes('--spec-file'), JSON.stringify(ignored.result.ignoredOptions))
    assert.equal(ignored.result.dispatchId, started.result.dispatchId)
    // A new attempt is a different question: there the file *is* the body, so an unreadable one is
    // still `invalid_argument` and still writes nothing.
    const fresh = await task('e')
    const panes = (await f.cli(['terminal', 'list'])).result.totalCount
    const refused = await f.cli(['orchestration', 'worker-start', '--task', fresh, '--agent', 'claude', '--worktree', f.repo,
      '--spec-file', missing], { fail: true, timeout: 180000 })
    assert.equal(refused.error.code, 'invalid_argument', JSON.stringify(refused))
    assert.equal(refused._meta.outcome, 'not_started', JSON.stringify(refused._meta))
    assert.equal((await f.cli(['terminal', 'list'])).result.totalCount, panes, 'a refused start must not create a pane')
    return { ignoredOnResume: ignored.result.ignoredOptions, refusedOnStart: refused.error, digestBefore: before }
  })

  await f.check('F1-an-unregistered-worktree-fails-the-terminal-stage-and-creates-no-attempt', async () => {
    const taskC = await task('c')
    const before = (await f.cli(['orchestration', 'worker-list'])).result.totalCount
    const failed = await f.cli(['orchestration', 'worker-start', '--task', taskC, '--agent', 'claude',
      '--worktree', path.join(f.root, 'not-a-worktree')], { timeout: 60000 })
    assert.equal(failed.result.state, 'failed', JSON.stringify(failed.result))
    assert.equal(failed.result.stage, 'terminal')
    assert.equal(failed.result.dispatchId, null)
    assert.equal(failed.result.stages.dispatch.status, 'not_started')
    assert.equal((await f.cli(['orchestration', 'worker-list'])).result.totalCount, before, 'no attempt may be recorded for a pane that was never made')
    return failed.result
  })
  f.record('f1-state', f.stateJson())
  f.record('f1-worker-list', (await f.cli(['orchestration', 'worker-list'])).result)
} finally { await f.cleanup() }
