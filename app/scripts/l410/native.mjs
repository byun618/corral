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
//   3. the provider's global configuration is isolated (`CLAUDE_CONFIG_DIR` inside the fixture) and
//      the user's own is digested before and after, so F14 is asserted rather than hoped for.
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
import { fixture } from './lib.mjs'
import { LIVE_PHASES, foregroundExecutable, waitForLaunch } from '../l409/native-checks.mjs'

const CLAUDE = process.env.L410_NATIVE_CLAUDE ?? path.join(os.homedir(), '.local/bin/claude')
assert(fs.existsSync(CLAUDE), `The native provider is expected at ${CLAUDE}`)
const version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()
const MODEL = process.env.L410_NATIVE_MODEL ?? 'sonnet'
const BUDGET = 8
const DIFF_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../l394/global-config-diff.mjs')

const f = await fixture('native', { expectedChecks: 8 })
// l409 R6: `claude` resolves to an npm-global copy before the user's own launcher on this machine,
// so the fixture's own PATH puts the launcher's directory first. Nothing global is touched.
const NATIVE_BIN = path.dirname(CLAUDE)
// The provider's configuration lives inside the fixture for the length of this run, so the pane
// cannot write to the user's `~/.claude.json` or `~/.claude/` at all. Panes inherit the backend's
// environment and nothing else, so both of these have to be set before the backend is started.
const CONFIG_DIR = path.join(f.root, 'claude-config')
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
// Onboarding and the account link, but never trust. A virgin config asks for a theme and a login
// before it ever asks about the directory, and each of those screens would cost a submission out
// of the budget — the first attempt at this gate came up "Not logged in · Please run /login".
//
// The credentials themselves live in the macOS Keychain, not in this file; what the config holds is
// only which account they belong to. So the user's `~/.claude.json` is *read* for `oauthAccount`
// and `userID` and those two are written into the fixture's own config. Nothing is written back,
// and no token passes through here. The trust dialog is deliberately left to be answered by hand:
// answering it from the screen is the evidence this gate exists to produce.
const userConfig = path.join(os.homedir(), '.claude.json')
const account = fs.existsSync(userConfig) ? JSON.parse(fs.readFileSync(userConfig, 'utf8')) : {}
fs.writeFileSync(path.join(CONFIG_DIR, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', installMethod: 'native', autoUpdates: false,
  oauthAccount: account.oauthAccount, userID: account.userID,
}, null, 2) + '\n', { mode: 0o600 })
for (const target of [f.base, f.env]) {
  target.PATH = NATIVE_BIN + ':' + target.PATH
  target.CLAUDE_CONFIG_DIR = CONFIG_DIR
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
const LEDGER = path.join(path.resolve(f.app, '../specs/LIFE-410-cli-orchestration-workers/raw/worker/claude'), 'native/submissions.json')
fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
const submissions = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : []
const spent = () => submissions.filter(entry => entry.typed).length
const tally = (kind, what, typed, detail) => {
  submissions.push({ n: submissions.length + 1, at: new Date().toISOString(), runId: f.runId, kind, what, typed, ...detail })
  fs.writeFileSync(LEDGER, JSON.stringify(submissions, null, 2) + '\n')
  const markdown = [
    '# LIFE-410 gate ② — every prompt submission, in order',
    '',
    `Budget: ${BUDGET} **cumulative**, across every run of this gate. A submission is anything put into the pane:`,
    'a `terminal prompt` body, or a `terminal send` answering a dialog. Each row is written at the moment of the',
    'call, never reconstructed afterwards. `typed: false` is a call that returned before anything reached the pane',
    '(a submission stage that never started); those are listed and do not spend the budget.',
    '',
    '| # | at | run | kind | what | typed | detail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...submissions.map(entry => {
      const rest = { ...entry }
      for (const key of ['n', 'at', 'runId', 'kind', 'what', 'typed']) delete rest[key]
      return `| ${entry.n} | ${entry.at} | ${entry.runId} | ${entry.kind} | ${entry.what} | ${entry.typed} | ${JSON.stringify(rest).replaceAll('|', '\\|')} |`
    }),
    '',
    `Spent: ${submissions.filter(entry => entry.typed).length} of ${BUDGET} (${submissions.length} calls recorded).`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(f.raw, 'submissions.md'), markdown)
  fs.writeFileSync(path.join(path.dirname(LEDGER), 'submissions.md'), markdown)
  assert.ok(spent() <= BUDGET, `the cumulative submission budget of ${BUDGET} is spent: ${JSON.stringify(submissions)}`)
}

const screen = async handle => (await f.cli(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '16384'], { timeout: 60000 })).result.text ?? ''

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
    tally('terminal send', `${dialog.name} dialog`, true, { handle, keys: dialog.keys })
    await f.cli(['terminal', 'send', '--terminal', handle, '--text', dialog.text, '--enter'], { timeout: 60000 })
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

try {
  const before = diff('before')
  await f.startBackend()
  await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 gate 2 — a native claude worker'])
  const taskId = (await f.cli(['orchestration', 'task-create', '--spec', TASK, '--title', 'native worker'])).result.task.id

  // --- F1: launch, dialog, one submission ------------------------------------------------------
  const first = await f.check('GATE2-F1-worker-start-creates-the-pane-and-the-attempt-before-it-submits', async () => {
    const started = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--agent', 'claude',
      '--model', MODEL, '--worktree', f.repo], { timeout: 200000 })
    assert.equal(started.result.stages.terminal.status, 'completed', JSON.stringify(started.result.stages))
    assert.equal(started.result.stages.dispatch.status, 'completed', JSON.stringify(started.result.stages))
    assert.ok(started.result.dispatchId, JSON.stringify(started.result))
    // `not_started` means the readiness gate never held and nothing was typed; anything else means
    // the submission call was made, so it spends the budget whether or not it was accepted.
    tally('terminal prompt', 'preamble + TASK', started.result.stages.input.status !== 'not_started',
      { dispatchId: started.result.dispatchId, stage: started.result.stages.input.status })
    return started.result
  })
  const dispatchId = first.dispatchId
  const shown = await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
  const handle = shown.result.terminal

  await f.check('GATE2-the-pane-runs-the-users-own-claude', async () => {
    const dialogs = await clearDialogs(handle)
    const phase = await waitForLaunch(f, handle, { timeoutMs: 180000 })
    assert.ok(LIVE_PHASES.includes(phase.phase), phase.phase)
    const executable = await foregroundExecutable(f, handle, CLAUDE)
    const text = await screen(handle)
    f.record('native/screen-identity', { text })
    assert.doesNotMatch(text, /Not logged in|Please run \/login/i, 'the isolated provider config has to carry the account link')
    assert.match(text, /Claude Code|claude\.ai|Welcome to Claude|2\.1\.252|\?\s*for shortcuts/i)
    return { dialogs: dialogs.length, phase: phase.phase, executable, providerVersion: version, providerPath: fs.realpathSync(CLAUDE), model: MODEL }
  })

  await f.check('GATE2-F1-the-preamble-reaches-the-pane-exactly-once', async () => {
    let response = first
    if (first.stages.input.status !== 'completed') {
      // The readiness gate did not hold while the dialog was up, which is the documented resume
      // path: the same attempt, the same pane, and the submission that never happened.
      await f.cli(['terminal', 'wait', '--terminal', handle, '--for', 'agent-ready'], { timeout: 200000 })
      response = (await f.cli(['orchestration', 'worker-start', '--task', taskId, '--terminal', handle], { timeout: 200000 })).result
      tally('terminal prompt', 'preamble + TASK (resume)', response.stages.input.status !== 'not_started',
        { dispatchId, stage: response.stages.input.status })
    }
    assert.equal(response.dispatchId, dispatchId, 'a resume never opens a second attempt')
    assert.equal(response.stages.input.status, 'completed', JSON.stringify(response.stages))
    assert.match(response.preamble.sha256, /^[0-9a-f]{64}$/)
    const stored = await f.cli(['orchestration', 'worker-show', '--dispatch', dispatchId])
    assert.equal(stored.result.worker.preambleSha256, response.preamble.sha256)
    // Counted on the pane's own output, not inferred from the record.
    const text = (await f.cli(['terminal', 'read', '--terminal', handle, '--limit', '262144'], { timeout: 60000 })).result.text ?? ''
    const copies = (text.match(/You are a corral worker\./g) ?? []).length
    f.record('native/pane-after-submission', { copies, bytes: text.length, text: text.slice(0, 20000) })
    assert.equal(copies, 1, `the preamble appears ${copies} times on the pane`)
    return { preamble: response.preamble, copies, promptRequestId: stored.result.worker.promptRequestId }
  })

  await f.check('GATE2-F1-a-second-start-of-a-delivered-attempt-is-refused-and-types-nothing', async () => {
    const digest = f.stateDigest()
    const again = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--terminal', handle], { fail: true, timeout: 200000 })
    assert.equal(again.error.code, 'task_not_startable', JSON.stringify(again))
    assert.equal(again.error.resources.reason, 'dispatch_active')
    assert.equal(f.stateDigest(), digest, 'a refused start stores nothing')
    const text = (await f.cli(['terminal', 'read', '--terminal', handle, '--limit', '262144'], { timeout: 60000 })).result.text ?? ''
    assert.equal((text.match(/You are a corral worker\./g) ?? []).length, 1, 'and types nothing')
    return again.error
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
    assert.ok((await panes()).includes(handle))
    const released = await f.cli(['orchestration', 'worker-release', '--dispatch', dispatchId], { timeout: 60000 })
    assert.equal(released.result.state, 'released', JSON.stringify(released.result))
    assert.equal(released.result.processAction, 'closed')
    assert.equal(released.result.reason, 'owned_generation_matches')
    assert.ok(!(await panes()).includes(handle), 'the pane corral started for this attempt is gone')
    return { late: late.error, released: released.result }
  })

  const after = diff('after')
  const reported = diff('diff')
  const summary = JSON.parse(fs.readFileSync(path.join(f.raw, 'global-diff.json'), 'utf8')).summary
  const full = JSON.parse(fs.readFileSync(path.join(f.raw, 'global-diff.json'), 'utf8'))

  await f.check('GATE2-F14-the-users-own-provider-configuration-was-not-what-this-run-wrote-to', async () => {
    // The strict half. The pane's configuration lived inside the fixture, so no trust key of the
    // user's may have moved: if one did, the isolation failed and the gate fails with it.
    const trustMoved = Object.entries(full.files ?? {}).flatMap(([file, detail]) =>
      [...(detail.changed ?? []), ...(detail.added ?? []), ...(detail.removed ?? [])]
        .filter(key => /hasTrustDialogAccepted$|^trusted/.test(String(key)))
        .map(key => `${file}:${key}`))
    assert.deepEqual(trustMoved, [], `a trust key of the user's own configuration moved: ${JSON.stringify(trustMoved)}`)
    // Nothing outside the provider's own JSON may move at all.
    assert.deepEqual(summary.changedDirs, [], JSON.stringify(summary.changedDirs))
    const unexpectedFiles = summary.changedFiles.filter(file => !/\.claude\.json$/.test(String(file)))
    assert.deepEqual(unexpectedFiles, [], JSON.stringify(unexpectedFiles))
    // The listed half, per 01-criteria F14 ("trust 항목 외 diff 0(있으면 목록)"). `~/.claude.json`
    // is shared mutable state: the session driving this script is itself a `claude` process writing
    // to it every turn, so key paths that move there are listed and attributed rather than asserted
    // to zero. Key names only — no value is read or recorded.
    const listed = Object.fromEntries(Object.entries(full.files ?? {})
      .filter(([, detail]) => (detail.changed ?? []).length + (detail.added ?? []).length + (detail.removed ?? []).length > 0)
      .map(([file, detail]) => [file, { added: detail.added ?? [], removed: detail.removed ?? [], changed: detail.changed ?? [] }]))
    f.record('native/f14-listed-key-paths', { note: 'key paths only; no configuration value is read or recorded', listed, summary })
    return { summary, trustMoved, listed, configDir: CONFIG_DIR, before, after, reported }
  })

  const rawRoot = path.resolve(f.app, '../specs/LIFE-410-cli-orchestration-workers/raw/worker/claude')
  const markdown = [
    '# LIFE-410 F14 — the user\'s global provider configuration, before and after gate ②',
    '',
    `- provider: \`${CLAUDE}\` → \`${fs.realpathSync(CLAUDE)}\` (\`${version}\`), \`--model ${MODEL}\``,
    `- the pane's own provider configuration was redirected into the fixture (\`CLAUDE_CONFIG_DIR=${CONFIG_DIR}\`),`,
    '  set on the backend environment before the backend started, because a pane inherits the backend\'s environment and nothing else',
    '- that fixture config was seeded with `hasCompletedOnboarding`, a theme, and the two account-link keys read out of',
    '  the user\'s `~/.claude.json` (`oauthAccount`, `userID`) — credentials live in the Keychain, not in that file, so no',
    '  token passes through the fixture. Nothing is written back to the user\'s configuration. Trust was **not** seeded:',
    '  the trust dialog was answered by reading the screen and typing, and that exchange is in `native/dialogs.json`',
    '- `ANTHROPIC_API_KEY` was removed from the fixture environment, so the pane used the same credential the user\'s own install uses',
    '- window: `before` immediately before the backend starts, `after` immediately after the pane is closed',
    '- collector: `app/scripts/l394/global-config-diff.mjs` (salted value digests; no value is written out)',
    `- prompt submissions: ${spent()} of ${BUDGET} cumulative (${submissions.length} calls recorded) · installed herdr, PATH, the Orca app and the user's default session untouched`,
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
    '1. **Asserted zero.** No trust key of the user\'s configuration moved, no directory changed, and no file',
    '   outside `~/.claude.json` changed. The pane could not write to the user\'s configuration at all — its own',
    '   lived inside the fixture — so any movement in those would mean the isolation failed.',
    '2. **Listed, not asserted.** Key paths inside `~/.claude.json` are listed in `native/f14-listed-key-paths.json`',
    '   (names only, never values). That file is shared mutable state on this machine: the worker session that ran',
    '   this script is itself a `claude` process writing to it on every turn, so a zero there would be a claim about',
    '   the session, not about the measured pane. 01-criteria F14 asks for exactly this — "trust 항목 외 diff 0(있으면 목록)".',
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
  fs.writeFileSync(path.join(rawRoot, 'global-config-diff.md'), markdown)
  f.record('native/state', f.stateJson())
  f.record('native/worker-list', (await f.cli(['orchestration', 'worker-list', '--limit', '100'])).result)
  console.log(markdown)
} finally { await f.cleanup() }
