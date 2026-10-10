// LIFE-582 C1 — 지시 1회 동안 main 이벤트 루프 지연(r1 InputHub · 꼬리 커서). 기록은 /tmp/l582-c1/ 사본만(581 Y4ⓒ 방식, 원본 무접촉).
//   npx tsx scripts/l582/c1-lag.ts /tmp/l582-c1/<사본>.jsonl
// 가짜 provider 는 1초 뒤 기록에 사람 줄 1개를 붙인다 — 그동안 확인 루프가 몇 번 읽는다. 출력: 크기·해시 앞 16자·상태·지연만(본문 없음, G5).
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { chatListState, CHAT_SESSIONS } from '../../src/main/mobile/chat-fixture.js'
import { InputHub, type InputBackend } from '../../src/main/mobile/input.js'

const file = process.argv[2] ?? ''
if (!file.startsWith('/tmp/l582-c1/')) process.exit(2)
const EMPTY = ['', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\r\n')
const line = (text: string) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text }, uuid: 'c1', parentUuid: null, timestamp: new Date().toISOString(), sessionId: CHAT_SESSIONS.claude.id })
const backend: InputBackend = {
  locate: async (paneId) => ({ epoch: 'e', ptyId: 't', paneId, tabId: 'tab', workspaceId: 'ws', path: '/w', repo: '/w', title: 'x' }),
  observe: async () => ({ status: 'idle', seq: 1, quiet: true, unmanaged: false, input: { revision: 1, idleMs: 10_000 } }),
  manifestVerified: async () => true,
  screen: async () => EMPTY,
  prompt: async (_pane, input) => { setTimeout(() => fs.appendFileSync(file, line(input.text) + '\n'), 1000); return 'sent' },
  send: async () => 'sent',
}
const hub = new InputHub({ read: () => ({ state: chatListState(), prefs: null }), backend: () => backend, resolveFile: () => ({ kind: 'found', file }), questionItems: () => [], log: () => {} })
const states: string[] = []
const done = new Promise<void>((resolve) => hub.attach({ device: 'd', sink: (text) => { const state = String(JSON.parse(text).state); states.push(state); if (!['queued', 'sending'].includes(state)) resolve() } }))
const size = fs.statSync(file).size
const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
const keep = setInterval(() => {}, 1000)
await new Promise((resolve) => setTimeout(resolve, 200))
const h = monitorEventLoopDelay({ resolution: 5 })
h.enable()
const t0 = Date.now()
hub.send({ device: 'd', id: `c1-${Date.now()}`, channel: 'c1', text: 'c1 lag probe' })
await done
h.disable()
console.log(JSON.stringify({ bytes: size, sha16: sha, states, ms: Date.now() - t0, lagMs: { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6, mean: Math.round(h.mean / 1e4) / 100 } }))
hub.stop()
clearInterval(keep)
process.exit(0)
