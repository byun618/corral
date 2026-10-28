// LIFE-577 리뷰 r1 회귀 시험 — 지적 하나에 시험 하나 이상(R1-A1·A2·A3·A4·A7·A10·A11·N1·N2).
// 재현 모양은 리뷰 원자료(`raw/review/codex-r1-raw/probes.mts`·`exposure-probes.mts`)를 따랐다. 가짜 tailscale CLI + 실제 서버.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PairingStore } from './pairing.js'
import { MobileServer } from './server.js'
import { MobileService } from './service.js'
import { runTailscale, type TailscaleRunner } from './tailscale.js'

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/mobile-repro/fake-tailscale.mjs')
const DNS = 'fix1.example.ts.net'
const PORT = 8577
const KEY = `${DNS}:${PORT}`

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Json = Record<string, unknown>
type Harness = {
  s: MobileService
  get: () => { serve: Json; [key: string]: unknown }
  set: (patch: Json) => void
  serveCalls: () => string[][]
}

function harness(input: { hook?: (args: readonly string[], h: Harness) => void; failOff?: () => boolean } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577f-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ backendState: 'Running', dnsName: DNS, certDomains: [DNS], serve: {} }))
  process.env.FAKE_TAILSCALE_DIR = dir
  const run: TailscaleRunner = (call) => {
    input.hook?.(call.args, h)
    if (input.failOff?.() === true && call.args.at(-1) === 'off') return Promise.resolve({ ok: false, reason: 'exit', detail: 'permission denied (injected)' })
    return runTailscale(call)
  }
  const s = new MobileService({ userData: path.join(dir, 'user'), appVersion: 'fix1', log: () => {}, onStatus: () => {}, locate: async () => FAKE, run, recheckMs: 60_000 })
  cleanups.push(() => s.shutdown(3000))
  const h: Harness = {
    s,
    get: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    set: (patch) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch })),
    serveCalls: () => {
      const calls = path.join(dir, 'calls.ndjson')
      if (!fs.existsSync(calls)) return []
      return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).argv).filter((argv: string[]) => argv[0] === 'serve' && argv[1] !== 'status')
    },
  }
  return h
}

type Client = { ws: WebSocket; next: () => Promise<Json>; closed: Promise<number> }
function connect(port: number, origin?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin === undefined ? {} : { origin })
    const queue: Json[] = []
    const waiters: ((value: Json) => void)[] = []
    ws.on('message', (data) => {
      const parsed: Json = JSON.parse(data.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(parsed)
      else queue.push(parsed)
    })
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)))
    ws.once('open', () => resolve({ ws, closed, next: () => { const queued = queue.shift(); return queued ? Promise.resolve(queued) : new Promise((done) => waiters.push(done)) } }))
    ws.once('error', reject)
    cleanups.push(() => ws.terminate())
  })
}

async function pair(h: Harness): Promise<{ client: Client; token: string }> {
  const qr = h.s.createPairing()
  if (!qr.ok) throw new Error(qr.error)
  const port = h.s.status().serverPort
  if (port === null) throw new Error('서버 없음')
  const client = await connect(port)
  client.ws.send(JSON.stringify({ type: 'pair', protocol: 1, code: qr.code, name: 'fix1' }))
  const reply = await client.next()
  expect(reply.type).toBe('paired')
  return { client, token: String(reply.token) }
}

const record = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {})
const web = (h: Harness): Json => record(h.get().serve.Web)
/** 우리 host:port 의 `/` 를 바꾼 serve — 같은 site 의 다른 경로는 그대로. */
const withHandler = (h: Harness, route: string, handler: Json): Json => {
  const serve = h.get().serve
  const handlers = record(record(web(h)[KEY]).Handlers)
  return { ...serve, Web: { ...web(h), [KEY]: { Handlers: { ...handlers, [route]: handler } } } }
}

describe('R1-A1 — listen 중 shutdown', () => {
  it('shutdown 이 기동을 끝까지 따라잡는다: 서버·serve 항목이 되살아나지 않는다', async () => {
    const h = harness()
    const start = h.s.start(true)
    await Promise.resolve()
    await h.s.shutdown(3000)
    await start
    expect(h.s.status().serverPort).toBeNull()
    expect(h.s.status().exposure.kind).not.toBe('exposed')
    expect(h.get().serve).toEqual({})
    expect(h.serveCalls().filter((argv) => argv.at(-1) !== 'off')).toEqual([])
  })
})

describe('R1-A2 — 차단 시 로컬 서버도 받지 않는다 · 제거 실패를 성공으로 쓰지 않는다', () => {
  it('Funnel 감지 + 제거 실패 → 「내렸다」 없음·failed, 새 인증 거절, 기존 연결 닫힘 → 재확인이 마무리', async () => {
    let failOff = false
    const h = harness({ failOff: () => failOff })
    await h.s.start(true)
    const { client, token } = await pair(h)
    failOff = true
    h.set({ serve: { ...h.get().serve, AllowFunnel: { [`${DNS}:443`]: true } } })
    await h.s.recheckNow()
    const status = h.s.status()
    expect(status.exposure.kind).toBe('failed')
    expect(status.warning ?? '').not.toContain('내렸다')
    expect(web(h)[KEY]).toBeDefined()
    expect(await client.closed).toBeGreaterThanOrEqual(4000)
    const again = await connect(status.serverPort ?? 0)
    again.ws.send(JSON.stringify({ type: 'hello', protocol: 1, token }))
    expect(await again.next()).toMatchObject({ type: 'error', code: 'unavailable' })
    failOff = false
    await h.s.recheckNow()
    expect(h.s.status().exposure).toMatchObject({ kind: 'blocked', reason: 'funnel' })
    expect(h.s.status().warning ?? '').toContain('내렸다')
    expect(web(h)[KEY]).toBeUndefined()
  })

  it('HTTPS 꺼짐으로 차단돼도 기존 연결을 닫고 새 인증을 거절한다', async () => {
    const h = harness()
    await h.s.start(true)
    const { client, token } = await pair(h)
    h.set({ certDomains: [] })
    await h.s.recheckNow()
    expect(h.s.status().exposure).toMatchObject({ kind: 'blocked', reason: 'https' })
    expect(await client.closed).toBeGreaterThanOrEqual(4000)
    const again = await connect(h.s.status().serverPort ?? 0)
    again.ws.send(JSON.stringify({ type: 'hello', protocol: 1, token }))
    expect(await again.next()).toMatchObject({ type: 'error', code: 'unavailable' })
  })

  it('정상 재확인(노출 유지)은 기존 연결을 끊지 않는다', async () => {
    const h = harness()
    await h.s.start(true)
    const { client } = await pair(h)
    await h.s.recheckNow()
    client.ws.send(JSON.stringify({ type: 'ping', id: 'still' }))
    expect(await client.next()).toMatchObject({ type: 'pong', id: 'still' })
  })
})

describe('R1-A3 — 쓰기 직전 재조회 · 쓰기 뒤 기대 상태 대조', () => {
  it('관측 뒤 쓰기 직전에 남이 `/` 를 바꾸면 지우지 않는다(직전 재조회)', async () => {
    let swapOnNextStatus = false
    let statusReads = 0
    const h = harness({
      hook: (args, self) => {
        if (args[0] === 'serve' && args[1] === 'status' && swapOnNextStatus) {
          statusReads += 1
          // 첫 조회(reconcile 관측)는 그대로, 두 번째(쓰기 직전 재조회) 앞에서 바꾼다.
          if (statusReads === 2) {
            self.set({ serve: withHandler(self, '/', { Proxy: 'http://127.0.0.1:9999' }) })
            swapOnNextStatus = false
          }
        }
      },
    })
    await h.s.start(true)
    swapOnNextStatus = true
    await h.s.setEnabled(false)
    expect(web(h)[KEY]).toEqual({ Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } })
    expect(h.serveCalls().filter((argv) => argv.at(-1) === 'off')).toEqual([])
  })

  it('쓰기(off)와 동시에 다른 항목이 바뀌면 조용히 끝내지 않고 failed + 경고', async () => {
    const h = harness({
      hook: (args, self) => {
        if (args.at(-1) === 'off') self.set({ serve: { ...self.get().serve, TCP: { ...record(self.get().serve.TCP), '9443': { HTTPS: true } }, Web: { ...web(self), [`${DNS}:9443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7000' } } } } } })
      },
    })
    await h.s.start(true)
    await h.s.setEnabled(false)
    expect(h.s.status().exposure.kind).toBe('failed')
    expect(h.s.status().warning ?? '').toContain('동시에')
  })

  it('추가와 동시에 다른 경로가 생기면 failed + 경고(노출됨으로 쓰지 않는다)', async () => {
    const h = harness({
      hook: (args, self) => {
        if (args[0] === 'serve' && args[1] === '--bg') self.set({ serve: { TCP: { '9443': { HTTPS: true } }, Web: { [`${DNS}:9443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7000' } } } } } })
      },
    })
    await h.s.start(true)
    expect(h.s.status().exposure.kind).toBe('failed')
    expect(h.s.status().warning ?? '').toContain('동시에')
  })
})

describe('R1-A4 — 포트 점유와 `/` 소유를 분리', () => {
  it('같은 host:port 에 남의 `/other` 가 생겨도 자기 `/` 는 자기 것 — 끄기는 `/` 만 지우고 `/other` 를 남긴다', async () => {
    const h = harness()
    await h.s.start(true)
    const own = h.s.ownerRecord()
    h.set({ serve: withHandler(h, '/other', { Proxy: 'http://127.0.0.1:9000' }) })
    await h.s.recheckNow()
    expect(h.s.status().exposure.kind).toBe('exposed')
    expect(h.s.ownerRecord()).toEqual(own)
    await h.s.setEnabled(false)
    expect(web(h)[KEY]).toEqual({ Handlers: { '/other': { Proxy: 'http://127.0.0.1:9000' } } })
    expect(h.s.ownerRecord()).toBeNull()
    expect(h.s.status().exposure.kind).toBe('off')
  })
})

describe('R1-A11 — DNS 이름 변경', () => {
  it('이름이 바뀌면 옛 이름 항목이 남은 채 새 주소를 노출됨으로 쓰지 않는다 — 옛 항목이 사라지면 새 이름으로 재조정', async () => {
    const h = harness()
    await h.s.start(true)
    const renamed = 'renamed.example.ts.net'
    h.set({ dnsName: renamed, certDomains: [renamed] })
    await h.s.recheckNow()
    expect(h.s.status().exposure.kind).not.toBe('exposed')
    expect(h.s.ownerRecord()?.host).toBe(DNS)
    expect(Object.keys(web(h))).toEqual([KEY])
    // 사용자가 옛 항목을 정리했다 → 다음 재확인에서 새 이름으로 다시 올린다.
    h.set({ serve: {} })
    await h.s.recheckNow()
    expect(h.s.status().exposure).toMatchObject({ kind: 'exposed', url: `wss://${renamed}:${PORT}/ws` })
    expect(Object.keys(web(h))).toEqual([`${renamed}:${PORT}`])
  })
})

describe('R1-N1 — Foreground 포트 점유', () => {
  it('Foreground 세션이 8577 을 쓰면 foreign — 배경 항목을 올리지 않는다', async () => {
    const foreign = { TCP: { [PORT]: { HTTPS: true } }, Web: { [KEY]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } } } }
    const h = harness()
    h.set({ serve: { Foreground: { session1: foreign } } })
    await h.s.start(true)
    expect(h.s.status().exposure.kind).toBe('foreign')
    expect(h.serveCalls()).toEqual([])
    expect(h.get().serve).toEqual({ Foreground: { session1: foreign } })
  })
})

describe('R1-N2 — Origin', () => {
  it('Origin 이 있으면 자기 노출 주소 origin 만, 없으면 허용', async () => {
    const h = harness()
    await h.s.start(true)
    const port = h.s.status().serverPort ?? 0
    await expect(connect(port, 'https://evil.example')).rejects.toBeTruthy()
    await expect(connect(port, `https://${DNS}`)).rejects.toBeTruthy()
    const same = await connect(port, `https://${DNS}:${PORT}`)
    same.ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'x' }))
    expect(await same.next()).toMatchObject({ code: 'unauthorized' })
    const none = await connect(port)
    none.ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'x' }))
    expect(await none.next()).toMatchObject({ code: 'unauthorized' })
  })
})

describe('서버 단위 — R1-A7 · R1-A10', () => {
  async function bare(): Promise<{ server: MobileServer; store: PairingStore; port: number }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577g-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const store = new PairingStore({ dir })
    store.load()
    const server = new MobileServer({ pairing: store, appVersion: 'fix1', macName: () => 'test-mac', log: () => {}, onChange: () => {} })
    const port = await server.start()
    cleanups.push(() => server.stop())
    return { server, store, port }
  }

  it('R1-A7 거절될 hello + 정상 pair 를 같은 write 로 — 기기 수·코드 그대로', async () => {
    const { store, port } = await bare()
    const { code } = store.createCode()
    const client = await connect(port)
    // 두 프레임을 한 번에 보낸다(ws 는 이어 보낸 send 를 같은 소켓 write 로 묶는다).
    client.ws.send(JSON.stringify({ type: 'hello', protocol: 999, token: 'x' }))
    client.ws.send(JSON.stringify({ type: 'pair', protocol: 1, code, name: 'sneaky' }))
    expect(await client.next()).toMatchObject({ code: 'protocol_mismatch' })
    await client.closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.list()).toHaveLength(0)
    expect(store.pairingExpiresAt()).not.toBeNull()
  })

  it.each([
    ['Sec-WebSocket-Key 없음', 'Sec-WebSocket-Version: 13\r\n'],
    ['버전 8', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n'], // gitleaks:allow — RFC 6455 §1.3 예제 키
    ['하위 프로토콜 모양 오류', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: a,,b\r\n'], // gitleaks:allow — RFC 6455 §1.3 예제 키
  ])('R1-A10 틀린 업그레이드(%s)도 404 본문 없음(거절 형식 통일)', async (_name, headers) => {
    const { port } = await bare()
    const out = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n`))
      let text = ''
      socket.on('data', (chunk) => { text += chunk.toString() })
      socket.on('close', () => resolve(text))
      socket.on('error', reject)
    })
    expect(out.startsWith('HTTP/1.1 404')).toBe(true)
    expect(out.split('\r\n\r\n')[1] ?? '').toBe('')
  })
})

// ---- LIFE-577 리뷰 r2 회귀(R2-A2 · R2-A3) — 같은 하네스를 쓴다 ----

describe('R2-A2 — 자기 host:port 의 AllowFunnel:false 정리는 정상 delta', () => {
  const OWN = `${DNS}:${PORT}`
  it('false 키가 있는 설정에서 켜기 → exposed·경고 없음(CLI 가 SetFunnel(false) 로 그 키를 지운다)', async () => {
    const h = harness()
    h.set({ serve: { AllowFunnel: { [OWN]: false } } })
    await h.s.start(true)
    expect(h.s.status().exposure.kind).toBe('exposed')
    expect(h.s.status().warning).toBeNull()
    expect(h.get().serve.AllowFunnel).toBeUndefined()
  })

  it('노출 중 자기 키 false 가 생긴 뒤 끄기 → off·경고 없음·설정 {} (RemoveWebHandler 가 마지막 경로와 함께 지운다)', async () => {
    const h = harness()
    await h.s.start(true)
    h.set({ serve: { ...h.get().serve, AllowFunnel: { [OWN]: false } } })
    await h.s.recheckNow()
    expect(h.s.status().exposure.kind).toBe('exposed')
    await h.s.setEnabled(false)
    expect(h.s.status().exposure.kind).toBe('off')
    expect(h.s.status().warning).toBeNull()
    expect(h.get().serve).toEqual({})
  })

  it('다른 포트의 Funnel 값 변화는 여전히 동시 변경 — failed + 경고', async () => {
    const h = harness({
      hook: (args, self) => {
        if (args[0] === 'serve' && args[1] === '--bg') self.set({ serve: { ...self.get().serve, AllowFunnel: { [`${DNS}:9443`]: false } } })
      },
    })
    await h.s.start(true)
    expect(h.s.status().exposure.kind).toBe('failed')
    expect(h.s.status().warning ?? '').toContain('동시에')
  })
})

describe('R2-A3 — 기록 없는 최초 등록은 포트가 완전히 비어 있을 때만', () => {
  it('기록 없음 + 같은 host:8577 에 남의 `/other` → foreign, serve 쓰기 0, 설정 그대로', async () => {
    const other = { TCP: { [PORT]: { HTTPS: true } }, Web: { [KEY]: { Handlers: { '/other': { Proxy: 'http://127.0.0.1:9000' } } } } }
    const h = harness()
    h.set({ serve: other })
    await h.s.start(true)
    expect(h.s.status().exposure.kind).toBe('foreign')
    expect(h.serveCalls()).toEqual([])
    expect(h.get().serve).toEqual(other)
    expect(h.s.ownerRecord()).toBeNull()
  })

  it('기록 없음 + 그 포트에 TCP 칸만 남아 있어도 foreign', async () => {
    const h = harness()
    h.set({ serve: { TCP: { [PORT]: { HTTPS: true } } } })
    await h.s.start(true)
    expect(h.s.status().exposure.kind).toBe('foreign')
    expect(h.serveCalls()).toEqual([])
  })
})
