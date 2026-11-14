// LIFE-795 — `herdr-claude-bg.patch` 판정: 번들 herdr 의 Claude 통합 훅이 Claude Code bg 세션에서는 보고하지 않는다.
//
// 훅 스크립트 원본은 상류 archive 안에만 있다(레포에 사본 없음). archive 는 `npm run herdr:guard` 가 받아 두는
// `<git-common-dir>/corral-herdr-dev/toolchain/herdr.tar.gz`, 또는 `CORRAL_BACKEND_BUILD_ROOT` 아래 것을 쓴다 — sha256 을
// `source.json` 과 대조한다. 둘 다 없으면 이 파일의 시험은 건너뛴다(사유를 출력한다): 패치 판정에는 상류 원본이 필요하다.
//
// 「합성」: 훅을 진짜 Claude Code 가 아니라 이 시험이 띄운다 — env 와 hook 입력(JSON)을 손으로 주고, herdr 서버 대신 가짜 유닉스 소켓
// 수신기가 받은 요청을 기록한다. 증명하는 것: 같은 입력에서 패치본은 bg 신호(`CLAUDE_JOB_DIR` 비어 있지 않음)가 있으면 아무것도
// 보내지 않고, 없거나 비었으면 패치 전 스크립트와 같은 요청을 보낸다. Claude Code 가 bg 세션 훅에 그 변수를 준다는 것은 실측
// (corral-specs LIFE-795 C6) 몫이다.
//
// `CORRAL_HOOK_UNDER_TEST=pristine` 이면 「패치본」 자리에 패치 전 스크립트를 넣는다 — bg 시험이 실패해야 한다(양성 대조).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = path.dirname(fileURLToPath(import.meta.url))
const source = JSON.parse(fs.readFileSync(path.join(backend, 'source.json'), 'utf8'))
const ASSET = 'herdr-0.9.0/src/integration/assets/claude/herdr-agent-state.sh'

function archive() {
  const candidates = []
  if (process.env.CORRAL_BACKEND_BUILD_ROOT) candidates.push(path.join(process.env.CORRAL_BACKEND_BUILD_ROOT, 'herdr.tar.gz'))
  try {
    const common = execFileSync('git', ['-C', backend, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
    candidates.push(path.join(common, 'corral-herdr-dev', 'toolchain', 'herdr.tar.gz'))
  } catch {}
  return candidates.find(file => fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === source.archiveSHA256) ?? null
}

const found = archive()
const skip = found === null ? `상류 archive(sha256 ${source.archiveSHA256.slice(0, 12)}…)가 없다 — npm --prefix app run herdr:guard 로 받는다` : false
if (skip) console.log(`claude-hook-bg: 건너뜀 — ${skip}`)

function scripts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l795h-'))
  const pristine = path.join(dir, 'pristine.sh'), patched = path.join(dir, 'patched.sh')
  fs.writeFileSync(pristine, execFileSync('tar', ['-xzf', found, '-O', ASSET]))
  fs.mkdirSync(path.join(dir, 'tree/src/integration/assets/claude'), { recursive: true })
  fs.copyFileSync(pristine, path.join(dir, 'tree/src/integration/assets/claude/herdr-agent-state.sh'))
  execFileSync('patch', ['-s', '-p1', '-i', path.join(backend, 'herdr-claude-bg.patch')], { cwd: path.join(dir, 'tree') })
  fs.copyFileSync(path.join(dir, 'tree/src/integration/assets/claude/herdr-agent-state.sh'), patched)
  return { dir, pristine, patched: process.env.CORRAL_HOOK_UNDER_TEST === 'pristine' ? pristine : patched }
}

/** The script run once as Claude Code would for SessionStart, against a fake herdr socket. Resolves to the requests it sent. */
async function runHook({ dir, script, env }) {
  const sock = path.join(dir, `h${Math.random().toString(36).slice(2, 8)}.sock`)
  const got = []
  const server = net.createServer(conn => {
    let buf = ''
    conn.on('data', chunk => {
      buf += chunk
      for (let at = buf.indexOf('\n'); at >= 0; at = buf.indexOf('\n')) {
        got.push(JSON.parse(buf.slice(0, at))); buf = buf.slice(at + 1)
        conn.end('{"ok":true}\n')
      }
    })
  })
  await new Promise(resolve => server.listen(sock, resolve))
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fa458ce1-0000-4000-8000-000000000000', transcript_path: '/x/projects/p/fa458ce1.jsonl', source: 'clear' })
  const child = spawn('sh', [script, 'session'], {
    env: { PATH: process.env.PATH, TMPDIR: dir, HERDR_ENV: '1', HERDR_SOCKET_PATH: sock, HERDR_PANE_ID: 'wH:p4', ...env },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(input)
  const code = await new Promise(resolve => child.on('close', resolve))
  await new Promise(resolve => setTimeout(resolve, 100))
  await new Promise(resolve => server.close(resolve))
  return { code, stderr, requests: got }
}
/** The request with the fields that legitimately differ per run removed. */
const comparable = request => ({ ...request, id: undefined, params: { ...request.params, seq: undefined } })

test('LIFE-795 C7 — a background session (CLAUDE_JOB_DIR set) sends nothing; the unpatched hook does (the defect)', { skip }, async () => {
  const s = scripts()
  try {
    const bg = { CLAUDE_JOB_DIR: '/Users/someone/.claude/jobs/0a10da84' }
    const patched = await runHook({ dir: s.dir, script: s.patched, env: bg })
    assert.equal(patched.code, 0, patched.stderr)
    assert.deepEqual(patched.requests, [], 'the patched hook must stay silent in a background session')
    const pristine = await runHook({ dir: s.dir, script: s.pristine, env: bg })
    assert.equal(pristine.requests.length, 1, 'positive control: the upstream hook reports from a background session')
    assert.equal(pristine.requests[0].params.pane_id, 'wH:p4')
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }) }
})

test('LIFE-795 C7 — a foreground session sends the very request the unpatched hook sends (id·seq aside)', { skip }, async () => {
  const s = scripts()
  try {
    const patched = await runHook({ dir: s.dir, script: s.patched, env: {} })
    const pristine = await runHook({ dir: s.dir, script: s.pristine, env: {} })
    assert.equal(patched.code, 0, patched.stderr)
    assert.equal(patched.requests.length, 1)
    assert.equal(pristine.requests.length, 1)
    assert.deepEqual(comparable(patched.requests[0]), comparable(pristine.requests[0]))
    assert.equal(patched.requests[0].method, 'pane.report_agent_session')
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }) }
})

test('LIFE-795 C7 — an empty CLAUDE_JOB_DIR is not the signal: the hook reports (fails open)', { skip }, async () => {
  const s = scripts()
  try {
    const empty = await runHook({ dir: s.dir, script: s.patched, env: { CLAUDE_JOB_DIR: '' } })
    const pristine = await runHook({ dir: s.dir, script: s.pristine, env: { CLAUDE_JOB_DIR: '' } })
    assert.equal(empty.requests.length, 1)
    assert.deepEqual(comparable(empty.requests[0]), comparable(pristine.requests[0]))
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }) }
})
