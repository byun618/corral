// S1 — 깨끗한 체크아웃에서 설치 1회 + 명령 1줄로 창이 뜨고 렌더러가 그려지는가.
//
// "깨끗한 체크아웃"은 커밋된 상태에서 새로 뜬 디렉터리다. 이 스크립트는 **그 디렉터리 안의**
// app/ 을 대상으로 돌아야 한다 — node_modules 가 이미 있는 곳에서 돌린 결과는 S1 의 근거가 아니다.
//
// 사용: node <clean>/app/scripts/m-s1.mjs   (자기 위치를 기준으로 판단한다)

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { APP_DIR, RAW_DIR, control, readLog, sleep } from './lib.mjs'

const run = promisify(execFile)
// 원자료는 항상 작업 worktree 의 raw/claude/ 에 쌓는다 (깨끗한 체크아웃은 버릴 디렉터리다).
const OUT_DIR = process.env.LIFE344_RAW_DIR ?? RAW_DIR
const SESSION = process.env.CORRAL_SESSION ?? 'life344-probe'

if (fs.existsSync(path.join(APP_DIR, 'node_modules'))) {
  throw new Error(`node_modules 가 이미 있다 (${APP_DIR}). S1 은 깨끗한 체크아웃에서만 의미가 있다`)
}

const lines = []
const record = (title, body) => lines.push(`$ ${title}\n${body}`)
record('pwd', APP_DIR)
record('git log -1 --oneline', (await run('git', ['log', '-1', '--oneline'], { cwd: APP_DIR })).stdout.trim())
record('node -v && npm -v', `${process.version}\n${(await run('npm', ['-v'])).stdout.trim()}`)

// --- 설치 1회 ------------------------------------------------------------
const installStarted = Date.now()
const install = await run('/bin/sh', ['-c', 'npm install 2>&1'], { cwd: APP_DIR, maxBuffer: 32 * 1024 * 1024 })
record('npm install', `${install.stdout.trim()}\n(${((Date.now() - installStarted) / 1000).toFixed(1)}s)`)

// --- 명령 1줄로 개발 모드 ------------------------------------------------
const logPath = path.join(os.tmpdir(), `l344-s1-${Date.now()}.ndjson`)
const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l344-s1-')), 'c.sock')
const shotDir = path.join(OUT_DIR, 'shots')
fs.mkdirSync(shotDir, { recursive: true })

const dev = spawn('npm', ['run', 'dev'], {
  cwd: APP_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CORRAL_LOG: logPath,
    CORRAL_SESSION: SESSION,
    CORRAL_CONTROL_SOCKET: controlSocket,
    CORRAL_SHOT_DIR: shotDir,
  },
})
let devOutput = ''
dev.stdout.on('data', (chunk) => (devOutput += chunk))
dev.stderr.on('data', (chunk) => (devOutput += chunk))

const deadline = Date.now() + 120000
let live = null
while (Date.now() < deadline) {
  const entries = readLog(logPath)
  const hit = entries.find((entry) => entry.tag === 'link.phase' && entry.phase === 'live')
  const drawn = entries.find((entry) => entry.tag === 'ui.rendered')
  if (hit && drawn) {
    live = { liveAt: hit.at, renderedAt: drawn.at }
    break
  }
  await sleep(200)
}
await sleep(1200)

let shot = null
if (live !== null) shot = await control(controlSocket, { cmd: 'shot', name: 's1-dev-window' })
const entries = readLog(logPath)
dev.kill('SIGTERM')
await sleep(800)
dev.kill('SIGKILL')

record('CORRAL_SESSION=' + SESSION + ' npm run dev', devOutput.trim().slice(0, 4000))
record(
  '앱 로그 (요약)',
  entries
    .filter((entry) => ['app.ready', 'link.phase', 'renderer.probe', 'ui.rendered', 'shot.captured'].includes(entry.tag))
    .slice(0, 20)
    .map((entry) => `${entry.ts} ${entry.tag} ${entry.phase ?? entry.revision ?? entry.name ?? ''}`)
    .join('\n'),
)

const summary = {
  measuredAt: new Date().toISOString(),
  cleanCheckout: APP_DIR,
  installOnce: true,
  singleCommand: 'npm run dev',
  windowLive: live !== null,
  rendererDrawn: entries.some((entry) => entry.tag === 'ui.rendered'),
  rendererProbePresent: entries.some((entry) => entry.tag === 'renderer.probe'),
  screenshot: shot?.file ?? null,
}
fs.writeFileSync(path.join(OUT_DIR, '13-s1-clean-checkout.txt'), lines.join('\n\n') + '\n')
fs.writeFileSync(path.join(OUT_DIR, '13-s1-clean-checkout.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
process.exit(0)
