// N1 — 빈 클론에서 앱이 서는가.
//
// 기준(01-criteria.md N1): "빈 클론에서 npm install → dev 실행으로 앱 창이 뜨고,
// typecheck·lint·프로덕션 build 가 전부 0 exit". 판정 방법: "각 커맨드의 실제 출력 + 앱 창 샷".
//
// 그래서 여기는 **작업 worktree 를 쓰지 않는다.** 임시 경로에 이 브랜치를 clone 하고,
// 그 클론 안에서 커맨드를 돌린다 — node_modules 도 거기에 새로 깔린다.
// clone 은 git object 를 읽을 뿐이라 base 오버라이드(main 금지)와 무관하다.
//
// 창은 `electron .` 이 아니라 **dev 모드**로 띄운다. electron-vite dev 는 electron 을
// 손자 프로세스로 띄우므로 detached 로 낳아 **프로세스 그룹째** 죽인다 (안 그러면 electron 이 남는다).

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RAW_DIR, readLog, REPO_DIR, sleep, SESSION, control, writeRaw } from './lib.mjs'

const NODE_BIN = path.dirname(process.execPath)
const RUN_DIR = path.join(RAW_DIR, '_runs', 'n1-skeleton')
fs.rmSync(RUN_DIR, { recursive: true, force: true })
fs.mkdirSync(RUN_DIR, { recursive: true })

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_DIR }).toString().trim()
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR }).toString().trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_DIR }).toString().trim()
/**
 * **`app/` 이 깨끗한가** (수정 3회차 — 이 회차의 N1 재실행이 잡은 구멍).
 *
 * 클론은 **커밋된 것만** 뜬다. 그러니 `app/` 에 커밋 안 된 변경이 있으면 이 실행이 재는 것은
 * 작업 트리가 아니라 **다른 코드**다. 수정 2회차가 그 함정에 빠졌다: 하네스 7개가 커밋 전이라
 * 클론에는 옛 스크립트가 들어갔고 lint 가 0 으로 통과했는데, 그 스크립트를 커밋한 뒤의
 * `927f4df` 는 `performance is not defined` 2건으로 lint 가 깨져 있었다 (실행으로 확인).
 * 원자료(`specs/` 아래)는 측정 중에 쓰이므로 더러운 게 정상이다 — `app/` 만 본다.
 */
const appDirty = execFileSync('git', ['status', '--porcelain', '--', 'app'], { cwd: REPO_DIR }).toString().trim()

const CLONE = fs.mkdtempSync(path.join(os.tmpdir(), 'l351-clone-'))
const CLONE_APP = path.join(CLONE, 'app')

/** 커맨드 하나 = 실제 출력 + exit code 를 그대로 남긴다. 요약하지 않는다. */
async function run(label, file, args, cwd) {
  const started = Date.now()
  const result = await capture(file, args, cwd)
  const ms = Date.now() - started
  const logFile = `${label}.txt`
  fs.writeFileSync(path.join(RUN_DIR, logFile), `$ ${file} ${args.join(' ')}\n(cwd: ${cwd})\n\n${result.output}\n\n[exit ${result.code}] ${ms}ms\n`)
  console.log(`${label}: exit ${result.code} (${ms}ms)`)
  return { 커맨드: `${file} ${args.join(' ')}`, exit: result.code, ms, 로그: `_runs/n1-skeleton/${logFile}`, 끝줄: result.output.trimEnd().split('\n').slice(-6) }
}

function capture(file, args, cwd) {
  const proc = spawn(file, args, {
    cwd,
    env: { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH}`, npm_config_fund: 'false', npm_config_audit: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  proc.stdout.on('data', (chunk) => (output += chunk))
  proc.stderr.on('data', (chunk) => (output += chunk))
  return new Promise((resolve) => proc.on('close', (code) => resolve({ code, output })))
}

const out = { at: new Date().toISOString(), 측정한커밋: { 브랜치: branch, sha, 더러움: dirty || '(없음)', 'app/ 더러움': appDirty || '(없음)' }, 클론: CLONE, node: process.version, 커맨드: {} }

out.클론뜨기 = await (async () => {
  const r = await capture('git', ['clone', '--quiet', '--branch', branch, '--single-branch', REPO_DIR, CLONE], os.tmpdir())
  const clonedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CLONE }).toString().trim()
  return { exit: r.code, 클론sha: clonedSha, sha일치: clonedSha === sha, node_modules없음: !fs.existsSync(path.join(CLONE_APP, 'node_modules')), out없음: !fs.existsSync(path.join(CLONE_APP, 'out')) }
})()
console.log('clone:', JSON.stringify(out.클론뜨기))

for (const [label, args] of [['install', ['install']], ['typecheck', ['run', 'typecheck']], ['lint', ['run', 'lint']], ['build', ['run', 'build']]]) {
  out.커맨드[label] = await run(label, 'npm', args, CLONE_APP)
}

// dev 모드로 창을 띄운다. 소켓은 104 bytes 를 못 넘으므로 짧은 임시 경로에 둔다.
const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l351-')), 'c.sock')
const logPath = path.join(RUN_DIR, 'dev-app.ndjson')
const shotDir = path.join(RAW_DIR, 'shots', 'n1-skeleton')
fs.mkdirSync(shotDir, { recursive: true })
const devOut = fs.createWriteStream(path.join(RUN_DIR, 'dev.txt'))

const dev = spawn(path.join(CLONE_APP, 'node_modules/.bin/electron-vite'), ['dev'], {
  cwd: CLONE_APP,
  detached: true, // 손자(electron)까지 한 그룹에 묶어 그룹째 죽인다
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PATH: `${NODE_BIN}:${process.env.PATH}`,
    CORRAL_LOG: logPath,
    CORRAL_SESSION: SESSION,
    CORRAL_CONTROL_SOCKET: controlSocket,
    CORRAL_SHOT_DIR: shotDir,
    CORRAL_REGISTRY: path.join(RUN_DIR, 'repos.json'), // 관문 ④ — 사용자 userData 오염 금지
    CORRAL_WINDOW: '1180x1200',
  },
})
dev.stdout.pipe(devOut)
dev.stderr.pipe(devOut)

const deadline = Date.now() + 120000
let live = false
while (Date.now() < deadline) {
  if (readLog(logPath).some((entry) => entry.tag === 'link.phase' && entry.phase === 'live')) {
    live = true
    break
  }
  await sleep(200)
}
out.dev = { 창이떴나: live, 로그: '_runs/n1-skeleton/dev-app.ndjson', 콘솔: '_runs/n1-skeleton/dev.txt' }

if (live) {
  // 레포 한 줄은 있어야 "앱 창"이 내용 있는 화면이다 — 빈 클론이라 레지스트리도 비어 있다.
  await control(controlSocket, { cmd: 'add-repo', root: REPO_DIR }, { timeoutMs: 30000 })
  await sleep(700)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const shot = await control(controlSocket, { cmd: 'shot', name: `001-dev-window-${stamp}` }, { timeoutMs: 30000 })
  const state = await control(controlSocket, { cmd: 'state' }, { timeoutMs: 30000 })
  out.dev.샷 = shot.file ? path.relative(RAW_DIR, shot.file) : shot
  out.dev.화면 = { phase: state.state?.link?.phase, 레포수: state.state?.repos?.length ?? 0, 워크스페이스수: state.state?.repos?.flatMap((repo) => repo.worktrees ?? []).filter((worktree) => worktree.workspace).length ?? 0 }
}

try {
  process.kill(-dev.pid, 'SIGTERM')
} catch { /* 이미 죽었으면 그만 */ }
await sleep(1500)
try {
  process.kill(-dev.pid, 'SIGKILL')
} catch { /* 정상 종료 */ }
devOut.end()

const exits = Object.values(out.커맨드).map((item) => item.exit)
out.읽은것 = {
  '빈 클론이었다': out.클론뜨기.node_modules없음 && out.클론뜨기.out없음,
  '측정한 커밋 = 클론한 커밋': out.클론뜨기.sha일치,
  // 이게 false 면 위 네 줄의 exit 는 **커밋된 코드**의 것이고 작업 트리의 것이 아니다.
  'app/ 에 커밋 안 된 변경이 없다': appDirty === '',
  '네 커맨드 전부 0 exit': exits.every((code) => code === 0),
  '커맨드별 exit': Object.fromEntries(Object.entries(out.커맨드).map(([key, value]) => [key, value.exit])),
  'dev 로 창이 떴다': live,
  '창에 목록이 그려졌다': (out.dev.화면?.레포수 ?? 0) > 0,
}
console.log(JSON.stringify(out.읽은것, null, 2))
writeRaw('n1-skeleton.json', out)
fs.rmSync(CLONE, { recursive: true, force: true })
