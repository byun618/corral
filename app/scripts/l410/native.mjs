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
//
// LIFE-426: F14 lists key paths, and in `~/.claude.json` a key IS a directory name, so until now
// listing them committed the user's project directories. The collector redacts every path-form
// segment before this file ever sees it (`app/scripts/l394/redact.mjs`), which leaves both ends of
// a key intact — `projects.<p:…>.hasTrustDialogAccepted` still classifies as trust below.
//
// The paths this file adds of its own are the install it measured and the foreground process
// record that proves the pane is running it. Both are redacted here under the same salt as the
// key paths: `providerPath` and the markdown `install` line through `redact.token` (one whole
// path, one token — review V15), and the `foregroundExecutable()` record through
// `redact.executable` (review V16: `expected`, `match` and every `observed[]` carried the same
// realpath in plaintext next to a `providerPath` that was redacted, and this header's earlier
// sentence — "at both of the places that record it", from V8 — was what said otherwise). That
// record's `comm` goes through the same rule (review V19): `ps -o comm=` was taken to be an
// accounting name, but on macOS it is argv[0], so a provider started by absolute path reports its
// whole launch path there and one started through a wrapper reports a command line. The version
// directory's own `name` stays, because that is how C5 compares two installs; `pid` and
// `shellPid` stay because a pid is not a place.
//
// A *failing* `foregroundExecutable()` builds its assertion message from the unredacted values,
// and `lib.mjs` writes a failed check to `run.json` as `checks[].error`. Since `native-checks.mjs`
// and `lib.mjs` are frozen here, that message is redacted at this file's call site instead
// (review V21) — through `redact.diagnostic`, not `redact.text`: `text` stops at a space, so
// round 3 left the middle name of a spaced install path standing, and that word has neither a `/`
// nor a home prefix, so neither leak-check prong sees it (review V25). `diagnostic` has one limit:
// with no parseable JSON tail it falls back to `text`, so a spaced path that the call site did not
// name in `paths` can still leave its middle name standing. The stack frames of such an error
// still name this repository's own scripts, which the leak check counts in the ⓑ bucket and this
// task does not claim to cover.
//
// What `lib.mjs` writes on its own — `commands`, `observations`, `strippedEnv` in `run.json` — is
// out of this task's scope (02-kickoff; `lib.mjs` and `native-checks.mjs` are unchanged here) and
// carries tool install paths of its own. The leak check counts those as the ⓒ2 bucket.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app as APP_ROOT, fixture, requestId } from './lib.mjs'
import { redactor } from '../l394/redact.mjs'
import { LIVE_PHASES, foregroundExecutable, waitForLaunch } from '../l409/native-checks.mjs'
// LIFE-430 C3. `f.stateDigest()` 두 번으로 "거절은 아무것도 저장하지 않는다" 를 재면, 두 관측 사이에
// 들어온 **거절과 무관한 쓰기**가 검사를 실패시킨다 — LIFE-426 에서 5회 중 2회가 그랬다. 무엇이
// 바뀌었고 무엇이 그것을 설명하는지를 키 단위로 묻는 비교로 바꾼다. 규칙·검출력·한계는 그 파일에,
// 기제 증명(양성 대조·20회·음성 대조 6종)은 `l430/refusal-race.mjs` 에 있다.
import { refusalDelta, describeDelta, snapshot, stopReason, unobservedOpenAttempts } from '../l430/state-delta.mjs'

/**
 * r2 지적 H — 창을 열기 전에 **전제를 능동적으로 세운다**.
 *
 * 재관측 기록(`dispatch.reconcile`)은 열린 attempt 를 **처음** 재관측하는 명령 한 번만 쓰인다. 그 명령이
 * 창 안에 들어오면 — 선행 `worker-show` 의 pane 관측이 실패해 기록이 서지 못했다가, 창 안의 정상
 * heartbeat 가 도장을 같이 찍는 모양 — 거절이 아무것도 쓰지 않았는데도 `version` 이 +2 로 움직인다.
 * 그 두 쓰기는 바이트로 구분되지 않는다. 그래서 비교를 느슨하게 하는 대신 창을 열기 전에 도장을 찍는다.
 *
 * 세우는 방법은 읽기 명령 한 번이다. 제품의 재관측 훑기는 `status === 'dispatched'` 인 **모든** attempt 에
 * 적용되고(`index.ts:378-383`), 읽기는 그 결과를 그 자리에서 저장한다(`index.ts:651-663` — 동결이
 * 이름 붙인 `dispatch-show` 의 순간이다). 그래서 이 한 번이 이 attempt 뿐 아니라 **다른 열린 attempt**
 * 까지 함께 세운다 (r2 지적 L-a).
 *
 * **한계 (r3 지적 L).** 도장을 먼저 찍으면 그 창에서는 제품 가드(`index.ts:662`
 * `pass.changed && !mutating`)의 회귀가 **잡히지 않는다** — 도장이 이미 서 있어 돌연변이가 쓸 것이
 * 없기 때문이다(`model.ts:316`). 그 회귀는 이 관문이 아니라 커밋된 제품 경로 검사가 잡는다:
 * `app/src/runtime/orchestration/admission.test.ts` 의 "a rejected mutation leaves the document
 * byte-identical" — 도장이 **없는** 조용한 창을 일부러 만들어 거절을 돌린다 (05-result T2-L).
 *
 * 세우지 못하면 관문은 **멈추되 문장이 다르다** — "거절이 썼다" 가 아니라 "전제 미충족" 이다.
 * 그 멈춤은 백엔드 관측이 N회 내내 실패할 때만 난다(`observePanes` 가 `unobserved` 를 돌려주면
 * `applyReconcile` 은 아무것도 쓰지 않는다 — `model.ts:296`). 그 상태면 네이티브 관문 자체가 돌 수 없다.
 */
async function primeReconcile(f, { label, dispatchId, requireDispatched, rounds = 5, waitMs = 400 }) {
  const tries = []
  for (let round = 1; round <= rounds; round += 1) {
    await f.cli(['orchestration', 'dispatch-show', '--id', dispatchId])
    const state = snapshot(f.stateBytes()).state
    // r3 지적 L-h. 「아무것도 못 봤다」를 「전제가 섰다」로 적지 않는다. 문서가 없거나 검사할
    // attempt 가 문서에 없으면 그것은 성립이 아니라 **실패**다 — 오늘은 `dispatch-show` 가 먼저
    // 죽어서 여기 닿지 않지만, 그 보호는 이 함수 밖에 있고 호출부가 바뀌면 그대로 열린다.
    if (state === null || typeof state !== 'object') {
      f.record(`native/precondition-${label}`, { established: false, reason: 'no-document', dispatchId, tries })
      assert.fail(`전제를 확인할 문서가 없다 — ${label}: state.json 을 읽지 못했다. `
        + '이 회차는 "거절이 무엇을 썼나" 를 판정하지 않는다.')
    }
    const entries = state.dispatches ?? []
    const open = entries.filter(entry => entry.status === 'dispatched').map(entry => entry.id)
    const unset = unobservedOpenAttempts(state)
    const record = entries.find(entry => entry.id === dispatchId)
    const status = record?.status ?? null
    tries.push({ round, open, unset, status, present: record !== undefined })
    if (record === undefined) {
      f.record(`native/precondition-${label}`, { established: false, reason: 'dispatch-absent', dispatchId, tries })
      assert.fail(`전제를 확인할 attempt 가 문서에 없다 — ${label}: ${dispatchId} 가 state.json 에 없다. `
        + '이 회차는 "거절이 무엇을 썼나" 를 판정하지 않는다.')
    }
    // 세 번째 결과: 재관측이 pane 이 사라진 것을 보고 이 attempt 를 `unknown` 으로 정산한 경우
    // (`model.ts:313`). 전제 미충족도 아니고 거절의 쓰기도 아니다 — 창을 열 대상 자체가 없어졌다.
    if (requireDispatched && status !== 'dispatched') {
      f.record(`native/precondition-${label}`, { established: false, reason: 'attempt-settled', dispatchId, tries })
      assert.fail(`창을 열 attempt 가 사라졌다 — ${label}: ${dispatchId} 의 상태가 '${status}' 다. `
        + '재관측이 pane 을 못 찾아 정산한 것이고, 거절이 무엇을 썼는지와는 무관하다.')
    }
    if (unset.length === 0) {
      f.record(`native/precondition-${label}`, { established: true, dispatchId, tries })
      return { open, rounds: round, status }
    }
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
  const last = tries[tries.length - 1]
  f.record(`native/precondition-${label}`, { established: false, reason: 'not-observed', dispatchId, tries })
  assert.fail(`전제 미충족 — ${label}: 창을 열기 전에 열린 attempt 의 재관측 기록을 세우지 못했다 `
    + `(${rounds}회 시도, 아직 비어 있는 attempt ${last.unset.length}개). `
    + '이 회차는 "거절이 무엇을 썼나" 를 판정하지 않는다 — 창 안의 첫 재관측 도장과 거절의 쓰기는 '
    + '바이트로 구분되지 않기 때문이다. 백엔드 관측이 회복된 뒤 다시 돌린다.')
}

// === the ledger, before anything else ============================================================
//
// V49 (LIFE-430 C1). This whole block used to sit below `fixture()`, which is below the line that
// runs the installed provider to read its version. That order is what let the gate open on a
// checkout it could not count: with no `CORRAL_VERIFY_LEDGER`, no ledger at the default path and no
// migration source, `migrated()` answered `[]`, `spent()` answered 0, and the budget assertions
// below passed a run that had counted **nothing** — a gate reporting "0 of 12" as a pass. Worse,
// the `mkdirSync` further down ran unconditionally, so a run that should never have started created
// directories under another task's raw tree on its way through.
//
// So the ledger is read first, and a run that cannot count does not start. "Cannot count" is
// exactly one case — there is no ledger **and** nothing to build one from — and it is fatal here,
// above `CLAUDE`, above `fixture()`, above the first `execFileSync`. Nothing has been spawned and
// nothing has been created when it fires.
//
// The named-ledger case keeps its own answer (V39, below): a path someone typed wrong is a mistake,
// never an empty budget, and it must not fall through to the migration.
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
const RAW_ROOT = path.resolve(APP_ROOT, '../specs/LIFE-410-cli-orchestration-workers/raw')
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
/** A refusal says where it looked without writing a local absolute path down (LIFE-426). */
const fromRepo = target => {
  const relative = path.relative(path.resolve(APP_ROOT, '..'), target)
  return relative.startsWith('..') || path.isAbsolute(relative) ? '(outside this checkout)' : relative
}
if (!fs.existsSync(LEDGER)) {
  /**
   * V39. A named ledger that is not there is a mistake, never an empty budget. The migration
   * rebuilds a *partial* history — the rows that existed before the ledger did — so letting it run
   * for a path someone typed wrong turned a spent budget of 12 into 6 and handed back six
   * submissions that were already made. A typo refuses to start; only the default path, which is
   * the one the committed ledger has always had, may ever be built from the migration.
   */
  if (process.env.CORRAL_VERIFY_LEDGER) {
    assert.fail(`CORRAL_VERIFY_LEDGER names a ledger that does not exist: ${fromRepo(LEDGER)}. `
      + 'Name the ledger that holds the rows already spent — this run does not start, and no submission is made.')
  }
  // V49. No ledger, and nothing the migration could rebuild one from. A budget of 0 spent is not a
  // fact here, it is the absence of one, and a gate that counts nothing must not report a pass.
  if (!MIGRATIONS.some(source => fs.existsSync(source.file))) {
    assert.fail(`there is no ledger at ${fromRepo(LEDGER)} and no source to rebuild one from `
      + `(${MIGRATIONS.map(source => fromRepo(source.file)).join(', ')}). This run would count nothing and `
      + 'report a budget of 0 spent as a pass, so it does not start: no backend, no pane, no submission. '
      + 'Name the ledger that holds the rows already spent with CORRAL_VERIFY_LEDGER.')
  }
}
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
const SALT_FILE = process.env.L410_SALT_FILE ?? '/tmp/l410-claude-salt'
// The same salt the collector digests with, so a path redacted here and the same path inside a
// redacted key path carry the same token.
const redact = redactor(SALT_FILE)
// A path as it may be recorded — one whole path, so one token (review V15; the rule and its fixture
// live in `redact.mjs` so both gates and the selftest use the same one).
const describePath = redact.describePath

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
  env: { ...process.env, L394_RAW: f.raw, L394_SALT_FILE: SALT_FILE },
}).trim()

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
    // The assertions inside this function build their messages from unredacted values, and a
    // failing check is written to `run.json` as `checks[].error` by `lib.mjs` (review V21).
    // `native-checks.mjs` and `lib.mjs` are frozen for this task, so the message is redacted
    // here, where it leaves the gate. Both messages it can throw pass through this catch.
    //
    // `redact.diagnostic`, not `redact.text`: `text` stops at a space, so a message quoting an
    // install path with a space in it left that middle name standing (review V25). `diagnostic`
    // replaces the realpath below whole and tokenises every string of the message's JSON tail.
    // Its limit: with no parseable JSON tail it falls back to `text`, so a *second* spaced path
    // that is neither in `paths` nor in the tail can still leave a name — `paths` is why the one
    // path these messages are known to quote does not.
    let executable
    let claudePaths = []
    try { claudePaths = [fs.realpathSync(CLAUDE)] } catch { /* not installed there: nothing to pin */ }
    try { executable = await foregroundExecutable(f, handle, CLAUDE) }
    catch (error) { throw new Error(redact.diagnostic(error.message, { paths: claudePaths })) }
    const text = await screen(handle)
    f.record('native/screen-identity', { text })
    assert.doesNotMatch(text, /Not logged in|Please run \/login/i, 'an unauthenticated provider cannot run a single command')
    assert.match(text, /Claude Code|claude\.ai|Welcome to Claude|2\.1\.252|\?\s*for shortcuts/i)
    return { dialogs: dialogs.length, phase: phase.phase, executable: redact.executable(executable), providerVersion: version, providerPath: describePath(fs.realpathSync(CLAUDE)), model: MODEL }
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
    // 창을 열기 전에 전제를 세운다 (r2 지적 H). 못 세우면 여기서 다른 문장으로 멈춘다.
    const precondition = await primeReconcile(f, { label: 'f1a', dispatchId, requireDispatched: true })
    // 관측은 바이트 한 번에서 digest 와 문서를 함께 뜬다. 두 번 읽으면 그 사이가 또 창이 된다.
    const before = snapshot(f.stateBytes())
    const again = await f.cli(['orchestration', 'worker-start', '--task', taskId, '--terminal', handle, '--timeout-ms', '120000'], { fail: true, timeout: 200000 })
    assert.equal(again.error.code, 'task_not_startable', JSON.stringify(again))
    assert.equal(again.error.resources.reason, 'dispatch_active')
    const after = snapshot(f.stateBytes())
    const delta = refusalDelta(before.state, after.state, { dispatchId })
    // 통과해도 남긴다. 이 pane 의 모델이 이 창에서 **실제로 무엇을 썼는지**가 네이티브 회차의 증거이고,
    // 조용히 통과한 회차는 그 증거를 남기지 않는다.
    const described = describeDelta(delta, before.state, after.state)
    f.record('native/refusal-delta-f1a', { ...described, precondition, bytesMoved: before.digest !== after.digest })
    // r3 지적 M(R3) · r4 지적 Z1·Z2. 멈출 이유는 한 곳에서 고른다 (`stopReason`): 설명되지 않는
    // 쓰기가 있으면 **그것을** 말하고, 정산뿐이면 정산을 말한다. 두 단언을 순서로 걸면 둘이 같은
    // 창에 올 때 실패 문장이 정산만 말했다.
    const stop = stopReason(delta)
    assert.equal(stop, null, 'a refused start stores nothing — ' + JSON.stringify(stop))
    const again2 = countRecord(sessionId)
    assert.equal(again2.delivered, 1, 'and delivers nothing further')
    assert.equal(again2.wrapped, 1)
    return { error: again.error, record: again2.summary, delta: { ...described.counts, clean: delta.clean, explainedBy: described.explainedBy, bytesMoved: before.digest !== after.digest } }
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
    // 같은 비교를 여기서도 쓴다. 이 자리에서 막아야 할 쓰기는 pane 의 `worker_done` 이고, 그것은
    // 허용 목록에 없다 — 그래서 검출력은 그대로고, 흔들리는 쪽만 빠진다 (`l430/state-delta.mjs`).
    // 여기서도 전제를 세운다. 이 attempt 는 이미 정산됐지만, 같은 pane 에 **다른 열린 attempt** 가
    // 있으면 그쪽 첫 도장이 창 안에서 찍혀 같은 거짓 실패가 난다 (r2 지적 L-a).
    const precondition = await primeReconcile(f, { label: 'f4-f7', dispatchId, requireDispatched: false })
    const before = snapshot(f.stateBytes())
    const late = await f.cli(['orchestration', 'send', '--type', 'worker_done', '--subject', 'again', '--body', 'x',
      '--task-id', taskId, '--dispatch-id', dispatchId, '--outcome', 'succeeded'],
    { env: { ...f.env, HERDR_PANE_ID: shown.result.paneId }, fail: true })
    assert.equal(late.error.code, 'illegal_transition', JSON.stringify(late))
    const after = snapshot(f.stateBytes())
    const delta = refusalDelta(before.state, after.state, { dispatchId })
    const described = describeDelta(delta, before.state, after.state)
    f.record('native/refusal-delta-f4-f7', { ...described, precondition, bytesMoved: before.digest !== after.digest })
    const stop = stopReason(delta)
    assert.equal(stop, null, 'a refused late report stores nothing — ' + JSON.stringify(stop))
    const panes = async () => (await f.cli(['terminal', 'list'])).result.terminals.map(entry => entry.handle)
    assert.ok((await panes()).includes(handle), 'the settled attempt leaves its pane standing until someone releases it')
    // The release is not made here: the pane is about to be handed to a second Task, and what F9
    // has to show is that the *old* attempt's release then closes nothing.
    return { late: late.error, paneStanding: true, delta: { ...described.counts, clean: delta.clean, explainedBy: described.explainedBy, bytesMoved: before.digest !== after.digest } }
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
    f.record('native/f14-listed-key-paths', { note: 'redacted key paths only; no configuration value and no directory name is read or recorded (LIFE-426)', listed, summary })
    return { summary, listed, providerVersion: version, providerPath: describePath(fs.realpathSync(CLAUDE)), before, after, reported }
  })

  // This one goes into the run's own directory and nowhere else. A copy at the owner's raw root
  // was a second, undated file that the *next* run silently overwrote, so the round that wrote it
  // could not be told from the round that read it (V14).
  const markdown = [
    '# LIFE-410 F14 — the user\'s global provider configuration, before and after gate ②',
    '',
    `- provider: \`${path.basename(CLAUDE)}\` (\`${version}\`), \`--model ${MODEL}\` — install \`${redact.token(CLAUDE)}\` → \`${redact.token(fs.realpathSync(CLAUDE))}\``,
    '- the provider ran on the user\'s own configuration, deliberately: an isolated `CLAUDE_CONFIG_DIR` cannot',
    '  authenticate (the Keychain lookup is keyed to the default config directory), so the gate could not run at all.',
    '  The measurement is in `native/auth-isolation-probe.md`. Nothing was written to the user\'s settings or hooks',
    '  by this script; what the provider itself records is a project/trust entry for one temporary directory',
    '- `ANTHROPIC_API_KEY` was removed from the fixture environment, so the pane used the same credential the user\'s',
    '  own install uses, and `DISABLE_AUTOUPDATER=1` was set there too — in the environment, never in a settings file',
    '- trust was **not** pre-seeded: the trust dialog was answered by reading the screen and typing (`native/dialogs.json`)',
    '- window: `before` immediately before the backend starts, `after` immediately after the pane is closed',
    '- collector: `app/scripts/l394/global-config-diff.mjs` (salted value digests; no value and no key path is written out — LIFE-426)',
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
    '1. **Asserted zero.** No directory changed, and no file outside the provider\'s own `.claude.json` changed. This run owned its',
    '   backend, its herdr session and its userData, so movement in either would mean it reached somewhere it should not.',
    '2. **Listed, not asserted.** Key paths inside the provider\'s own JSON are listed in',
    '   `native/f14-listed-key-paths.json`, split into trust entries and everything else, by name and never by value.',
    '   Every path-form segment of those names is a salted token (LIFE-426): a key whose name is a directory —',
    '   `projects.<p:…>` — names the directory nowhere, and both ends of the key survive, so the split below is',
    '   the same split it always was. Trust entries are expected and are',
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
