// LIFE-581 Y3 격리 — 대화 3초 반영. 격리 개발 Electron(g-up.sh /tmp/l581g-* · HOME=<ROOT>/home)에서 합성 기록에 새 줄을 쓰고 폰 자리가 받는 시각을 잰다.
//
//   ⓐ 서버가 그 줄을 읽은 시각(`chat.items.readAt`, 서버 시계) → 폰 수신(`recvAt` + 시계 차 `offsetMs`)
//      = 판독기 꼬리 확인이 그 줄을 본 뒤 변경 고르기·거르기·변환·직렬화·발송·전송·폰 파싱까지.
//   ⓑ 파일에 쓰인 시각(이 스크립트가 append **직전**에 찍은 시각, 같은 기계 시계) → 폰 수신
//      = ⓐ + 쓰인 뒤 판독기가 알아채기까지(fs.watch 없이 폴링 `CHAT_POLL_MS` 250 ms 주기의 대기 포함).
//   참고: ⓑ' = 파일 수정 시각(`writtenAt`, 서버가 stat 한 mtime) → 폰 수신.
//   짝 = 그 회차 표지(`L581-Y3-<n>`)가 원문에 처음 들어 있는 `chat.items`. 대상 대화가 아닌 프레임·표지 없는 프레임은 짝이 아니다.
//   main 로그의 `mobile.chat_push`(readMs·sendMs·totalMs)를 회차 구간으로 붙인다(같은 구간의 push 가 하나여야 짝 — 아니면 null).
//   통과: 회차 ≥ 20 · provider 셋 다 · 종류(지시·답·도구·질문) 넷 다 · ⓐ·ⓑ **전부** ≤ 3000 ms(최대값) · 미수신 0.
//
// 사용(app/ 에서):
//   sh scripts/l577/g-up.sh /tmp/l581g-a /tmp/l581g-fa HOME=/tmp/l581g-a/home
//   node scripts/l581/three-sec.mjs --root /tmp/l581g-a --fake /tmp/l581g-fa --out <dir> [--runs 24]
// 종료 코드: 0 통과 · 1 미달 · 2 사용법. 원자료: <out>/three-sec.json(회차별 시각·구간) · <out>/three-sec.frames.ndjson(받은 대화 프레임마다 종류·id·시각, 글 없음).
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { channelOf, chatLog, checkRoots, pairDevice, phone, revokeAll, setMobile, sleep, until, writeJson } from './lib.mjs'
import { Conversation, agentPane } from './rec.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, runs: { type: 'string', default: '24' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (args.out === undefined) throw new Error('--out 필요')
  if (!/^\d+$/.test(args.runs) || Number(args.runs) < 1) throw new Error(`--runs 는 1 이상의 정수: ${args.runs}`)
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const OUT = path.resolve(args.out)
const RUNS = Number(args.runs)
const LIMIT_MS = 3_000
const AGENTS = ['claude', 'codex', 'grok']
const KINDS = ['prompt', 'reply', 'tool', 'question']

fs.mkdirSync(OUT, { recursive: true })
const framesOut = fs.createWriteStream(path.join(OUT, 'three-sec.frames.ndjson'))

async function main() {
  await setMobile(ROOT, args.fake, true)
  const tag = Date.now().toString(36)
  const lanes = []
  for (const agent of AGENTS) {
    const id = `l581-y3-${agent}-${tag}`
    const conv = new Conversation({ root: ROOT, agent, id })
    conv.write('prompt', `L581-Y3-${agent}-seed`)
    const { paneId } = await agentPane({ root: ROOT, name: `y3-${agent}-${tag}`, agent, id, state: 'working' })
    const token = await pairDevice(ROOT, { name: `l581-y3-${agent}` })
    const received = []
    const client = await phone(ROOT, {
      token,
      name: `l581-y3-${agent}`,
      onFrame: ({ message, recvAt, raw }) => {
        if (!message.type.startsWith('chat.')) return
        received.push({ message, recvAt, raw })
        framesOut.write(JSON.stringify({ agent, recvAt, type: message.type, mode: message.mode ?? null, ids: (message.items ?? []).map((item) => item.id), at: message.at ?? null, readAt: message.readAt ?? null, writtenAt: message.writtenAt ?? null, bytes: Buffer.byteLength(raw) }) + '\n')
      },
    })
    for (let i = 0; i < 5; i += 1) await client.ping()
    await until(() => channelOf(client.lastList()?.list, paneId), { timeoutMs: 10_000, label: `${agent} 채널` })
    client.chat(paneId)
    await until(() => received.some((frame) => frame.message.type === 'chat.page'), { timeoutMs: 10_000, label: `${agent} 첫 페이지` })
    lanes.push({ agent, conv, paneId, client, received })
  }
  const runs = []
  let callN = 0
  for (let n = 0; n < RUNS; n += 1) {
    const lane = lanes[n % lanes.length]
    const kind = KINDS[Math.floor(n / lanes.length) % KINDS.length]
    const marker = `L581-Y3-${String(n).padStart(2, '0')}`
    const before = lane.received.length
    const logFrom = Date.now()
    callN += 1
    const writeAt = lane.conv.write(kind, marker, { callId: `y3c${callN}` })
    const hit = await until(() => lane.received.slice(before).find((frame) => frame.message.type === 'chat.items' && frame.raw.includes(marker)) ?? null, { timeoutMs: 10_000, everyMs: 20, label: `회차 ${n}` }).catch(() => null)
    await sleep(400)
    const clock = lane.client.clockOffset()
    const frame = hit?.value ?? null
    const pushes = chatLog(ROOT).filter((row) => row.tag === 'mobile.chat_push' && Date.parse(row.ts ?? '') >= logFrom - 5)
    const offset = clock?.offsetMs ?? 0
    const row = {
      n,
      agent: lane.agent,
      kind,
      marker,
      writeAt,
      recvAt: frame?.recvAt ?? null,
      serverReadAt: frame?.message.readAt ?? null,
      serverAt: frame?.message.at ?? null,
      writtenAt: frame?.message.writtenAt ?? null,
      offsetMs: offset,
      rttMs: clock?.rttMs ?? null,
      a_ms: frame === null ? null : frame.recvAt + offset - frame.message.readAt,
      b_ms: frame === null ? null : frame.recvAt - writeAt,
      b_mtime_ms: frame === null || typeof frame.message.writtenAt !== 'number' ? null : frame.recvAt + offset - frame.message.writtenAt,
      push: pushes.length === 1 ? { readMs: pushes[0].readMs ?? null, sendMs: pushes[0].sendMs ?? null, totalMs: pushes[0].totalMs ?? null, items: pushes[0].items ?? null, bytes: pushes[0].bytes ?? null } : null,
      pushesInWindow: pushes.length,
    }
    runs.push(row)
    console.log(`회차 ${n} ${lane.agent}/${kind} ⓐ ${row.a_ms} ⓑ ${row.b_ms} ms${frame === null ? ' — 미수신' : ''}`)
    await sleep(300)
  }
  for (const lane of lanes) await lane.client.close()
  await revokeAll(ROOT)
  const a = runs.map((row) => row.a_ms).filter((value) => value !== null)
  const b = runs.map((row) => row.b_ms).filter((value) => value !== null)
  const missing = runs.filter((row) => row.recvAt === null).length
  const agents = new Set(runs.map((row) => row.agent))
  const kinds = new Set(runs.map((row) => row.kind))
  const summary = {
    runs: runs.length,
    missing,
    agents: [...agents],
    kinds: [...kinds],
    a: { max: Math.max(...a), min: Math.min(...a) },
    b: { max: Math.max(...b), min: Math.min(...b) },
    limitMs: LIMIT_MS,
  }
  const pass = runs.length >= 20 && missing === 0 && agents.size === 3 && kinds.size === 4 && summary.a.max <= LIMIT_MS && summary.b.max <= LIMIT_MS
  writeJson(path.join(OUT, 'three-sec.json'), { measuredAt: new Date().toISOString(), intervals: { a: 'server readAt → phone recvAt(+offset)', b: 'append 직전 → phone recvAt', b_mtime: 'mtime(writtenAt) → phone recvAt(+offset)' }, summary, pass, runs })
  console.log(JSON.stringify({ summary, pass }))
  framesOut.end()
  process.exit(pass ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await revokeAll(ROOT).catch(() => {})
  process.exit(1)
})
