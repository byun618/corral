// LIFE-582 Z1 측정 도우미 — 제품과 같은 guard 봉투(`TerminalBackend`)로 격리 herdr 에 raw 바이트·지시를 넣는다.
//   npx tsx scripts/l582/guard.ts <sock> get  <pane>
//   npx tsx scripts/l582/guard.ts <sock> send <pane> <json 문자열 — 예: "\"\\u001b[B\"">
//   npx tsx scripts/l582/guard.ts <sock> stale <pane>  — 틀린 seq 로 `pane.send_text`(LIFE-582 guard 비교) → 거절·화면 무변경 확인.
//     기대(거절 코드 agent_state_changed · 화면 그대로 · zz 없음)가 어긋나면 exit 1 — exit 0 만 통과다(C3).
//   npx tsx scripts/l582/guard.ts <sock> keys <pane> <json 배열 — 각 원소를 한 번씩 보내고 사이마다 agent.get seq 를 찍는다> [간격 ms]
// 격리 소켓만 받는다(`/herdr-dev/sessions/l582`·`l577g-l582g-` 포함) — 설치본 herdr 에 닿지 않게.
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalBackend } from '../../src/main/adapter/index.js'

const [sock, command, paneId, payload, gap] = process.argv.slice(2)
if (sock === undefined || !(sock.includes('/herdr-dev/sessions/l582') || sock.includes('/herdr-dev/sessions/l577g-l582g-')) || paneId === undefined) { console.error('usage (isolated l582 socket only)'); process.exit(2) }
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })
const backend = new TerminalBackend(sock)
const epoch = await backend.epoch(ctx())
const pane = (await backend.list(epoch, ctx())).find(p => p.paneId === paneId)
if (pane === undefined) { console.error('no pane'); process.exit(1) }
const seq = async () => { const a = await backend.agentInfo(pane, ctx()); return `${a.status}#${a.stateChangeSeq} ready=${a.interactiveReady} launchPending=${a.launchPending}` }
switch (command) {
  case 'get': console.log(await seq()); break
  case 'send': {
    const text: unknown = JSON.parse(payload ?? '""')
    if (typeof text !== 'string') process.exit(2)
    await backend.send(pane, text, ctx())
    console.log('sent', await seq())
    break
  }
  case 'keys': {
    const parsed: unknown = JSON.parse(payload ?? '[]')
    const keys = Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
    console.log('before', await seq())
    for (const key of keys) {
      await backend.send(pane, key, ctx())
      await delay(Number(gap ?? '300'))
      console.log(JSON.stringify(key), await seq())
    }
    break
  }
  case 'stale': {
    const before = await backend.agentInfo(pane, ctx())
    const screenBefore = await backend.screenAnsi(pane, ctx())
    const wrong = before.stateChangeSeq + 1000
    let refused: string | null = null
    try {
      await backend.sendIfUnchanged(pane, 'zz', wrong, ctx())
    } catch (error) {
      refused = error instanceof Error && 'code' in error ? String(error.code) : String(error)
    }
    await delay(800)
    const screenAfter = await backend.screenAnsi(pane, ctx())
    const after = await backend.agentInfo(pane, ctx())
    const result = { seqBefore: before.stateChangeSeq, sentWithSeq: wrong, refused, seqAfter: after.stateChangeSeq, screenUnchanged: screenBefore === screenAfter, screenHasZz: screenAfter.includes('zz') }
    const pass = result.refused === 'agent_state_changed' && result.screenUnchanged && !result.screenHasZz
    console.log(JSON.stringify({ pass, ...result }))
    if (!pass) process.exit(1)
    break
  }
  default: process.exit(2)
}
