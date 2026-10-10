// LIFE-582 Z1 측정 도우미 — 제품과 같은 guard 봉투(`TerminalBackend`)로 격리 herdr 에 raw 바이트·지시를 넣는다.
//   npx tsx scripts/l582/guard.ts <sock> get  <pane>
//   npx tsx scripts/l582/guard.ts <sock> send <pane> <json 문자열 — 예: "\"\\u001b[B\"">
//   npx tsx scripts/l582/guard.ts <sock> keys <pane> <json 배열 — 각 원소를 한 번씩 보내고 사이마다 agent.get seq 를 찍는다> [간격 ms]
// 격리 소켓만 받는다(`/herdr-dev/sessions/l582` 포함) — 설치본 herdr 에 닿지 않게.
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalBackend } from '../../src/main/adapter/index.js'

const [sock, command, paneId, payload, gap] = process.argv.slice(2)
if (sock === undefined || !sock.includes('/herdr-dev/sessions/l582') || paneId === undefined) { console.error('usage (isolated l582 socket only)'); process.exit(2) }
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })
const backend = new TerminalBackend(sock)
const epoch = await backend.epoch(ctx())
const pane = (await backend.list(epoch, ctx())).find(p => p.paneId === paneId)
if (pane === undefined) { console.error('no pane'); process.exit(1) }
const seq = async () => { const a = await backend.agentInfo(pane, ctx()); return `${a.status}#${a.stateChangeSeq}` }
switch (command) {
  case 'get': console.log(await seq()); break
  case 'send': await backend.send(pane, JSON.parse(payload ?? '""') as string, ctx()); console.log('sent', await seq()); break
  case 'keys': {
    const keys = JSON.parse(payload ?? '[]') as string[]
    console.log('before', await seq())
    for (const key of keys) {
      await backend.send(pane, key, ctx())
      await delay(Number(gap ?? '300'))
      console.log(JSON.stringify(key), await seq())
    }
    break
  }
  default: process.exit(2)
}
