// LIFE-603 R1-H ⑤ 자기점검(fix2 R2-D) — 분류는 효과 시작 여부로, 실패 전파, 그리고 **실제 cli/corral.mjs 가 이 인자를 검증 통과시키는가**.
// 실제 런타임 상대의 실측은 최종 관문 몫(이 파일은 없는 격리 소켓으로 연결 단계까지만 — 사용자 소켓 무접촉).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classify, judgeSecond, parseExtra, REQUEST_ID } from './delay-cancel.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '..', '..')
// 빌드 산출물 칸(R3-J) — 평소엔 out/ 이 없으면 건너뛰고, 관문 모드(`L603_REQUIRE_BUILD=1`)에선 건너뛰지 않고 실패한다.
const built = () => fs.existsSync(path.join(app, 'out/runtime/cli.mjs'))
const skipUnbuilt = () => (built() || process.env.L603_REQUIRE_BUILD === '1' ? false : 'npm run build 먼저')
const SOCK = '/tmp/l603g-selfcheck/ud/runtime/rpc.sock'

test('classify — 효과 전 취소(not_started · 경로 없음)는 R1-B 가 아니다, 효과 뒤(unknown 또는 경로 생김)만 센다', () => {
  assert.equal(classify({ first: { ok: false, error: { code: 'request_cancelled' }, _meta: { outcome: 'not_started' } }, worktreeAppeared: false }), 'before_effect')
  assert.equal(classify({ first: { ok: false, error: { code: 'request_cancelled' }, _meta: { outcome: 'not_started' } }, worktreeAppeared: true }), 'after_effect')
  assert.equal(classify({ first: { ok: false, error: { code: 'request_cancelled' }, _meta: { runtimeId: 'rt-1', outcome: 'unknown' } }, worktreeAppeared: false }), 'after_effect')
  // 격리 실측(f2-iso-delay-30) 모양 — CLI 자기 기한의 outcome_unknown(runtimeId unknown)은 경로가 없으면 효과 전이다
  assert.equal(classify({ first: { id: 'local', ok: false, error: { code: 'outcome_unknown', message: 'Deadline exceeded; mutations are never automatically retried' }, _meta: { runtimeId: 'unknown', outcome: 'unknown' } }, worktreeAppeared: false }), 'before_effect')
  assert.equal(classify({ first: { id: 'local', ok: false, error: { code: 'outcome_unknown' }, _meta: { runtimeId: 'unknown', outcome: 'unknown' } }, worktreeAppeared: true }), 'after_effect')
  assert.equal(classify({ first: { ok: false, error: { code: 'outcome_unknown' } }, worktreeAppeared: false }), 'before_effect')
  assert.equal(classify({ first: { ok: true, result: {} }, worktreeAppeared: true }), 'too_slow')
  assert.equal(classify({ first: { ok: false, error: { code: 'invalid_argument' }, _meta: { outcome: 'not_started' } }, worktreeAppeared: false }), 'not_started')
  assert.equal(classify({ first: null, worktreeAppeared: false }), 'no_response')
})

test('--extra 는 JSON 배열 — 공백·따옴표 든 인자를 그대로', () => {
  assert.deepEqual(parseExtra('["--prompt","a \\"b\\" c","--draft"]'), ['--prompt', 'a "b" c', '--draft'])
  assert.deepEqual(parseExtra(''), [])
  assert.throws(() => parseExtra('--agent claude'))
  assert.throws(() => parseExtra('[1]'))
})

test('실제 cli/corral.mjs — 기본 id · 인자 · 환경변수 소켓이 검증을 지나 연결 단계에서 멈춘다(Invalid flag · invalid_argument 아님)', { skip: skipUnbuilt() }, () => {
  assert.ok(built(), 'L603_REQUIRE_BUILD=1 인데 out/ 이 없다 — 빌드 산출물 없이 통과로 세지 않는다(R3-J)')
  const id = `r1.${Date.now()}.${randomUUID()}`
  assert.ok(REQUEST_ID.test(id))
  const run = spawnSync(process.execPath, [path.join(app, 'cli/corral.mjs'), 'worktree', 'create', '--repo', '/tmp/l603g-selfcheck/repo', '--name', 'n', '--request-id', id, '--agent', 'claude', '--prompt', 'a "b" c', '--draft', '--timeout-ms', '400', '--json'],
    { encoding: 'utf8', env: { ...process.env, CORRAL_RUNTIME_SOCKET: SOCK }, timeout: 20_000 })
  const line = run.stdout.trim().split('\n').filter((row) => row.startsWith('{')).pop() ?? ''
  const response = JSON.parse(line)
  assert.equal(response.ok, false)
  assert.notEqual(response.error.code, 'invalid_argument', line)
  assert.ok(!/Invalid flag/.test(response.error.message), line)
  assert.equal(response.error.code, 'runtime_unavailable', line)
  // 대조: 옛 장치의 모양(--socket 플래그 · l603-delay- id)은 같은 CLI 가 효과 전에 거절한다.
  const old = spawnSync(process.execPath, [path.join(app, 'cli/corral.mjs'), '--socket', SOCK, 'worktree', 'create', '--repo', '/r', '--name', 'n', '--request-id', `l603-delay-${randomUUID()}`, '--json'], { encoding: 'utf8', env: { ...process.env, CORRAL_RUNTIME_SOCKET: SOCK }, timeout: 20_000 })
  assert.match(old.stdout, /invalid_argument|Invalid flag|invalid_request/)
})

test('가짜 CLI 로 끝까지 — 효과 뒤 취소 exit 0 · 효과 전 취소 exit 3 · 너무 느림 exit 3 · 매달림 exit 4 · 가드 exit 2', () => {
  const dir = fs.mkdtempSync('/tmp/l603g-dc')
  try {
    const repo = path.join(dir, 'repo')
    const fake = path.join(dir, 'fake.mjs')
    // FAKE_MODE: after = 취소 + 경로 생성 · before = 취소(not_started) · fast = 완료 · hang. 기한 150 이상이면 완료(replay).
    fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv; const t = Number(a[a.indexOf('--timeout-ms') + 1]); const mode = process.env.FAKE_MODE;
if (!process.env.CORRAL_RUNTIME_SOCKET) { console.log(JSON.stringify({ ok: false, error: { code: 'no_env_socket' } })); process.exit(1) }
if (mode === 'hang') setInterval(() => {}, 1000);
else if (t >= 150 || mode === 'fast') console.log(JSON.stringify({ ok: true, result: { replayed: true } }));
else { if (mode === 'after') fs.mkdirSync(${JSON.stringify(repo)} + '/.claude/worktrees/n/.git', { recursive: true }); console.log(JSON.stringify({ ok: false, error: { code: 'request_cancelled' }, _meta: { outcome: 'not_started' } })) }`)
    const run = (env, extra = []) => spawnSync(process.execPath, [path.join(here, 'delay-cancel.mjs'), '--socket', SOCK, '--repo', repo, '--name', 'n', '--cli', fake, '--short-ms', '100', '--long-ms', '200', '--settle-ms', '10', ...extra], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 })
    const after = run({ FAKE_MODE: 'after' })
    assert.equal(after.status, 0, after.stdout)
    assert.equal(JSON.parse(after.stdout).kind, 'after_effect')
    assert.equal(run({ FAKE_MODE: 'after' }).status, 3) // 이번엔 경로가 시도 전부터 있다 — path_preexisting
    fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true })
    const before = run({ FAKE_MODE: 'before' })
    assert.equal(before.status, 3)
    assert.equal(JSON.parse(before.stdout).code, 'before_effect')
    assert.equal(run({ FAKE_MODE: 'fast' }).status, 3)
    const hung = spawnSync(process.execPath, [path.join(here, 'delay-cancel.mjs'), '--socket', SOCK, '--repo', repo, '--name', 'n', '--cli', fake, '--short-ms', '100', '--long-ms', '1'], { encoding: 'utf8', env: { ...process.env, FAKE_MODE: 'hang' }, timeout: 60_000 })
    assert.equal(hung.status, 4)
    assert.equal(run({ FAKE_MODE: 'fast' }, ['--request-id', 'l603-delay-x']).status, 2)
    assert.equal(run({ FAKE_MODE: 'fast' }, ['--extra', '--agent claude']).status, 2)
    assert.equal(spawnSync(process.execPath, [path.join(here, 'delay-cancel.mjs'), '--socket', `${process.env.HOME}/Library/Application Support/corral/runtime/rpc.sock`, '--repo', '/r', '--name', 'n'], { encoding: 'utf8' }).status, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// --- fix3 R3-G -----------------------------------------------------------------------------------
test('R3-G judgeSecond — already_exists · replay · 런타임 미확정만 통과, 새 실행 · 다른 오류 · CLI 기한 미확정은 실패', () => {
  const real80 = { id: 'e80', ok: false, error: { code: 'already_exists', message: 'Branch or path exists: dcb80' }, _meta: { runtimeId: 'ae4a5cc4', outcome: 'unknown' } } // f2-iso-delay-b80 실측 모양
  assert.deepEqual(judgeSecond(real80), { kind: 'already_exists', exit: 0 })
  assert.deepEqual(judgeSecond({ ok: true, result: { replayed: true } }), { kind: 'replayed', exit: 0 })
  assert.deepEqual(judgeSecond({ ok: false, error: { code: 'outcome_unknown' }, _meta: { runtimeId: 'rt', outcome: 'unknown' } }), { kind: 'receipt_pending', exit: 0 })
  assert.deepEqual(judgeSecond({ ok: true, result: { replayed: false } }), { kind: 'fresh', exit: 5 })
  assert.deepEqual(judgeSecond({ ok: true, result: {} }), { kind: 'fresh', exit: 5 })
  assert.deepEqual(judgeSecond({ ok: false, error: { code: 'invalid_argument' } }), { kind: 'unexpected', exit: 6, code: 'invalid_argument' })
  assert.deepEqual(judgeSecond({ ok: false, error: { code: 'outcome_unknown' }, _meta: { runtimeId: 'unknown' } }), { kind: 'unexpected', exit: 6, code: 'outcome_unknown' })
  assert.deepEqual(judgeSecond(null), { kind: 'no_response', exit: 4 })
})

test('R3-G 가짜 CLI 세 갈래 — 2회차 already_exists exit 0 · secondFresh exit 5 · 다른 오류 exit 6 (고침 전: 응답만 있으면 0)', () => {
  const dir = fs.mkdtempSync('/tmp/l603g-dg')
  try {
    const repo = path.join(dir, 'repo')
    const fake = path.join(dir, 'fake.mjs')
    // 1회차(기한 < 150): 취소 + 경로 생성. 2회차: SECOND 에 따라.
    fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv; const t = Number(a[a.indexOf('--timeout-ms') + 1]);
if (t < 150) { fs.mkdirSync(${JSON.stringify(repo)} + '/.claude/worktrees/n/.git', { recursive: true }); console.log(JSON.stringify({ ok: false, error: { code: 'request_cancelled' }, _meta: { outcome: 'not_started' } })) }
else if (process.env.SECOND === 'exists') console.log(JSON.stringify({ ok: false, error: { code: 'already_exists' }, _meta: { runtimeId: 'rt', outcome: 'unknown' } }));
else if (process.env.SECOND === 'fresh') console.log(JSON.stringify({ ok: true, result: { replayed: false } }));
else console.log(JSON.stringify({ ok: false, error: { code: 'invalid_argument' }, _meta: { runtimeId: 'rt', outcome: 'not_started' } }))`)
    const run = (second) => {
      fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true })
      return spawnSync(process.execPath, [path.join(here, 'delay-cancel.mjs'), '--socket', SOCK, '--repo', repo, '--name', 'n', '--cli', fake, '--short-ms', '100', '--long-ms', '200', '--settle-ms', '10'], { encoding: 'utf8', env: { ...process.env, SECOND: second }, timeout: 60_000 })
    }
    const exists = run('exists')
    assert.equal(exists.status, 0, exists.stdout)
    assert.equal(JSON.parse(exists.stdout).second_kind, 'already_exists')
    const fresh = run('fresh')
    assert.equal(fresh.status, 5, fresh.stdout)
    assert.deepEqual([JSON.parse(fresh.stdout).ok, JSON.parse(fresh.stdout).secondFresh], [false, true])
    const other = run('other')
    assert.equal(other.status, 6, other.stdout)
    assert.equal(JSON.parse(other.stdout).second_kind, 'unexpected')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
