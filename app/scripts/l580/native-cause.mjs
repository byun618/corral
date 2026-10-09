// LIFE-580 J5 네이티브 — 원인 시각을 직접 기록하는 전이 만들기(R2-A4, 코디 방향).
//
// **어디서 도나**: 설치본 corral 런타임의 **전용 셸 pane** 안(코디가 L12 회차에서 그 pane 에 이 명령을 친다). herdr 가 pane 마다 넣는
// 환경 `HERDR_BIN_PATH`·`HERDR_SOCKET_PATH`·`HERDR_PANE_ID` 로 **자기 pane** 에 `herdr pane report-agent` 를 보낸다 — 대상 세션 = 이 pane
// (목록 채널 id = pane id). 다른 pane 에는 보내지 않는다. corral CLI 에는 상태 보고 명령이 없어 같은 런타임의 herdr CLI 를 쓴다.
//
// **원인 시각** = 보고 호출 **직전**의 맥 시각(`causeAt`, ms). main 의 `changedAt`·로그 `at` 과 같은 맥 시계다. 회차마다 한 줄 NDJSON:
//   {i, label, state, pane, causeAt, doneAt, exit, stderr?}
// 실패한 보고(exit ≠ 0)도 줄로 남긴다 — 계산기(`native-j5.mjs`)가 그 전이를 원인 시각 없음으로 보고 5회에서 뺀다.
//
// 사용(전용 셸 pane 안에서, 레포의 app/):
//   node scripts/l580/native-cause.mjs --out <cause.ndjson> --sequence working,idle,blocked,working,idle [--gap-ms 8000] [--agent claude] [--release]
//   node scripts/l580/native-cause.mjs --out <cause.ndjson> --state working         # 한 번만
//   --isolated : HERDR_SOCKET_PATH 가 격리 세션(`…/herdr-dev/sessions/l577g-l580g-…`)일 때만 돈다 — 워커 dry-run 용 안전장치
// 종료 코드: 0 전부 보고 성공 · 1 보고 실패 있음 · 2 사용법 오류(herdr pane 밖 · 인자 틀림).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const STATES = ['idle', 'working', 'blocked', 'unknown']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function usage(message) {
  console.error(message)
  process.exit(2)
}

let values
try {
  values = parseArgs({
    options: {
      out: { type: 'string' },
      state: { type: 'string' },
      sequence: { type: 'string' },
      'gap-ms': { type: 'string', default: '8000' },
      agent: { type: 'string', default: 'claude' },
      source: { type: 'string', default: 'l580-native-j5' },
      label: { type: 'string', default: '' },
      release: { type: 'boolean', default: false },
      isolated: { type: 'boolean', default: false },
    },
  }).values
} catch (error) {
  usage(String(error.message ?? error))
}

const bin = process.env.HERDR_BIN_PATH
const socket = process.env.HERDR_SOCKET_PATH
const pane = process.env.HERDR_PANE_ID
if (!bin || !socket || !pane) usage('herdr pane 안이 아니다 — HERDR_BIN_PATH·HERDR_SOCKET_PATH·HERDR_PANE_ID 가 필요하다(전용 셸 pane 에서 실행)')
if (values.isolated && !/\/herdr-dev\/sessions\/l577g-l580g-[^/]+\/herdr\.sock$/.test(socket)) usage(`--isolated 인데 격리 세션 소켓이 아니다: ${socket}`)
if (values.out === undefined) usage('--out 필요')
const states = values.sequence !== undefined ? values.sequence.split(',').map((item) => item.trim()) : values.state !== undefined ? [values.state] : []
if (states.length === 0 || states.some((state) => !STATES.includes(state))) usage(`--state 또는 --sequence 는 ${STATES.join('|')} 중에서`)
const gapMs = Number(values['gap-ms'])
if (!Number.isInteger(gapMs) || gapMs < 1000) usage('--gap-ms 는 1000 이상의 정수(전이 사이가 뭉침·다른 변화와 섞이지 않게)')

fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
const herdrEnv = { ...process.env, HERDR_SOCKET_PATH: socket }

function report(state) {
  const causeAt = Date.now()
  const run = spawnSync(bin, ['pane', 'report-agent', '--source', values.source, '--agent', values.agent, '--state', state, pane], { env: herdrEnv, encoding: 'utf8', timeout: 10_000 })
  return { causeAt, doneAt: Date.now(), exit: run.status ?? -1, stderr: (run.stderr ?? '').trim().slice(0, 200) || undefined }
}

let failed = 0
for (const [i, state] of states.entries()) {
  if (i > 0) await sleep(gapMs)
  const result = report(state)
  if (result.exit !== 0) failed += 1
  const row = { i, label: values.label, state, pane, ...result }
  fs.appendFileSync(values.out, JSON.stringify(row) + '\n')
  console.log(`${i} ${state} pane=${pane} causeAt=${result.causeAt} exit=${result.exit}`)
}
if (values.release) {
  // herdr 0.9.0 의 release-agent 는 도움말(`[OPTIONS] … <PANE_ID>`)과 달리 pane id 를 **먼저** 받는다 — 뒤에 두면 `unknown option` exit 2
  // (dry-run d02 실측). report-agent 는 어느 순서든 받는다.
  const run = spawnSync(bin, ['pane', 'release-agent', pane, '--source', values.source, '--agent', values.agent], { env: herdrEnv, encoding: 'utf8', timeout: 10_000 })
  console.log(`release exit=${run.status}${run.status === 0 ? '' : ` ${(run.stderr ?? '').trim().slice(0, 200)}`}`)
  if (run.status !== 0) failed += 1
}
process.exit(failed === 0 ? 0 : 1)
