// LIFE-410 gate ② — the native-execution gate (00-analysis §7.3, 01-criteria 관문 ②).
//
// Everything else in `app/scripts/l410/` measures the *rules* against a stand-in provider, which is
// the honest thing to do for a rule but proves nothing about a provider. This script is the other
// half: one pane running the user's own `claude`, told to run corral commands and nothing else, and
// the F1·F2·F3·F4·F5·F7 sequence driven through it once by a real model.
//
// Three properties make it a gate rather than a demonstration:
//
//   1. the pane's foreground process is the user's installed executable, by realpath (l409 R6);
//   2. the preamble is typed into it exactly once, and the screen is counted, not assumed;
//   3. the user's global provider configuration is digested before and after, so what the run left
//      behind is measured rather than assumed — trust entries listed, everything else asserted.
//
// Every byte typed into the pane is tallied as it happens into `native/submissions.md`, because a
// count reconstructed afterwards is not a count. The budget is 8; the trust dialog is answered by
// reading the screen and typing, which is the LIFE-394 G3 path and is itself part of the evidence.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture, requestId } from './lib.mjs'
import { LIVE_PHASES, foregroundExecutable, waitForLaunch } from '../l409/native-checks.mjs'

const CLAUDE = process.env.L410_NATIVE_CLAUDE ?? path.join(os.homedir(), '.local/bin/claude')
assert(fs.existsSync(CLAUDE), `The native provider is expected at ${CLAUDE}`)
const version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()
const MODEL = process.env.L410_NATIVE_MODEL ?? 'sonnet'
// The worker's share of the cumulative budget. It was 8; the coordinator raised it to 9, once, on
// 2026-09-23 after r1's first run spent one submission and then failed on a harness over-assertion
// (it required the provider record's *total* row count to be frozen across a replay, and the
// provider was mid-answer). The frozen ceiling is 01-criteria's cumulative 12 across every party;
// this run stops the task at 10 of those. A third submission in one run is an `ask`, not a retry.
const BUDGET = 9
/** The same budget seen from the task rather than from one party: every owner's prompts together. */
const TOTAL_BUDGET = 12
const DIFF_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../l394/global-config-diff.mjs')

const f = await fixture('native', { expectedChecks: 9 })
/** Who this run's rows belong to in the shared ledger. `f.owner` is `CORRAL_VERIFY_OWNER`. */
const OWNER = f.owner
// l409 R6: `claude` resolves to an npm-global copy before the user's own launcher on this machine,
// so the fixture's own PATH puts the launcher's directory first. Nothing global is touched.
const NATIVE_BIN = path.dirname(CLAUDE)
// The provider runs on the user's own configuration, deliberately. LIFE-394 and LIFE-409 measured
// their native gates the same way (`app/scripts/l394/env.mjs` preserves `CLAUDE_CONFIG_DIR` on
// purpose — "dropping them moves the very account and record path"), and an isolated config cannot
// authenticate at all: the Keychain lookup is keyed to the default config directory, so a fixture
// config comes up "Not logged in · Run /login" and the gate cannot run. That measurement is in
// `native/auth-isolation-probe.{md,json}`. What the run leaves behind is a project/trust entry for
// one temporary directory, which is exactly what 01-criteria F14 exempts ("trust 항목 외 diff 0").
// Nothing is written to the user's settings, hooks or any configuration file by this script.
for (const target of [f.base, f.env]) {
  target.PATH = NATIVE_BIN + ':' + target.PATH
  // The provider updated the user's own install in the middle of the first attempt at this gate
  // (2.1.252 → 2.1.280). Suppressed the way PATH is pinned — in the fixture's environment, never in
  // the user's settings file.
  target.DISABLE_AUTOUPDATER = '1'
  // The session driving this script carries an API key, and a pane inherits the backend's
  // environment: left in place, the provider opens a "Detected a custom API key" dialog and, if
  // answered the other way, would bill this gate to a different credential than the user's own
  // install uses. Removed from the fixture's environment only — nothing global is touched.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete target[key]
}

/** The LIFE-394 collector, writing into this run's raw directory under its own salt. */
const diff = mode => execFileSync(process.execPath, [DIFF_SCRIPT, mode], {
  encoding: 'utf8',
  env: { ...process.env, L394_RAW: f.raw, L394_SALT_FILE: process.env.L410_SALT_FILE ?? '/tmp/l410-claude-salt' },
}).trim()

/**
 * Every byte this run puts into the pane, written down at the moment it is put there — and kept in
 * a ledger that survives across runs, because the budget in the TASK is cumulative, not per-run. An
 * entry with `typed: false` is a call that returned before it reached the pane (a submission stage
 * that never started); it is listed, and it does not spend the budget.
 */
/**
 * One ledger for the whole task, not one per party. The budget is cumulative across *everyone* who
 * runs this gate — worker and coordinator both — and two ledgers in two raw trees could not be
 * added up without someone re-deriving a total afterwards, which is exactly the number that must
 * never be reconstructed. So it lives beside the task's raw root and every row says who wrote it.
 * The r0 rows are migrated once, from the two places they were written, with their `n` preserved.
 */
const RAW_ROOT = path.resolve(f.app, '../specs/LIFE-410-cli-orchestration-workers/raw')
/**
 * V27. The ledger a run reads is the ledger of the *task*, and a run started from a checkout that
 * does not carry the latest rows would start from a smaller number than the one that was really
 * spent. Naming it explicitly is how a run in an implementation branch — whose own checkout is
 * always behind the task branch's copy — can be pointed at the real one. The default is the path
 * the committed ledger has always had, so nothing changes for a run that says nothing.
 */
const LEDGER = process.env.CORRAL_VERIFY_LEDGER
  ? path.resolve(process.env.CORRAL_VERIFY_LEDGER)
  : path.join(RAW_ROOT, 'submissions-ledger.json')
/**
 * Where the r0 rows came from, before the ledger above existed. `migrated()` runs only when there
 * is no ledger at all, which after r1 never happens — the committed ledger holds every row. Only
 * the worker's own source is listed now: the coordinator's delta lives in a raw directory this
 * branch does not carry, so naming it here promised rows that could never be read and would have
 * produced a silently short ledger on the one path that still calls this (V27).
 */
const MIGRATIONS = [
  { owner: 'claude', file: path.join(RAW_ROOT, 'worker/claude/native/submissions.json') },
]
fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
const migrated = () => {
  const rows = []
  for (const source of MIGRATIONS) {
    if (!fs.existsSync(source.file)) continue
    for (const row of JSON.parse(fs.readFileSync(source.file, 'utf8'))) rows.push({ ...row, owner: row.owner ?? source.owner })
  }
  return rows.sort((a, b) => a.n - b.n)
}
const submissions = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : migrated()
// The budget in the TASK is on *prompt submissions* — bodies put to the provider as work. A key
// answering a trust dialog is not one of those (LIFE-394 C6 treats dialog handling as its own
// thing), so the two are counted separately and both are listed. Neither count is reconstructed.
const prompts = rows => rows.filter(entry => entry.typed && entry.kind === 'terminal prompt').length
const spent = () => prompts(submissions.filter(entry => entry.owner === OWNER))
const total = () => prompts(submissions)
const keys = () => submissions.filter(entry => entry.typed && entry.kind === 'terminal send').length
const writeLedger = () => {
  fs.writeFileSync(LEDGER, JSON.stringify(submissions, null, 2) + '\n')
  const markdown = [
    '# LIFE-410 gate ② — every prompt submission, in order',
    '',
    `Budget: ${BUDGET} prompt submissions, **cumulative** across every run of this gate. A prompt submission is a`,
    'body put to the provider as work (`terminal prompt`). Keys typed to answer a dialog (`terminal send`) are not',
    'prompt submissions and are counted separately below, but every one of them is listed here too. Each row is',
    'written at the moment of the call, never reconstructed afterwards. `typed: false` is a call that returned before',
    'anything reached the pane; those are listed and spend nothing.',
    '',
    '| # | at | owner | run | kind | what | typed | detail |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...submissions.map(entry => {
      const rest = { ...entry }
      for (const key of ['n', 'at', 'owner', 'runId', 'kind', 'what', 'typed']) delete rest[key]
      return `| ${entry.n} | ${entry.at} | ${entry.owner ?? '?'} | ${entry.runId} | ${entry.kind} | ${entry.what} | ${entry.typed} | ${JSON.stringify(rest).replaceAll('|', '\\|')} |`
    }),
    '',
    `Prompt submissions by \`${OWNER}\`: ${spent()} of ${BUDGET}. Across every owner: ${total()} of ${TOTAL_BUDGET}.`,
    `Dialog keys: ${keys()}. Calls recorded in all: ${submissions.length}.`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(f.raw, 'submissions.md'), markdown)
  fs.writeFileSync(LEDGER.replace(/\.json$/, '.md'), markdown)
}
/**
 * V27. A budget checked after the call is not a budget. The row is written *before* the call that
 * could spend it, counted as spent from that moment, and the check that refuses runs before the
 * row exists — so at 12 of 12 nothing is called at all, and a run killed mid-submission still
 * leaves the spend on the ledger rather than losing it. `tally` then completes the row with what
 * the call actually did; a call that returned before anything reached the pane is refunded to
 * `typed: false`, which is the only direction a reservation is ever revised.
 */
const reserve = (kind, what, detail = {}) => {
  if (kind === 'terminal prompt') {
    assert.ok(spent() < BUDGET, `the prompt-submission budget of ${BUDGET} for ${OWNER} is spent (${spent()}); this call is not made`)
    assert.ok(total() < TOTAL_BUDGET, `the prompt-submission budget of ${TOTAL_BUDGET} across owners is spent (${total()}); this call is not made`)
  }
  const row = { n: submissions.length + 1, at: new Date().toISOString(), owner: OWNER, runId: f.runId, kind, what, typed: true, settled: false, ...detail }
  submissions.push(row)
  writeLedger()
  return row
}
const tally = (row, typed, detail = {}) => {
  row.typed = typed
  row.settled = true
  Object.assign(row, detail)
  writeLedger()
  assert.ok(spent() <= BUDGET, `the cumulative prompt-submission budget of ${BUDGET} for ${OWNER} is spent: ${JSON.stringify(submissions)}`)
  assert.ok(total() <= TOTAL_BUDGET, `the cumulative prompt-submission budget of ${TOTAL_BUDGET} across owners is spent: ${JSON.stringify(submissions)}`)
}
// The gate does not open at all on a spent budget: this runs before the backend is started, before
// a pane exists, and before the first provider process is launched.
assert.ok(total() < TOTAL_BUDGET, `the prompt-submission budget of ${TOTAL_BUDGET} across owners is already spent (${total()} in ${LEDGER}); this run does not start`)
assert.ok(spent() < BUDGET, `the prompt-submission budget of ${BUDGET} for ${OWNER} is already spent (${spent()} in ${LEDGER}); this run does not start`)

const screen = async handle => (await f.cli(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '16384'], { timeout: 60000 })).result.text ?? ''

/** The line typed before the paste — the product's own constant, repeated here so a drift shows up. */
const PROMPT_LEAD = 'The block pasted below is this session\'s task, delivered by corral. Follow it:'

/**
 * The provider's session record for one pane, read straight off disk. This is where corral's own
 * acceptance rule looks ("the record holds this body once"), so it is where this gate counts.
 */
function providerRows(sessionId, cwd) {
  const dir = path.join(os.homedir(), '.claude/projects', fs.realpathSync(cwd).replaceAll('/', '-').replaceAll('.', '-'))
  const file = path.join(dir, `${sessionId}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').flatMap(line => {
    let parsed
    try { parsed = JSON.parse(line) } catch { return [] }
    const content = parsed?.message?.content
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : ''
    return [{ role: parsed?.message?.role ?? parsed?.type ?? null, text }]
  })
}

/**
 * What the provider's record actually holds, counted as **occurrences** rather than as rows.
 *
 * Counting rows answers "how many messages contain this", which is not the invariant: two copies of
 * the body inside one message is still two deliveries, and a row-count of 1 would call that once
 * (V6/R12). Every count here is of the thing itself across the whole record — the preamble's first
 * line, the typed lead, and the paste wrapper's opening tag — so a second copy anywhere shows up.
 */
const occurrences = (text, needle) => text.split(needle).length - 1
function countRecord(sessionId) {
  const rows = providerRows(sessionId, f.repo)
  const bodies = rows.filter(row => row.role === 'user').map(row => row.text)
  const joined = bodies.join('\n')
  const delivered = occurrences(joined, 'You are a corral worker.')
  const wrapped = occurrences(joined, '<pasted_content id=')
  const lead = occurrences(joined, PROMPT_LEAD)
  return { rows, bodies, delivered, wrapped, lead,
    summary: { rows: rows.length, userRows: bodies.length, delivered, wrapped, leadLine: lead } }
}

/** The screens this gate knows how to answer, and the keys that answer them. */
const DIALOGS = [
  // The trust dialog's default option is "No, exit" — pressing Enter on it would end the provider,
  // so the answer is one Down followed by Enter, in a single send.
  { name: 'trust', when: /trust this folder|you trust\?|trust the files|Do you trust/i, text: '\u001b[B', keys: 'Down, Enter' },
  // Kept as a fallback even though the key is stripped above: its default answer is the safe one,
  // so this one is answered by confirming the default.
  { name: 'api-key', when: /Detected a custom API key|use this API key/i, text: '', keys: 'Enter (the default, "No")' },
]

/**
 * Answer whatever dialog the provider is holding, by reading the screen and typing — never by
 * pre-seeding a config key. Capped, classified, and every send tallied as it is made.
 */
async function clearDialogs(handle, { rounds = 4 } = {}) {
  const seen = []
  for (let round = 0; round < rounds; round++) {
    const text = await screen(handle)
    const dialog = DIALOGS.find(entry => entry.when.test(text)) ?? null
    seen.push({ round, at: new Date().toISOString(), dialog: dialog?.name ?? null, excerpt: text.slice(-1500) })
    f.record('native/dialogs', seen)
    if (dialog === null) break
    const keyRow = reserve('terminal send', `${dialog.name} dialog`, { handle, keys: dialog.keys })
    await f.cli(['terminal', 'send', '--terminal', handle, '--text', dialog.text, '--enter'], { timeout: 60000 })
    tally(keyRow, true)
    await f.pause(4000)
    // Answering a dialog must never have ended the provider.
    const after = await f.cli(['terminal', 'show', '--terminal', handle], { timeout: 60000 })
    assert.notEqual(after.result.agent?.phase, 'exited', `answering the ${dialog.name} dialog ended the provider`)
  }
  f.record('native/dialogs', seen)
  return seen
}

const TASK = [
  'Run the corral commands below in order, exactly as written, and do nothing else at all.',
  'Do not read, write or search any file. Do not run git. Do not run any command not listed here.',
  'Write the corral command exactly as the preamble above spells it, including its --socket flag.',
  '',
  '1. Send a heartbeat with --type heartbeat --subject "starting" --phase implementing.',
  '',
  '2. Ask the coordinator a question and wait for the answer:',
  '   --type: use `orchestration ask --question "Reply with one word." --timeout-ms 90000`.',
  '   If the JSON comes back with "state":"pending", run the command in its resumeCommand field',
  '   and wait again. Keep the answer body; you need it in step 4.',
  '',
  '3. Run this one command, which is EXPECTED TO FAIL:',
  '   `orchestration send --type heartbeat --subject "wrong id" --dispatch-id ctx_000000000000`',
  '   (with your own --task-id). Do NOT correct the id, do NOT retry it, do NOT investigate it.',
  '   Read the "code" field out of the JSON error and keep it for step 4.',
  '',
  '4. Report completion with --type worker_done --outcome succeeded, and put both of these in',
  '   --body: the answer you were given in step 2, and the error code you saw in step 3.',
  '',
  'Then stop and stay idle. Do not summarise anything to the user.',
].join('\n')

/**
 * The second Task's body, kept deliberately short. F9 is about the *injection* — one more preamble
 * and one more TASK into the pane a settled attempt owned — not about what the worker then does
 * with it, and asking for a round trip would cost turns the budget does not have.
 */
const REUSE_TASK = [
  'This pane has been handed a second Task by corral. Do nothing at all: run no command, read no',
  'file, change nothing. Reply with the single word ACK and then stay idle.',
].join('\n')

try {
  const before = diff('before')
  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 gate 2 — a native claude worker'])
  const taskId = (await f.cli(['orchestration', 'task-create', '--spec', TASK, '--title', 'native worker'])).result.task.id

  // --- F1: launch, dialog, one submission ------------------------------------------------------
  // Both calls that could deliver the body carry an explicit `--request-id`, so whichever of them
  // does can be replayed *verbatim* afterwards. A replay is only a replay when the input is
  // identical — the same id with different argv is `request_conflict` — and the whole point of the
  // check below is to replay the call that landed, not a similar one.
  const startArgs = ['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude',
    '--model', MODEL, '--worktree', f.repo, '--request-id', requestId(), '--timeout-ms', '120000']
  const resumeArgs = () => ['orchestration', 'worker-start', '--task', taskId, '--terminal', handle,
    '--request-id', resumeRequestId, '--timeout-ms', '120000']
  const resumeRequestId = requestId()
  const first = await f.check('GATE2-F1-worker-start-creates-the-pane-and-the-attempt-before-it-submits', async () => {
    const startRow = reserve('terminal prompt', 'preamble + TASK')
    const started = await f.cli(startArgs, { timeout: 200000 })
    assert.equal(started.result.stages.terminal.status, 'completed', JSON.stringify(started.result.stages))
    assert.equal(started.result.stages.dispatch.status, 'completed', JSON.stringify(started.result.stages))
    assert.ok(started.result.dispatchId, JSON.stringify(started.result))
    // `not_started` means the readiness gate never held and nothing was typed; anything else means
    // the submission call was made, so it spends the budget whether or not it was accepted.
    tally(startRow, started.result.stages.input.status !== 'not_started',
      { dispatchId: started.result.dispatchId, stage: started.result.stages.input.status })
    return started.result
  })
  const dispatchId = first.dispatchId
  const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
  const handle = shown.result.terminal
  const sessionId = (await f.cli(['terminal', 'show', '--terminal', handle], { timeout: 60000 })).result.agent.sessionId
  assert.match(String(sessionId), /^[0-9a-f-]{36}$/, 'the provider session id is how its record is found')

  await f.check('GATE2-the-pane-runs-the-users-own-claude', async () => {
    const dialogs = await clearDialogs(handle)
    const phase = await waitForLaunch(f, handle, { timeoutMs: 180000 })
    assert.ok(LIVE_PHASES.includes(phase.phase), phase.phase)
    const executable = await foregroundExecutable(f, handle, CLAUDE)
    const text = await screen(handle)
    f.record('native/screen-identity', { text })
    assert.doesNotMatch(text, /Not logged in|Please run \/login/i, 'an unauthenticated provider cannot run a single command')
    assert.match(text, /Claude Code|claude\.ai|Welcome to Claude|2\.1\.252|\?\s*for shortcuts/i)
    return { dialogs: dialogs.length, phase: phase.phase, executable, providerVersion: version, providerPath: fs.realpathSync(CLAUDE), model: MODEL }
  })

  await f.check('GATE2-F1-the-preamble-reaches-the-pane-exactly-once', async () => {
    let response = first, deliveryArgs = startArgs
    if (first.stages.input.status !== 'completed') {
      deliveryArgs = resumeArgs()
      // The readiness gate did not hold while the dialog was up, which is the documented resume
      // path: the same attempt, the same pane, and the submission that never happened.
      // Every one of these needs an explicit budget: the CLI's own default is ten seconds when
      // `--timeout-ms` is omitted, which is shorter than a real provider takes to accept a body.
      const ready = await f.cli(['terminal', 'wait', '--terminal', handle, '--for', 'agent-ready', '--timeout-ms', '120000'], { timeout: 200000 })
      assert.equal(ready.result.satisfied, true, JSON.stringify(ready.result))
      // Deliberately non-throwing: if the submission does not take, what the pane looks like at that
      // moment is the evidence, and it is gone once the fixture is cleaned up.
      const resumeRow = reserve('terminal prompt', 'preamble + TASK (resume)', { dispatchId })
      const attempt = await f.cliRaw(deliveryArgs, { timeout: 200000 })
      const envelope = attempt.json
      tally(resumeRow, envelope?.result?.stages?.input?.status !== 'not_started',
        { stage: envelope?.result?.stages?.input?.status ?? envelope?.error?.code ?? 'unknown' })
      if (envelope?.ok !== true) {
        f.record('native/failed-submission', {
          envelope,
          screen: (await f.cli(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '16384'], { timeout: 60000 })).result.text ?? '',
          raw: ((await f.cli(['terminal', 'read', '--terminal', handle, '--limit', '262144'], { timeout: 60000 })).result.text ?? '').slice(-8000),
          terminal: (await f.cli(['terminal', 'show', '--terminal', handle], { timeout: 60000 })).result,
        })
        assert.fail(`the submission did not take: ${JSON.stringify(envelope?.error ?? envelope)}`)
      }
      response = envelope.result
    }
    assert.equal(response.dispatchId, dispatchId, 'a resume never opens a second attempt')
    assert.equal(response.stages.input.status, 'completed', JSON.stringify(response.stages))
    assert.match(response.preamble.sha256, /^[0-9a-f]{64}$/)
    const stored = await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
    assert.equal(stored.result.worker.preambleSha256, response.preamble.sha256)
    // Counted in the provider's own session record, which is the invariant itself: "the record
    // holds this body once". The pane's raw output cannot be used for it — `terminal read` is
    // cursor-based, so the earlier screen reads have already consumed the submission by now.
    const counted = countRecord(sessionId)
    f.record('native/provider-record', {
      sessionId, ...counted.summary,
      firstUserRow: counted.bodies[0]?.slice(0, 400) ?? null, tailOfFirstUserRow: counted.bodies[0]?.slice(-200) ?? null,
      screen: await screen(handle),
    })
    assert.equal(counted.delivered, 1, `the body is in the provider's record ${counted.delivered} times`)
    assert.equal(counted.lead, 1, 'the typed lead has to be there once, as the start of that same message')
    assert.equal(counted.wrapped, 1, 'and the body arrived as one pasted block inside it')

    // The replay, measured where it matters. `worker-start` with the id this run already spent must
    // answer from the receipt and put nothing on the pane — and the proof of "nothing" is the
    // provider's own record, not the absence of an error (V13). It costs no submission: a replay is
    // by definition a call that does not reach the pane.
    //
    // The pass condition is exactly this, and no more: `replayed: true`, and the provider record
    // still holding `userRows: 1`, `delivered: 1`, `wrapped: 1` — counted as **occurrences** across
    // the record, not as rows containing them.
    // Only the delivery counts are compared. The total row count is not one of them: the provider
    // is answering the body it was just given, so its record grows with assistant rows while this
    // check runs, and a frozen `rows` would be a claim about the model's timing rather than about
    // the replay.
    const deliveries = summary => ({ userRows: summary.userRows, delivered: summary.delivered, wrapped: summary.wrapped, leadLine: summary.leadLine })
    const before = deliveries(counted.summary)
    // The pane's screen is recorded on both sides but not compared: the provider is mid-answer, so
    // it repaints on its own and an equality there would fail for reasons that have nothing to do
    // with the replay. What a second submission would actually add is a second body in the
    // provider's record, and that is what is asserted.
    const screenBefore = await screen(handle)
    // Reserved like any other submittable call. A replay is answered from the receipt and types
    // nothing, but that is only knowable once it has returned — so it is counted first and refunded
    // after, which is the direction that can never overspend.
    const replayRow = reserve('terminal prompt', 'replay of a delivered submission', { dispatchId, requestId: response.requestId })
    const replayed = await f.cli(deliveryArgs, { timeout: 200000 })
    tally(replayRow, false, { replayed: replayed.result.replayed })
    assert.equal(replayed.result.replayed, true, JSON.stringify(replayed.result))
    assert.equal(replayed.result.dispatchId, dispatchId)
    const afterReplay = countRecord(sessionId)
    assert.deepEqual(deliveries(afterReplay.summary), before, 'a replay must put nothing into the provider record')
    f.record('native/replay-after-delivery', { requestId: response.requestId, before, after: deliveries(afterReplay.summary),
      afterFull: afterReplay.summary, screenBefore, screenAfter: await screen(handle) })
    return { preamble: response.preamble, delivered: counted.delivered, wrapped: counted.wrapped, leadLine: counted.lead,
      promptRequestId: stored.result.worker.promptRequestId, replay: { requestId: response.requestId, replayed: replayed.result.replayed } }
  })

  await f.check('GATE2-F1-a-second-start-of-a-delivered-attempt-is-refused-and-types-nothing', async () => {
    const digest = f.stateDigest()
    const again = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--terminal', handle, '--timeout-ms', '120000'], { fail: true, timeout: 200000 })
    assert.equal(again.error.code, 'task_not_startable', JSON.stringify(again))
    assert.equal(again.error.resources.reason, 'dispatch_active')
    assert.equal(f.stateDigest(), digest, 'a refused start stores nothing')
    const again2 = countRecord(sessionId)
    assert.equal(again2.delivered, 1, 'and delivers nothing further')
    assert.equal(again2.wrapped, 1)
    return { error: again.error, record: again2.summary }
  })

  // --- F2 + F5: the question, and the batch it arrives in --------------------------------------
  await f.check('GATE2-F2-F5-the-worker-asks-and-the-coordinator-answers-through-the-mailbox', async () => {
    const received = await f.cli(['orchestration', 'check', '--block', '--types', 'question,heartbeat',
      '--timeout-ms', '600000'], { timeout: 620000 })
    assert.ok(received.result.count >= 1, JSON.stringify(received.result))
    // FIFO: whatever the worker sent first is first, and the heartbeat is step 1 of the TASK.
    const sequences = received.result.messages.map(entry => entry.sequence)
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), 'a batch is in sequence order')
    let asked = received.result.messages.find(entry => entry.type === 'question')
    let batch = received.result
    if (!asked) {
      await f.cli(['orchestration', 'check', '--ack', batch.deliveryId])
      batch = (await f.cli(['orchestration', 'check', '--block', '--types', 'question', '--timeout-ms', '600000'], { timeout: 620000 })).result
      asked = batch.messages.find(entry => entry.type === 'question')
    }
    assert.ok(asked, JSON.stringify(batch))
    assert.equal(asked.taskId, taskId)
    assert.equal(asked.dispatchId, dispatchId)
    assert.equal(asked.from.kind, 'worker')
    assert.equal(asked.from.paneId, shown.result.paneId, 'the question carries the pane it was asked from')
    const replied = await f.cli(['orchestration', 'reply', '--id', asked.id, '--body', 'GREEN'])
    assert.equal(replied.result.reply.replyTo, asked.id)
    // A second answer cannot overwrite one the worker may already have read.
    const twice = await f.cli(['orchestration', 'reply', '--id', asked.id, '--body', 'AMBER'], { fail: true })
    assert.equal(twice.error.code, 'already_answered', JSON.stringify(twice))
    await f.cli(['orchestration', 'check', '--ack', batch.deliveryId])
    return { asked, batch, replied: replied.result, twice: twice.error }
  })

  // --- F3 + F4: the report, and the refusal the worker was told to make ------------------------
  await f.check('GATE2-F3-F4-the-native-worker-reports-and-the-attempt-settles', async () => {
    let report = null
    let batch = null
    for (let round = 0; round < 6 && report === null; round++) {
      batch = (await f.cli(['orchestration', 'check', '--block', '--timeout-ms', '600000'], { timeout: 620000 })).result
      report = batch.messages.find(entry => entry.type === 'worker_done') ?? null
      await f.cli(['orchestration', 'check', '--ack', batch.deliveryId])
    }
    assert.ok(report, `no worker_done arrived: ${JSON.stringify(batch)}`)
    assert.equal(report.outcome, 'succeeded', JSON.stringify(report))
    assert.equal(report.from.kind, 'worker')
    assert.equal(report.from.paneId, shown.result.paneId, 'the report is accepted from the pane the attempt was bound to')
    // F4, run by the provider itself: the refused call is in the record as an error the worker read,
    // and it stored no message of its own.
    assert.match(report.body, /dispatch_not_found/, `the worker was asked to quote the refusal it got: ${report.body}`)
    const stored = f.stateJson()
    assert.equal(stored.messages.filter(entry => entry.dispatchId === 'ctx_000000000000').length, 0, 'a refused call stores nothing')
    const settled = await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
    assert.equal(settled.result.dispatch.status, 'completed', JSON.stringify(settled.result.dispatch))
    assert.equal(settled.result.dispatch.settledBy, 'worker_done', 'the 409 transition table settles it')
    assert.equal(settled.result.task.status, 'completed')
    assert.equal(settled.result.worker.capabilityRevokedReason, 'settled')
    return { report, dispatch: settled.result.dispatch, messages: stored.messages.length }
  })

  await f.check('GATE2-F4-F7-a-settled-native-worker-cannot-report-again-and-its-pane-is-taken-back', async () => {
    const digest = f.stateDigest()
    const late = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'again', '--body', 'x',
      '--task-id', taskId, '--dispatch-id', dispatchId, '--outcome', 'succeeded'],
    { env: { ...f.env, HERDR_PANE_ID: shown.result.paneId }, fail: true })
    assert.equal(late.error.code, 'illegal_transition', JSON.stringify(late))
    assert.equal(f.stateDigest(), digest)
    const panes = async () => (await f.cli(['terminal', 'list'])).result.terminals.map(entry => entry.handle)
    assert.ok((await panes()).includes(handle), 'the settled attempt leaves its pane standing until someone releases it')
    // The release is not made here: the pane is about to be handed to a second Task, and what F9
    // has to show is that the *old* attempt's release then closes nothing.
    return { late: late.error, paneStanding: true }
  })

  // --- F9: the same pane, a second Task ---------------------------------------------------------
  await f.check('GATE2-F9-a-second-task-takes-the-pane-over-and-the-old-release-closes-nothing', async () => {
    const panes = async () => (await f.cli(['terminal', 'list'])).result.terminals.map(entry => entry.handle)
    const before = countRecord(sessionId)
    assert.equal(before.delivered, 1, 'one body in the record before the second Task')
    const secondTask = (await f.cli(['orchestration', 'task-create', '--spec', REUSE_TASK, '--title', 'native reuse'])).result.task.id
    // A read, not a submission: the provider has just finished a turn and the submission below
    // needs it ready. Waiting here rather than inside worker-start makes a slow provider a slow
    // check instead of a spent submission.
    const ready = await f.cli(['terminal', 'wait', '--terminal', handle, '--for', 'agent-ready', '--timeout-ms', '120000'], { timeout: 200000 })
    assert.equal(ready.result.satisfied, true, JSON.stringify(ready.result))
    const reuseArgs = ['orchestration', 'worker-start', '--task', secondTask, '--terminal', handle,
      '--request-id', requestId(), '--timeout-ms', '120000']
    // Deliberately non-throwing, for the same reason as the first submission: if it does not take,
    // what the pane looked like at that moment is the evidence and it is gone after cleanup.
    const reuseRow = reserve('terminal prompt', 'preamble + TASK (F9 reuse)')
    const attempt = await f.cliRaw(reuseArgs, { timeout: 200000 })
    const envelope = attempt.json
    tally(reuseRow, envelope?.result?.stages?.input?.status !== 'not_started',
      { dispatchId: envelope?.result?.dispatchId ?? null, stage: envelope?.result?.stages?.input?.status ?? envelope?.error?.code ?? 'unknown' })
    if (envelope?.ok !== true || envelope.result.stages.input.status !== 'completed') {
      f.record('native/failed-reuse-submission', {
        envelope,
        screen: await screen(handle),
        raw: ((await f.cli(['terminal', 'read', '--terminal', handle, '--limit', '262144'], { timeout: 60000 })).result.text ?? '').slice(-8000),
      })
      assert.fail(`the reuse submission did not take: ${JSON.stringify(envelope?.error ?? envelope?.result?.stages ?? envelope)}`)
    }
    const reused = envelope.result
    assert.notEqual(reused.dispatchId, dispatchId, 'a second Task is a second attempt')
    assert.equal(reused.launch, 'reused', JSON.stringify(reused))
    assert.match(reused.preamble.sha256, /^[0-9a-f]{64}$/)
    // Exactly one more of each, counted as occurrences across the whole record.
    const after = countRecord(sessionId)
    f.record('native/provider-record-after-reuse', { sessionId, before: before.summary, after: after.summary })
    assert.equal(after.delivered, 2, `the record holds the body ${after.delivered} times after one more submission`)
    assert.equal(after.wrapped, 2, 'one more pasted block, not two')
    assert.equal(after.lead, 2, 'one more typed lead, not two')
    // Ownership moved with the pane.
    const oldOwner = await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
    const newOwner = await f.cli(['orchestration', 'worker-show', '--dispatch', reused.dispatchId])
    assert.equal(newOwner.result.worker.ownership, 'owned', JSON.stringify(newOwner.result.worker))
    assert.equal(newOwner.result.worker.originDispatchId, dispatchId)
    assert.equal(oldOwner.result.worker.ownership, 'borrowed', JSON.stringify(oldOwner.result.worker))
    assert.equal(oldOwner.result.worker.ownershipTransferredTo, reused.dispatchId)
    // The whole point of F9(b): releasing the attempt that created the pane must not close a pane
    // the new worker is using.
    const oldRelease = await f.cli(['orchestration', 'worker-release', '--dispatch', dispatchId], { timeout: 60000 })
    assert.equal(oldRelease.result.state, 'retained', JSON.stringify(oldRelease.result))
    assert.equal(oldRelease.result.processAction, 'none')
    assert.ok((await panes()).includes(handle), 'the pane the new worker holds must survive the old release')
    // And the current owner ends it. `worker-stop` rather than a second report: the point here is
    // the pane, and asking the provider for one more turn would cost another submission.
    const stopped = await f.cli(['orchestration', 'worker-stop', '--dispatch', reused.dispatchId], { timeout: 60000 })
    assert.equal(stopped.result.state, 'released', JSON.stringify(stopped.result))
    assert.equal(stopped.result.processAction, 'closed')
    assert.ok(!(await panes()).includes(handle), 'the pane is gone once its current owner ends')
    return { secondTask, dispatchId: reused.dispatchId, record: after.summary,
      oldOwner: oldOwner.result.worker, newOwner: newOwner.result.worker, oldRelease: oldRelease.result, stopped: stopped.result }
  })

  const after = diff('after')
  const reported = diff('diff')
  const summary = JSON.parse(fs.readFileSync(path.join(f.raw, 'global-diff.json'), 'utf8')).summary
  const full = JSON.parse(fs.readFileSync(path.join(f.raw, 'global-diff.json'), 'utf8'))

  await f.check('GATE2-F14-what-the-run-left-in-the-users-configuration-is-trust-and-nothing-else', async () => {
    // The strict half: nothing outside the provider's own JSON may move at all. The fixture owns its
    // backend, its herdr session and its userData, so a changed directory or a second changed file
    // would mean this run reached somewhere it had no business reaching.
    assert.deepEqual(summary.changedDirs, [], JSON.stringify(summary.changedDirs))
    const unexpectedFiles = summary.changedFiles.filter(file => !/\.claude\.json$/.test(String(file)))
    assert.deepEqual(unexpectedFiles, [], JSON.stringify(unexpectedFiles))
    // The listed half, per 01-criteria F14 ("trust 항목 외 diff 0(있으면 목록)"). Trust keys are the
    // exempted ones and are expected: the provider records that it was told this temporary
    // directory is trusted. Every other key path that moved inside `~/.claude.json` is listed by
    // name — and note that the session running this script is itself a `claude` process writing to
    // that file on every turn, so a zero there would be a claim about the session, not about the
    // measured pane. Key names only; no configuration value is read or recorded.
    const keysOf = detail => [...(detail.changed ?? []), ...(detail.added ?? []), ...(detail.removed ?? [])].map(String)
    const isTrust = key => /hasTrustDialogAccepted$|^trusted|^projects\./.test(key)
    const listed = Object.fromEntries(Object.entries(full.files ?? {})
      .filter(([, detail]) => keysOf(detail).length > 0)
      .map(([file, detail]) => [file, {
        trust: keysOf(detail).filter(isTrust),
        other: keysOf(detail).filter(key => !isTrust(key)),
      }]))
    f.record('native/f14-listed-key-paths', { note: 'key paths only; no configuration value is read or recorded', listed, summary })
    return { summary, listed, providerVersion: version, providerPath: fs.realpathSync(CLAUDE), before, after, reported }
  })

  // This one goes into the run's own directory and nowhere else. A copy at the owner's raw root
  // was a second, undated file that the *next* run silently overwrote, so the round that wrote it
  // could not be told from the round that read it (V14).
  const markdown = [
    '# LIFE-410 F14 — the user\'s global provider configuration, before and after gate ②',
    '',
    `- provider: \`${CLAUDE}\` → \`${fs.realpathSync(CLAUDE)}\` (\`${version}\`), \`--model ${MODEL}\``,
    '- the provider ran on the user\'s own configuration, deliberately: an isolated `CLAUDE_CONFIG_DIR` cannot',
    '  authenticate (the Keychain lookup is keyed to the default config directory), so the gate could not run at all.',
    '  The measurement is in `native/auth-isolation-probe.md`. Nothing was written to the user\'s settings or hooks',
    '  by this script; what the provider itself records is a project/trust entry for one temporary directory',
    '- `ANTHROPIC_API_KEY` was removed from the fixture environment, so the pane used the same credential the user\'s',
    '  own install uses, and `DISABLE_AUTOUPDATER=1` was set there too — in the environment, never in a settings file',
    '- trust was **not** pre-seeded: the trust dialog was answered by reading the screen and typing (`native/dialogs.json`)',
    '- window: `before` immediately before the backend starts, `after` immediately after the pane is closed',
    '- collector: `app/scripts/l394/global-config-diff.mjs` (salted value digests; no value is written out)',
    `- prompt submissions: ${spent()} of ${BUDGET} cumulative; dialog keys: ${keys()}; calls recorded in all: ${submissions.length}`,
    '- installed herdr, the user\'s PATH, the Orca app and the user\'s default session: untouched',
    '',
    '## Result',
    '',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    '',
    '## How to read it',
    '',
    'Two claims, of different strengths:',
    '',
    '1. **Asserted zero.** No directory changed, and no file outside `~/.claude.json` changed. This run owned its',
    '   backend, its herdr session and its userData, so movement in either would mean it reached somewhere it should not.',
    '2. **Listed, not asserted.** Key paths inside `~/.claude.json` are listed in `native/f14-listed-key-paths.json`,',
    '   split into trust entries and everything else, by name and never by value. Trust entries are expected and are',
    '   what 01-criteria F14 exempts: the provider records that it was told one temporary directory is trusted. The',
    '   rest are listed because that file is shared mutable state — the worker session that ran this script is itself a',
    '   `claude` process writing to it on every turn, so a zero there would be a claim about the session, not the pane.',
    '',
    `- \`before\`: ${before}`,
    `- \`after\`: ${after}`,
    `- \`diff\`: ${reported.replace(/\n\s*/g, ' ')}`,
    '',
    '## Raw',
    '',
    '- `global-before.json`, `global-after.json`, `global-diff.json`, `native/f14-listed-key-paths.json` in this run\'s directory',
    '- submissions: `submissions.md` · dialogs answered: `native/dialogs.json` · run record: `run.json`',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(f.raw, 'global-config-diff.md'), markdown)
  f.record('native/state', f.stateJson())
  f.record('native/worker-list', (await f.cli(['orchestration', 'worker-list', '--limit', '100'])).result)
  console.log(markdown)
} finally { await f.cleanup() }
