// LIFE-581 Y4ⓒ 격리 — 큰 기록 첫 페이지. 이 기계의 가장 큰 기록 **사본**(`/tmp/l581w*`)을 격리 앱의 가짜 HOME 기록 자리에 심볼릭 링크로 붙이고
// 대화를 열어 ① 첫 페이지 서버 준비(main 로그 `mobile.chat_page.firstPageMs` = 구독 입구 → 프레임 준비, 색인 포함) ② 그동안 main 이벤트 루프 지연 p99
// (계측 소켓 `loop-delay` — 구독 직전에 비우고 첫 페이지를 받은 직후 읽는다) ③ 참고: 폰 자리에서 본 구독 → 첫 페이지 수신.
// 회차마다 판독자를 새로 만든다 — 구독을 끊고 유예(`CHAT_GRACE_MS` 15 s) 뒤 main 이 판독자를 버린 것(`mobile.chat_reader_drop`)을 확인하고 다음 회차.
// 받은 프레임의 글은 남기지 않는다(G5 — 크기·개수만). 사본 경로·크기·해시만 원자료에.
//
//   node scripts/l581/big-record.mjs --root /tmp/l581g-b --fake /tmp/l581g-fb --agent claude --copy /tmp/l581w-y1/claude/claude-0/<id>.jsonl --out <dir> [--runs 3]
//   (codex 는 --agent codex --copy /tmp/l581w-y1/codex/codex-0.jsonl)
// 통과: 회차 ≥ 3 · 회차마다 firstPageMs ≤ 1000 · 루프 p99 ≤ 50 ms · 루프 표본 > 0 · 첫 페이지 말풍선 > 0. 종료 코드 0 통과 · 1 미달 · 2 사용법.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { channelOf, chatLog, checkRoots, herdr, loopDelay, pairDevice, phone, revokeAll, setMobile, sleep, until, writeJson } from './lib.mjs'
import { recordFile } from './rec.mjs'
import { freshPane } from './lib.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, agent: { type: 'string' }, copy: { type: 'string' }, runs: { type: 'string', default: '3' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (args.out === undefined) throw new Error('--out 필요')
  if (args.agent !== 'claude' && args.agent !== 'codex') throw new Error('--agent 는 claude · codex')
  if (typeof args.copy !== 'string' || !path.resolve(args.copy).startsWith('/tmp/l581w') || !fs.existsSync(args.copy)) throw new Error('--copy 는 /tmp/l581w* 의 사본 파일')
  if (!/^\d+$/.test(args.runs) || Number(args.runs) < 1) throw new Error('--runs 는 1 이상')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const OUT = path.resolve(args.out)
const AGENT = args.agent
const COPY = path.resolve(args.copy)
// Claude 는 파일 이름이 세션 id(사람 발화 판정 조건) — 사본의 원래 이름을 그대로 쓴다. Codex 는 `-<id>.jsonl` 꼬리로 찾는다.
const ID = AGENT === 'claude' ? path.basename(COPY, '.jsonl') : `l581-big-${Date.now().toString(36)}`
const LIMIT_FIRST_MS = 1_000
const LIMIT_P99_MS = 50

async function main() {
  const bytes = fs.statSync(COPY).size
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(COPY)).digest('hex')
  const link = recordFile({ root: ROOT, agent: AGENT, id: ID })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  if (!fs.existsSync(link)) fs.symlinkSync(COPY, link)
  await setMobile(ROOT, args.fake, true)
  const { paneId } = await freshPane(ROOT, { name: `big-${AGENT}-${Date.now().toString(36)}` })
  await herdr(ROOT, 'pane.report_agent', { pane_id: paneId, source: 'l581-measure', agent: AGENT, state: 'idle' })
  await herdr(ROOT, 'pane.report_agent_session', { pane_id: paneId, source: `herdr:${AGENT}`, agent: AGENT, seq: 1, agent_session_id: ID, session_start_source: 'startup' })
  const token = await pairDevice(ROOT, { name: `l581-big-${AGENT}` })
  const frames = []
  const client = await phone(ROOT, { token, name: `l581-big-${AGENT}`, onFrame: ({ message, recvAt, raw }) => { if (message.type.startsWith('chat.')) frames.push({ type: message.type, retrying: message.retrying ?? null, mode: message.mode ?? null, items: (message.items ?? []).length, hasOlder: message.hasOlder ?? null, bytes: Buffer.byteLength(raw), recvAt }) } })
  await until(() => channelOf(client.lastList()?.list, paneId), { timeoutMs: 15_000, label: '채널' })
  // 세션 참조가 main 상태에 닿기 전에 구독하면 `no_session`(retrying) 이 먼저 온다(F-B11·F-B21 — 도구 순서 결함). 목록 채널이 뜬 뒤 잠깐 둔다.
  await sleep(2_000)
  await loopDelay(ROOT) // 히스토그램 켜기
  const runs = []
  for (let n = 0; n < Number(args.runs); n += 1) {
    const logLines = chatLog(ROOT).length
    const before = frames.length
    await loopDelay(ROOT) // 구간 앞 비우기
    const subscribeAt = Date.now()
    client.chat(paneId)
    const page = await until(() => frames.slice(before).find((frame) => frame.type === 'chat.page' || (frame.type === 'chat.unavailable' && frame.retrying !== true)) ?? null, { timeoutMs: 30_000, everyMs: 5, label: `회차 ${n} 첫 페이지` })
    const loop = (await loopDelay(ROOT)).loopDelay ?? null
    await sleep(300)
    const log = chatLog(ROOT).slice(logLines)
    const pageLog = log.find((row) => row.tag === 'mobile.chat_page' && row.mode === 'reset') ?? null
    const indexLog = log.find((row) => row.tag === 'mobile.chat_index') ?? null
    const row = {
      n,
      phoneFirstPageMs: page.value.recvAt - subscribeAt,
      page: page.value,
      firstPageMs: pageLog?.firstPageMs ?? null,
      index: indexLog === null ? null : { bytes: indexLog.bytes, items: indexLog.items, lines: indexLog.lines, ms: indexLog.ms },
      paused: log.filter((row) => row.tag === 'mobile.chat_index_paused').length,
      loopDelay: loop,
    }
    runs.push(row)
    console.log(`회차 ${n} firstPageMs ${row.firstPageMs} · 폰 ${row.phoneFirstPageMs} ms · 색인 ${row.index?.ms} ms ${row.index?.lines} 줄 · 루프 p99 ${loop?.p99} max ${loop?.max} (표본 ${loop?.count})`)
    client.unsubscribe()
    // 판독자 버림 확인 — 다음 회차가 처음부터 색인한다.
    const dropFrom = chatLog(ROOT).length
    await until(() => chatLog(ROOT).slice(dropFrom).some((line) => line.tag === 'mobile.chat_reader_drop'), { timeoutMs: 30_000, everyMs: 500, label: '판독자 버림' })
  }
  await client.close()
  await revokeAll(ROOT)
  const problems = []
  if (runs.length < 3) problems.push('회차 < 3')
  for (const row of runs) {
    if (row.page.type !== 'chat.page' || row.page.items === 0) problems.push(`회차 ${row.n} 첫 페이지 없음`)
    if (row.firstPageMs === null || row.firstPageMs > LIMIT_FIRST_MS) problems.push(`회차 ${row.n} firstPageMs ${row.firstPageMs}`)
    if (row.loopDelay === null || !(row.loopDelay.count > 0) || row.loopDelay.p99 > LIMIT_P99_MS) problems.push(`회차 ${row.n} 루프 ${JSON.stringify(row.loopDelay)}`)
  }
  const pass = problems.length === 0
  writeJson(path.join(OUT, `big-record-${AGENT}.json`), { measuredAt: new Date().toISOString(), agent: AGENT, copy: { bytes, sha256 }, limits: { firstPageMs: LIMIT_FIRST_MS, loopP99Ms: LIMIT_P99_MS }, pass, problems, runs })
  console.log(JSON.stringify({ agent: AGENT, bytes, pass, problems }))
  process.exit(pass ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await revokeAll(ROOT).catch(() => {})
  process.exit(1)
})
