// LIFE-581 Y5ⓐ 격리 — 재연결 뒤 이어 보기, **항목 id 대조(id 오라클)**.
//
// 폰 쪽 = **앱의 실제 연결 관리자 + 대화 상태**(`mobile/src/core/connection.ts` `ConnectionManager` · `chat-store.ts` `ChatStore`)를 Node 에서 그대로 돌린다
// (SocketLike 는 node `ws` 로 — 관리자 주석대로 RN WebSocket 과 같은 모양, Origin 은 앱 개발 경로처럼 QR 주소의 origin). 재연결·이어 받기 요청·병합은 앱 코드다.
// 끊김 = 스크립트 안 TCP 중계(127.0.0.1)를 끊고(열린 소켓 파괴 + 듣기 중지) 끊긴 동안 합성 기록에 새 줄 ≥ 3건(지시·답·도구·그 도구 결과 = 같은 id 자람)을 쓴 뒤 중계를 되살린다.
// 폰 쪽은 **아무 조작도 하지 않는다** — 관리자의 백오프 재연결 → ChatStore 의 이어 받기(`{gen, from, cursor}`)만.
// 오라클 = 서버 쪽 **독립 연결**(새 기기 토큰, 처음부터 구독 `reset`)의 말풍선 id 집합 S 와 폰 대화 상태의 id 집합 P:
//   빠짐 = |S − P| · 남음 = |P − S| · 중복 = P 배열 길이 − |P| · 내용 불일치 = 같은 id 의 종류·상태·글이 다른 수. 넷 다 0 이어야 통과.
//   그리고 끊긴 동안 쓴 표지(`L581-Y5-…`)가 폰 상태에 전부 있고(양성 대조 — 쓴 줄이 실제로 서버 집합에 들어갔는지도 같이 본다), 재연결 뒤 구독이 `resume` 이었는지.
// provider 셋을 차례로. 원자료에는 id·종류·상태·시각만(글 없음 — 합성이라 비밀은 아니지만 형식은 같다).
//
//   npx tsx scripts/l581/reconnect.ts --root /tmp/l581g-c --fake /tmp/l581g-fc --out <dir>
// 종료 코드: 0 통과 · 1 미달 · 2 사용법.
import net from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'
import { ConnectionManager, type PairingRecord, type SocketLike } from '../../../mobile/src/core/connection'
import { ChatStore } from '../../../mobile/src/core/chat-store'
import { createTimerClock } from '../../../mobile/src/core/clock'
import { ConnectionLog } from '../../../mobile/src/core/log'
import { originOf, parsePairingPayload } from '../../../mobile/src/core/payload'
import type { ChatItem } from '../../../mobile/src/core/chat'
import { channelOf, checkRoots, ctl, pairDevice, phone, revokeAll, setMobile, sleep, status, until, writeJson } from './lib.mjs'
import { Conversation, agentPane } from './rec.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, during: { type: 'string', default: '4' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (args.out === undefined) throw new Error('--out 필요')
  if (!/^\d+$/.test(args.during ?? '') || Number(args.during) < 3) throw new Error('--during 은 3 이상(끊긴 동안 쓸 줄 수)')
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(2)
}
const ROOT = String(args.root)
const OUT = path.resolve(String(args.out))
const DURING = Number(args.during)

/** 끊을 수 있는 중계 — 127.0.0.1 에만 묶는다. */
function relay(target: number) {
  const sockets = new Set<net.Socket>()
  let server: net.Server | null = null
  const events: { at: number; event: string }[] = []
  const listen = (port: number) =>
    new Promise<number>((resolve) => {
      server = net.createServer((client) => {
        const upstream = net.connect(target, '127.0.0.1')
        sockets.add(client)
        sockets.add(upstream)
        client.pipe(upstream)
        upstream.pipe(client)
        const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream) }
        client.on('error', end).on('close', end)
        upstream.on('error', end).on('close', end)
        events.push({ at: Date.now(), event: 'conn' })
      })
      server.listen(port, '127.0.0.1', () => {
        const address = server?.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
  return {
    events,
    listen,
    cut: () => new Promise<void>((resolve) => {
      events.push({ at: Date.now(), event: 'cut' })
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (server === null) return resolve()
      server.close(() => resolve())
      server = null
    }),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

type Lane = { agent: string; paneId: string; conv: { write: (kind: string, marker: string, opts?: Record<string, unknown>) => number } }

async function oracleSet(token: string, paneId: string): Promise<{ ids: number[]; items: Record<string, unknown>[] }> {
  type Frame = { message: { type: string; items?: Record<string, unknown>[]; hasOlder?: boolean } }
  const frames: Frame[] = []
  const client = await phone(ROOT, { token, name: 'l581-y5-oracle', onFrame: (frame: Frame) => { if (frame.message.type.startsWith('chat.')) frames.push(frame) } })
  await until(() => channelOf(client.lastList()?.list, paneId), { timeoutMs: 10_000, label: '오라클 채널' })
  client.chat(paneId)
  const page = await until(() => frames.find((frame) => frame.message.type === 'chat.page') ?? null, { timeoutMs: 10_000, label: '오라클 첫 페이지' })
  await client.close()
  if (page.value.message.hasOlder === true) throw new Error('오라클 대화가 한 페이지를 넘는다 — 대조가 서지 않는다')
  const items = page.value.message.items ?? []
  return { ids: items.map((item) => Number(item['id'])), items }
}

/** 폰 말풍선과 서버 말풍선이 같은가 — 종류 · 글 · 도구 상태·대상 · 질문 상태(앱 파싱 뒤 모양과 서버 wire 모양을 같은 칸으로). */
function sameItem(phoneItem: ChatItem, wire: Record<string, unknown>): boolean {
  if (phoneItem.kind !== wire['kind']) return false
  switch (phoneItem.kind) {
    case 'prompt':
    case 'reply':
      return isRecord(wire['body']) && phoneItem.body.text === wire['body']['text']
    case 'tools': {
      const tools = Array.isArray(wire['tools']) ? wire['tools'] : []
      return phoneItem.tools.length === tools.length && phoneItem.tools.every((tool, i) => { const other: unknown = tools[i]; return isRecord(other) && tool.status === other['status'] && tool.target === other['target'] && tool.name === other['name'] })
    }
    case 'question':
      return phoneItem.state === wire['state']
    case 'note':
      return phoneItem.note === wire['note']
  }
}

async function runLane(lane: Lane, relayPort: number, serverPort: number) {
  // 오라클 기기를 먼저 페어링하고 그 연결로 채널이 목록에 오른 것을 본다(측정 전 준비).
  const oracleToken = await pairDevice(ROOT, { name: `l581-y5-oracle-${lane.agent}` })
  const watcher = await phone(ROOT, { token: oracleToken, name: 'l581-y5-oracle' })
  await until(() => channelOf(watcher.lastList()?.list, lane.paneId), { timeoutMs: 15_000, label: `${lane.agent} 채널 목록` })
  await watcher.close()
  const log = new ConnectionLog(() => Date.now())
  const lines: string[] = []
  log.addSink((_entry, line) => lines.push(line))
  let stored: PairingRecord | null = null
  const vault = { load: async () => stored, save: async (record: PairingRecord) => { stored = record }, clear: async () => { stored = null } }
  const openSocket = (url: string): SocketLike => {
    const origin = originOf(url) ?? undefined
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`, origin === undefined ? {} : { headers: { origin } })
    const adapter: SocketLike = {
      get readyState() { return ws.readyState },
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }
    ws.onopen = () => adapter.onopen?.({})
    ws.onmessage = (event) => adapter.onmessage?.({ data: String(event.data) })
    ws.onclose = (event) => adapter.onclose?.({ code: event.code, reason: event.reason })
    ws.onerror = (event) => adapter.onerror?.(event)
    return adapter
  }
  const manager = new ConnectionManager({ openSocket, vault, clock: createTimerClock(), log, appVersion: '0.1.0', deviceName: `l581-y5-${lane.agent}` })
  const chat = new ChatStore({ connection: manager, now: () => Date.now(), timer: createTimerClock(), log })
  await manager.start()
  const pairing = await ctl(ROOT, { cmd: 'mobile-pairing' })
  const parsed = parsePairingPayload(String(pairing.pairing?.payload ?? ''))
  if (!parsed.ok) throw new Error(`페이로드 읽기 실패 ${parsed.problem.kind}`)
  manager.pair(parsed.target)
  await until(() => manager.getSnapshot().conn.kind === 'connected', { timeoutMs: 15_000, label: `${lane.agent} 연결` })
  chat.open(lane.paneId)
  // 준비 — 막 만든 pane 이 목록에 오르기 전이면 `not_listed` 다. 그때만 다시 연다(측정 전 단계, 끊김 뒤에는 아무 조작도 없다).
  await until(() => { const phase = chat.getSnapshot().phase; if (phase.kind === 'unavailable') chat.retry(); return phase.kind === 'ready' }, { timeoutMs: 15_000, everyMs: 500, label: `${lane.agent} 목록 오름` }).catch(() => null)
  await until(() => chat.getSnapshot().phase.kind === 'ready', { timeoutMs: 15_000, label: `${lane.agent} 대화 ready` }).catch((error) => { console.error(lines.slice(-15).join('\n'), JSON.stringify(chat.getSnapshot().phase)); throw error })
  // 연결된 채 두 줄(정상 push 확인).
  lane.conv.write('reply', `L581-Y5-${lane.agent}-live-0`)
  lane.conv.write('tool', `L581-Y5-${lane.agent}-live-1`, { callId: 'y5-live' })
  await until(() => JSON.stringify(chat.getSnapshot().items).includes(`L581-Y5-${lane.agent}-live-1`), { timeoutMs: 10_000, label: '연결 중 push' })
  const before = chat.getSnapshot().items.map((item) => item.id)
  // 끊기 — 중계를 죽인다. 앱은 다음 ping 마감에서(또는 close 를 받아) 재연결 중으로.
  const cutAt = Date.now()
  await relayCtl.cut()
  await until(() => manager.getSnapshot().conn.kind === 'reconnecting', { timeoutMs: 30_000, everyMs: 50, label: '재연결 중 진입' })
  const reconnectingAt = Date.now()
  const written: { marker: string; kind: string; at: number }[] = []
  const plan = [
    { kind: 'prompt', opts: {} },
    { kind: 'reply', opts: {} },
    { kind: 'tool_result', opts: { callId: 'y5-live', error: true } },
    { kind: 'tool', opts: { callId: 'y5-off' } },
    { kind: 'question', opts: {} },
    { kind: 'reply', opts: {} },
  ]
  for (let i = 0; i < DURING; i += 1) {
    const step = plan[i % plan.length] ?? plan[0]
    const marker = `L581-Y5-${lane.agent}-off-${i}`
    written.push({ marker, kind: step.kind, at: lane.conv.write(step.kind, marker, step.opts) })
    await sleep(400)
  }
  const heldWhileOff = chat.getSnapshot().items.map((item) => item.id)
  await sleep(1_000)
  const restoreAt = Date.now()
  await relayCtl.listen(relayPort)
  // 무조작 — 관리자가 스스로 다시 붙고 ChatStore 가 스스로 이어 받는다.
  const back = await until(() => manager.getSnapshot().conn.kind === 'connected', { timeoutMs: 40_000, everyMs: 50, label: '재연결' })
  const markersIn = () => written.filter((entry) => entry.kind !== 'tool_result').every((entry) => JSON.stringify(chat.getSnapshot().items).includes(entry.marker))
  await until(() => markersIn() || null, { timeoutMs: 15_000, label: '끊긴 동안 줄 도착' }).catch(() => null)
  await sleep(1_000)
  const snapshot = chat.getSnapshot()
  const phoneIds = snapshot.items.map((item) => item.id)
  const server = await oracleSet(oracleToken, lane.paneId)
  const P = new Set(phoneIds)
  const S = new Set(server.ids)
  const missing = server.ids.filter((id) => !P.has(id))
  const extra = phoneIds.filter((id) => !S.has(id))
  const duplicates = phoneIds.length - P.size
  const byId = new Map(server.items.map((item) => [Number(item['id']), item]))
  const mismatched = snapshot.items.filter((item) => { const wire = byId.get(item.id); return wire !== undefined && !sameItem(item, wire) }).map((item) => item.id)
  const markersMissing = written.filter((entry) => entry.kind !== 'tool_result' && !JSON.stringify(snapshot.items).includes(entry.marker)).map((entry) => entry.marker)
  const markersOnServer = written.filter((entry) => entry.kind !== 'tool_result' && JSON.stringify(server.items).includes(entry.marker)).length
  const growth = snapshot.items.find((item) => item.kind === 'tools' && item.tools.some((tool) => (tool.target ?? '').includes(`L581-Y5-${lane.agent}-live-1`)))
  const resumeLines = lines.filter((line) => line.includes('chat_subscribe') || line.includes('chat_recv') || line.includes('reconnect') || line.includes('live'))
  await manager.unpair().catch(() => {})
  // 기기 상한 5 — 차례마다 이 차례의 두 기기(앱·오라클)를 해지한다(킥오프 격리 8).
  await revokeAll(ROOT)
  await sleep(300)
  return {
    agent: lane.agent,
    times: { cutAt, reconnectingAt, restoreAt, connectedAt: restoreAt + back.ms },
    written: written.map((entry) => ({ marker: entry.marker, kind: entry.kind, at: entry.at })),
    before,
    heldWhileOff,
    phoneIds,
    serverIds: server.ids,
    missing,
    extra,
    duplicates,
    mismatched,
    markersMissing,
    markersOnServer,
    growthStatus: growth?.kind === 'tools' ? growth.tools.map((tool) => tool.status) : null,
    resumed: resumeLines.some((line) => /chat_recv.*"?mode"?[=:] ?"?resume/.test(line)),
    connLog: resumeLines.map((line) => line.replace(/token[^ ]*/g, '<redacted>')).slice(-40),
    serverPort,
  }
}

let relayCtl: ReturnType<typeof relay>

async function main() {
  await setMobile(ROOT, args.fake, true)
  const serverPort = Number((await status(ROOT)).serverPort)
  relayCtl = relay(serverPort)
  const relayPort = await relayCtl.listen(0)
  const tag = Date.now().toString(36)
  const results = []
  for (const agent of ['claude', 'codex', 'grok']) {
    const id = `l581-y5-${agent}-${tag}`
    const conv = new Conversation({ root: ROOT, agent, id })
    conv.write('prompt', `L581-Y5-${agent}-seed`)
    const { paneId } = await agentPane({ root: ROOT, name: `y5-${agent}-${tag}`, agent, id, state: 'working' })
    const result = await runLane({ agent, paneId, conv }, relayPort, serverPort)
    results.push(result)
    console.log(`${agent}: 폰 ${result.phoneIds.length} · 서버 ${result.serverIds.length} · 빠짐 ${result.missing.length} · 남음 ${result.extra.length} · 중복 ${result.duplicates} · 불일치 ${result.mismatched.length} · 표지 빠짐 ${result.markersMissing.length} · resume ${result.resumed} · 자람 ${JSON.stringify(result.growthStatus)}`)
  }
  await relayCtl.cut()
  await revokeAll(ROOT)
  const problems: string[] = []
  for (const row of results) {
    if (row.written.length < 3) problems.push(`${row.agent} 끊긴 동안 줄 < 3`)
    if (row.missing.length + row.extra.length + row.duplicates + row.mismatched.length > 0) problems.push(`${row.agent} 집합 차이`)
    if (row.markersMissing.length > 0) problems.push(`${row.agent} 표지 빠짐 ${row.markersMissing.length}`)
    if (row.markersOnServer !== row.written.filter((entry) => entry.kind !== 'tool_result').length) problems.push(`${row.agent} 서버 집합에 표지가 다 없다(양성 대조)`)
    if (!row.resumed) problems.push(`${row.agent} resume 아님`)
    if (JSON.stringify(row.growthStatus) !== '["error"]') problems.push(`${row.agent} 끊긴 동안 자란 도구 상태 ${JSON.stringify(row.growthStatus)}`)
  }
  const pass = problems.length === 0
  writeJson(path.join(OUT, 'reconnect.json'), { measuredAt: new Date().toISOString(), oracle: '서버 독립 연결 reset 페이지 id 집합 = 폰(앱 ConnectionManager+ChatStore) id 집합', pass, problems, results })
  console.log(JSON.stringify({ pass, problems }))
  process.exit(pass ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await revokeAll(ROOT).catch(() => {})
  process.exit(1)
})
