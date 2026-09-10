// 세션 재기동 경로 비교 — 킥오프 §2 의 "헤드리스 자동 기동이 안 된다" 를 실측으로 확인/정정한다.
//
// herdr 는 스스로 뜨지 않는다(스파이크 제약 5). 되살리려면 `herdr session attach` 를 불러야 하고
// 그건 TTY 를 요구한다. Orca 탭이 그 TTY 를 준다 — 그런데 얼마나 걸리나?
//   ① Orca 탭 (`orca terminal create --command "herdr session attach …"`, --focus 없음)
//   ② PTY 만 붙인 헤드리스 (`script -q /dev/null herdr session attach …`)
// K6 의 15초 예산은 이 선택에 직접 걸린다.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { SESSION, sleep, socketPath, writeRaw } from './lib.mjs'

const run = promisify(execFile)
const SOCK = socketPath()

async function stopSession() {
  await run('herdr', ['session', 'stop', SESSION]).catch(() => {})
  for (let i = 0; i < 50; i++) {
    if (!fs.existsSync(SOCK)) return
    await sleep(100)
  }
}

async function waitUp(from, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(SOCK)) return Date.now() - from
    await sleep(50)
  }
  return null
}

// --- ② PTY 헤드리스 -------------------------------------------------------
await stopSession()
const ptyAt = Date.now()
spawn('script', ['-q', '/dev/null', 'herdr', 'session', 'attach', SESSION], { detached: true, stdio: 'ignore' }).unref()
const ptyMs = await waitUp(ptyAt, 90000)

// --- ① Orca 탭 -----------------------------------------------------------
await sleep(1000)
await stopSession()
const orcaAt = Date.now()
const created = await run('orca', [
  'terminal',
  'create',
  '--title',
  `herdr: ${SESSION} (restart probe)`,
  '--command',
  `herdr session attach ${SESSION}`,
  '--json',
])
const orcaMs = await waitUp(orcaAt, 120000)
const orcaHandle = JSON.parse(created.stdout).result.terminal.handle

// 프로브가 만든 Orca 탭은 정리한다 (탭이 쌓이면 사용자 화면이 지저분해진다).
await run('orca', ['terminal', 'close', '--terminal', orcaHandle, '--json']).catch(async () => {
  await run('orca', ['terminal', 'close', orcaHandle, '--json']).catch(() => {})
})

// 마지막은 헤드리스로 살려 둔다 (측정 사이 세션이 있어야 한다).
if (!fs.existsSync(SOCK)) {
  spawn('script', ['-q', '/dev/null', 'herdr', 'session', 'attach', SESSION], { detached: true, stdio: 'ignore' }).unref()
  await waitUp(Date.now(), 30000)
}

const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  question: 'herdr 세션을 되살리는 두 경로 중 어느 쪽이 K6 의 15초 예산 안에 드는가',
  headlessPty: { command: 'script -q /dev/null herdr session attach <name>', socketUpMs: ptyMs },
  orcaTab: {
    command: 'orca terminal create --command "herdr session attach <name>" (--focus 없음)',
    socketUpMs: orcaMs,
    note: 'Orca 탭은 UI 가 그 탭을 실제로 붙일 때까지 셸이 시작되지 않는 것으로 보인다',
  },
  conclusion:
    'TTY 만 있으면 헤드리스로 즉시 뜬다. 킥오프의 "헤드리스 자동 기동이 안 된다"는 정확히는 ' +
    '"TTY 없이는 안 된다"이고, PTY 를 붙이면 Orca 없이도 된다.',
}

writeRaw('25-restart-paths.json', result)
console.log(JSON.stringify({ ptyMs, orcaMs }, null, 2))
