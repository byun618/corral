// LIFE-580 J5 네이티브 — 원인 시각을 직접 기록하는 전이 만들기(R2-A4, 코디 방향).
//
// **어디서 도나**: 설치본 corral 런타임의 **전용 셸 pane** 안(코디가 L12 회차에서 그 pane 에 이 명령을 친다). herdr 가 pane 마다 넣는
// 환경 `HERDR_BIN_PATH`·`HERDR_SOCKET_PATH`·`HERDR_PANE_ID` 로 **자기 pane** 에 `herdr pane report-agent` 를 보낸다 — 대상 세션 = 이 pane
// (목록 채널 id = pane id). 다른 pane 에는 보내지 않는다. corral CLI 에는 상태 보고 명령이 없어 같은 런타임의 herdr CLI 를 쓴다.
//
// **원인 시각** = 보고 호출 **직전**의 맥 시각(`causeAt`, ms). main 의 `changedAt`·로그 `at` 과 같은 맥 시계다. 회차마다 한 줄 NDJSON:
//   {kind:'cause', i, label, state, target, expect, expectDots, pane, causeAt, doneAt, exit, stderr?}
//   `target` = 목록 채널 id(= 이 pane id) · `expect` = 기대 상태(보고한 상태) · `expectDots` = 그 상태가 목록에서 보일 점(R3-A2) —
//   계산기가 「대상 채널이 기대 상태로 바뀐 첫 목록」 을 고르는 근거다.
// 실패한 보고(exit ≠ 0)도 줄로 남긴다 — 계산기(`native-j5.mjs`)가 그 전이를 원인 시각 없음으로 보고 5회에서 뺀다.
// **정리(R3-A4)**: `--release` 면 정상 끝(마지막 보고 뒤 한 간격 기다린 뒤 — 마지막 전이가 목록에 실리게) · 일반 예외 · SIGINT · SIGTERM 어느 길로 끝나도 **같은 pane·source·agent 만** 한 번 release 한다
// (`{kind:'release', reason, exit}` 줄). 중단은 `{kind:'interrupted', signal}`, 예외는 `{kind:'error'}` 줄로 남기고 exit 1(실패 회차) —
// 계산기는 이런 줄이 있으면 미달로 본다. release 실패도 줄과 exit 1 로 남는다. SIGKILL 은 보장하지 않는다(수동 release).
//
// 사용(전용 셸 pane 안에서, 레포의 app/):
//   node scripts/l580/native-cause.mjs --out <cause.ndjson> --sequence working,idle,blocked,working,idle [--gap-ms 8000] [--agent claude] [--release]
//   node scripts/l580/native-cause.mjs --out <cause.ndjson> --state working         # 한 번만
//   --isolated : HERDR_SOCKET_PATH 가 격리 세션(`…/herdr-dev/sessions/l577g-l580g-…`)일 때만 돈다 — 워커 dry-run 용 안전장치
// 종료 코드: 0 전부 보고·정리 성공 · 1 보고 실패·정리 실패·중단·예외 있음 · 2 사용법 오류(herdr pane 밖 · 인자 틀림).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DOTS_OF } from './transition-match.mjs'

// J5 전이로 셀 수 있는 상태만 — 목록 점으로 옮길 수 있어야 대상 확인이 된다(unknown 은 뺐다, R3-A2).
const STATES = Object.keys(DOTS_OF)
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
let released = false
let stopping = false

function record(row) {
  fs.appendFileSync(values.out, JSON.stringify(row) + '\n')
}

function recordQuietly(row) {
  try {
    record(row)
  } catch (error) {
    console.error(`기록 실패(${row.kind}): ${String(error.message ?? error).slice(0, 200)}`)
  }
}

/** `--release` 면 한 번만 — 이 pane·source·agent 의 표시만 거둔다. 어느 종료 길에서 불려도 두 번 돌지 않는다. */
function release(reason) {
  if (!values.release || released) return
  released = true
  // herdr 0.9.0 의 release-agent 는 도움말(`[OPTIONS] … <PANE_ID>`)과 달리 pane id 를 **먼저** 받는다 — 뒤에 두면 `unknown option` exit 2
  // (dry-run d02 실측). report-agent 는 어느 순서든 받는다.
  const run = spawnSync(bin, ['pane', 'release-agent', pane, '--source', values.source, '--agent', values.agent], { env: herdrEnv, encoding: 'utf8', timeout: 10_000 })
  const exit = run.status ?? -1
  const stderr = (run.stderr ?? '').trim().slice(0, 200) || undefined
  console.log(`release reason=${reason} exit=${exit}${exit === 0 ? '' : ` ${stderr ?? ''}`}`)
  if (exit !== 0) failed += 1
  recordQuietly({ kind: 'release', reason, pane, source: values.source, agent: values.agent, exit, stderr })
}

function interrupt(signal) {
  // 두 번째 신호는 무시한다 — 정리 도중 기본 동작(즉시 종료)으로 release 를 끊지 않게.
  if (stopping) return
  stopping = true
  failed += 1
  console.error(`중단(${signal}) — 실패 회차`)
  recordQuietly({ kind: 'interrupted', signal, label: values.label, pane, at: Date.now() })
  release(signal)
  process.exit(1)
}
process.on('SIGINT', () => interrupt('SIGINT'))
process.on('SIGTERM', () => interrupt('SIGTERM'))

try {
  for (const [i, state] of states.entries()) {
    if (i > 0) await sleep(gapMs)
    const result = report(state)
    if (result.exit !== 0) failed += 1
    record({ kind: 'cause', i, label: values.label, state, target: pane, expect: state, expectDots: DOTS_OF[state], pane, ...result })
    console.log(`${i} ${state} pane=${pane} causeAt=${result.causeAt} exit=${result.exit}`)
  }
  // 마지막 전이도 목록에 실린 뒤 거둔다 — 바로 release 하면 마지막 보고와 release 가 한 목록으로 묶여(100 ms 뭉침) 대상이 기대 상태 대신
  // 「사라짐」 으로 간다(r3 dry-run d02 실측: 마지막 working 이 `w1:p1=-` 로만 보였다). 이 대기 중 신호는 중단(실패)이다.
  if (values.release) await sleep(gapMs)
  stopping = true
  release('end')
} catch (error) {
  stopping = true
  failed += 1
  console.error(`예외 — 실패 회차: ${String(error.message ?? error).slice(0, 200)}`)
  recordQuietly({ kind: 'error', message: String(error.message ?? error).slice(0, 200), label: values.label, pane, at: Date.now() })
  release('error')
}
process.exit(failed === 0 ? 0 : 1)
