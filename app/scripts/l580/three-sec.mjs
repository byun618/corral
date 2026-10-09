// LIFE-580 J5 · L3 격리 — 3초 반영. 격리 개발 Electron(g-up.sh /tmp/l580g-*)에서 에이전트 상태를 바꿔 가며 폰 자리(repro 클라이언트)가 받는 시각을 잰다.
//
//   ⓐ main 이 그 변화를 담은 상태를 낸 시각(list `changedAt`) → 폰 수신   ⓑ 변화를 일으킨 시각(`pane.report_agent` 직전) → 폰 수신
//   통과: 전이 ≥ 20회, ⓐ·ⓑ **전부** ≤ 3000 ms(최대값 기준). 시계 차는 ping/pong 의 서버 시각으로 보정한다(같은 기계 — 보정값을 원자료에 남긴다).
//   전이는 working → idle → blocked → working … 를 섞는다(질문 대기·권한 대기 같은 blocked 사유는 provider 가 없어 이 경로로는 안 생긴다 — 점은 blocked).
//
// 사용(app/ 에서):
//   sh scripts/l577/g-up.sh /tmp/l580g-a /tmp/l580g-fa
//   node scripts/l580/three-sec.mjs --root /tmp/l580g-a --fake /tmp/l580g-fa --out ../specs/LIFE-580-mobile-list/raw/claude/l3 [--transitions 24]
//   sh scripts/l577/g-down.sh /tmp/l580g-a term herdr
// 종료 코드: 0 통과 · 1 미달 · 2 사용법 오류. 원자료: <out>/three-sec.json(전이별 시각) · <out>/three-sec.ndjson(받은 목록마다 seq·시각, 제목 없음).
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoots, freshPane, phone, reportAgent, revokeAll, setMobile, sleep, until, writeJson } from './lib.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, transitions: { type: 'string', default: '24' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (args.out === undefined) throw new Error('--out 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const FAKE = args.fake
const OUT = path.resolve(args.out)
const N = Number(args.transitions)
const LIMIT_MS = 3_000
const CYCLE = ['working', 'idle', 'blocked', 'working', 'blocked', 'idle']
/** herdr 보고 → 데스크톱 점(`shared/agent-dot.ts`) — provider 없는 보고라 이 셋으로만 간다. idle 은 보고 직후 done 으로 보일 수 있다(seen 장부 없음). */
const DOTS_OF = { working: ['working'], idle: ['idle', 'done'], blocked: ['blocked', 'waiting'] }

fs.mkdirSync(OUT, { recursive: true })
const ndjson = fs.createWriteStream(path.join(OUT, 'three-sec.ndjson'))
const received = []
const dotOf = (list, paneId) => {
  if (!list?.available) return null
  for (const repo of list.repos) for (const task of repo.tasks) for (const channel of task.channels) if (channel.id === paneId) return channel.dot
  return null
}

async function main() {
  await setMobile(ROOT, FAKE, true)
  const { paneId } = await freshPane(ROOT)
  // 첫 보고 — 셸 pane 을 에이전트 채널로 만든다(목록은 AI 세션만).
  await reportAgent(ROOT, { paneId, state: 'idle' })
  const client = await phone(ROOT, {
    onList: ({ message, recvAt }) => {
      const dot = dotOf(message.list, paneId)
      received.push({ seq: message.seq, epoch: message.epoch, at: message.at, changedAt: message.changedAt, recvAt, dot })
      ndjson.write(JSON.stringify({ seq: message.seq, at: message.at, changedAt: message.changedAt, recvAt, dot }) + '\n')
    },
  })
  for (let i = 0; i < 5; i += 1) await client.ping()
  await until(() => received.some((item) => item.dot !== null), { timeoutMs: 10_000, label: '첫 목록에 측정 채널' })

  const rows = []
  for (let i = 0; i < N; i += 1) {
    const state = CYCLE[i % CYCLE.length]
    const before = received.length
    const causeAt = await reportAgent(ROOT, { paneId, state })
    const got = await until(() => received.slice(before).find((item) => DOTS_OF[state].includes(item.dot)) ?? null, { timeoutMs: 10_000, label: `전이 ${i} ${state}` }).catch(() => null)
    await client.ping()
    const offset = client.clockOffset()?.offsetMs ?? 0
    if (got === null) rows.push({ i, state, causeAt, miss: true })
    else {
      const hit = got.value
      // 서버 시각 → 내 시각: 서버 시각 − offset.
      const changedLocal = hit.changedAt - offset
      rows.push({ i, state, dot: hit.dot, seq: hit.seq, causeAt, changedAt: hit.changedAt, recvAt: hit.recvAt, offsetMs: offset, aMs: hit.recvAt - changedLocal, bMs: hit.recvAt - causeAt })
    }
    // 키 반복이 아니라 상태 전이를 재는 것 — 다음 보고까지 1.0~1.6초 둔다(뭉침 창보다 길게).
    await sleep(1_000 + Math.floor(Math.random() * 600))
  }
  const hits = rows.filter((row) => !row.miss)
  const maxA = Math.max(...hits.map((row) => row.aMs))
  const maxB = Math.max(...hits.map((row) => row.bMs))
  const pass = rows.length >= 20 && hits.length === rows.length && maxA <= LIMIT_MS && maxB <= LIMIT_MS
  const result = {
    at: new Date().toISOString(),
    method: 'ⓐ=폰 수신 − (changedAt − 시계차), ⓑ=폰 수신 − report_agent 직전 시각. 시계차=ping/pong 최단 왕복 표본의 (서버 at − 중간점). 판정은 최대값.',
    transitions: rows.length,
    misses: rows.length - hits.length,
    maxAMs: maxA,
    maxBMs: maxB,
    clock: client.clockOffset(),
    limitMs: LIMIT_MS,
    verdict: pass ? '통과' : '미달',
    rows,
  }
  writeJson(path.join(OUT, 'three-sec.json'), result)
  console.log(`J5 전이 ${rows.length} · 놓침 ${result.misses} · ⓐ 최대 ${maxA}ms · ⓑ 최대 ${maxB}ms → ${result.verdict}`)
  await client.close()
  await revokeAll(ROOT)
  ndjson.end()
  process.exit(pass ? 0 : 1)
}

main().catch((error) => {
  console.error('FAIL', error)
  ndjson.end()
  process.exit(1)
})
