// 가짜 tailscale CLI 통합 (LIFE-577 A1ⓒ·A6·A7) — 실제 서버를 띄우고, serve 설정은 가짜 CLI 의 state.json 으로 본다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { MobileStatus } from '../../shared/mobile.js'
import { PROTOCOL_VERSION } from './protocol.js'
import { MobileService } from './service.js'
import { MOBILE_HTTPS_PORT, runTailscale } from './tailscale.js'

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/l577/fake-tailscale.mjs')
const DNS = 'fake-mac.example.ts.net'
const PORT = MOBILE_HTTPS_PORT

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type FakeState = {
  backendState?: string
  dnsName?: string
  certDomains?: string[] | null
  serve?: Record<string, unknown>
  hang?: string[]
  failAdd?: boolean
}

type Harness = {
  userData: string
  fakeDir: string
  setFake: (patch: FakeState) => void
  serve: () => Record<string, unknown>
  calls: () => string[][]
  service: (options?: { cli?: boolean; recheckMs?: number }) => MobileService
  statuses: MobileStatus[]
}

function harness(initial: FakeState = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l577i-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'userData')
  const fakeDir = path.join(root, 'fake')
  fs.mkdirSync(fakeDir, { recursive: true })
  const stateFile = path.join(fakeDir, 'state.json')
  const base: FakeState = { backendState: 'Running', dnsName: DNS, certDomains: [DNS], serve: {}, hang: [], failAdd: false }
  fs.writeFileSync(stateFile, JSON.stringify({ ...base, ...initial }))
  const statuses: MobileStatus[] = []
  return {
    userData,
    fakeDir,
    statuses,
    setFake: (patch) => {
      const current: FakeState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      fs.writeFileSync(stateFile, JSON.stringify({ ...current, ...patch }))
    },
    serve: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).serve ?? {},
    calls: () => {
      const file = path.join(fakeDir, 'calls.ndjson')
      if (!fs.existsSync(file)) return []
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line).argv)
    },
    service: (options = {}) => {
      const service = new MobileService({
        userData,
        appVersion: '0.0.0-test',
        log: () => {},
        onStatus: (status) => statuses.push(status),
        locate: async () => (options.cli === false ? null : FAKE),
        run: (input) => runTailscale(input),
        recheckMs: options.recheckMs ?? 60_000,
      })
      cleanups.push(() => service.shutdown(3000))
      return service
    },
  }
}

process.env.FAKE_TAILSCALE_DIR = ''
function useFake(h: Harness): void {
  process.env.FAKE_TAILSCALE_DIR = h.fakeDir
}

const FOREIGN_443 = {
  TCP: { '443': { HTTPS: true } },
  Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
}

function serveCalls(calls: string[][]): string[][] {
  return calls.filter((argv) => argv[0] === 'serve' && argv[1] !== 'status')
}

describe('꺼짐 (A1ⓒ)', () => {
  it('꺼진 상태 기동·종료 동안 tailscale 호출 0회, 서버 없음', async () => {
    const h = harness()
    useFake(h)
    const service = h.service()
    await service.start(false)
    expect(service.status()).toMatchObject({ enabled: false, serverPort: null, exposure: { kind: 'off' } })
    await service.shutdown(3000)
    expect(h.calls()).toEqual([])
  })
})

describe('serve 항목 (A6)', () => {
  it('켜기 → corral 항목 1개(남의 443 유지) · 끄기 → 그 항목만 제거', async () => {
    const h = harness({ serve: structuredClone(FOREIGN_443) })
    useFake(h)
    const service = h.service()
    await service.start(true)
    const status = service.status()
    expect(status.exposure).toEqual({ kind: 'exposed', host: DNS, httpsPort: PORT, url: `wss://${DNS}:${PORT}/ws` })
    const on = h.serve()
    expect(on).toEqual({
      TCP: { '443': { HTTPS: true }, [PORT]: { HTTPS: true } },
      Web: { ...FOREIGN_443.Web, [`${DNS}:${PORT}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${status.serverPort}` } } } },
    })
    await service.setEnabled(false)
    expect(h.serve()).toEqual(FOREIGN_443)
    expect(service.status()).toMatchObject({ enabled: false, serverPort: null, exposure: { kind: 'off' } })
    expect(service.ownerRecord()).toBeNull()
    expect(h.calls().some((argv) => argv.includes('reset') || argv[0] === 'funnel')).toBe(false)
  })

  it('같은 포트에 남의 항목 → 덮어쓰지 않고 foreign, 끄기도 건드리지 않는다', async () => {
    const foreign = { TCP: { [PORT]: { HTTPS: true } }, Web: { [`${DNS}:${PORT}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }
    const h = harness({ serve: structuredClone(foreign) })
    useFake(h)
    const service = h.service()
    await service.start(true)
    expect(service.status().exposure.kind).toBe('foreign')
    await service.setEnabled(false)
    expect(h.serve()).toEqual(foreign)
    expect(serveCalls(h.calls())).toEqual([])
  })

  it('정상 종료(shutdown) → 항목 제거, 스위치는 켜진 채라 재기동하면 재등록', async () => {
    const h = harness()
    useFake(h)
    const first = h.service()
    await first.start(true)
    expect(Object.keys(h.serve().Web ?? {})).toEqual([`${DNS}:${PORT}`])
    await first.shutdown(5000)
    expect(h.serve()).toEqual({})
    const second = h.service()
    await second.start(true)
    expect(second.status().exposure.kind).toBe('exposed')
    expect(Object.keys(h.serve().Web ?? {})).toEqual([`${DNS}:${PORT}`])
  })

  it('비정상 종료 뒤 재기동 — 켜 둔 상태: 항목 정확히 1개, 대상 갱신 (A6ⓔ)', async () => {
    const h = harness()
    useFake(h)
    const crashed = h.service()
    await crashed.start(true)
    const oldPort = crashed.status().serverPort
    // 「SIGKILL」 — serve 항목은 정리 없이 남는다. 옛 서버를 잠시 살려 둬 새 기동이 다른 포트를 받게 한다(대상 갱신을 실제로 보려고).
    const next = h.service()
    await next.start(true)
    await crashed['server'].stop()
    const newPort = next.status().serverPort
    expect(newPort).not.toBe(oldPort)
    expect(h.serve()).toEqual({ TCP: { [PORT]: { HTTPS: true } }, Web: { [`${DNS}:${PORT}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${newPort}` } } } } })
  })

  it('비정상 종료 뒤 재기동 — 꺼 둔 상태: 소유권 기록과 대조해 지운다 → 0', async () => {
    const h = harness()
    useFake(h)
    const crashed = h.service()
    await crashed.start(true)
    await crashed['server'].stop()
    const next = h.service()
    await next.start(false)
    expect(h.serve()).toEqual({})
    expect(next.ownerRecord()).toBeNull()
  })

  it('기록 없이 같은 포트에 같은 모양 항목이 있으면 우리 것이 아니다 — 지우지 않는다', async () => {
    const lookalike = { TCP: { [PORT]: { HTTPS: true } }, Web: { [`${DNS}:${PORT}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:40000' } } } } }
    const h = harness({ serve: structuredClone(lookalike) })
    useFake(h)
    const service = h.service()
    await service.start(false)
    expect(h.calls()).toEqual([])
    await service.setEnabled(true)
    expect(service.status().exposure.kind).toBe('foreign')
    await service.setEnabled(false)
    expect(h.serve()).toEqual(lookalike)
  })

  it('켜기·끄기 5회 연타 → 마지막 값, 항목 중복 없음 (A6ⓖ)', async () => {
    const h = harness()
    useFake(h)
    const service = h.service()
    await service.start(false)
    const waits: Promise<void>[] = []
    for (const value of [true, false, true, false, true, false, true, false, true]) waits.push(service.setEnabled(value))
    await Promise.all(waits)
    await service.setEnabled(true)
    expect(service.status().exposure.kind).toBe('exposed')
    expect(Object.keys(h.serve().Web ?? {})).toEqual([`${DNS}:${PORT}`])
    expect(Object.keys(h.serve().TCP ?? {})).toEqual([String(PORT)])
    const target = `http://127.0.0.1:${service.status().serverPort}`
    expect(h.serve()).toEqual({ TCP: { [PORT]: { HTTPS: true } }, Web: { [`${DNS}:${PORT}`]: { Handlers: { '/': { Proxy: target } } } } })
    for (const value of [false, true, false, true, false]) waits.push(service.setEnabled(value))
    await Promise.all(waits)
    expect(h.serve()).toEqual({})
    expect(service.status().serverPort).toBeNull()
  })

  it('종료 중 tailscale 무응답이어도 마감 안에 돌아온다 (A6ⓕ)', async () => {
    const h = harness()
    useFake(h)
    const service = h.service()
    await service.start(true)
    h.setFake({ hang: ['serve-remove', 'serve-status', 'status'] })
    const started = Date.now()
    await service.shutdown(2000)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('추가가 실패하면 failed, 기록은 남지 않는다', async () => {
    const h = harness({ failAdd: true })
    useFake(h)
    const service = h.service()
    await service.start(true)
    expect(service.status().exposure.kind).toBe('failed')
    expect(service.ownerRecord()).toBeNull()
    expect(h.serve()).toEqual({})
  })
})

describe('점검표·거부 (A7)', () => {
  it('CLI 없음 → blocked(cli), serve 호출 0', async () => {
    const h = harness()
    useFake(h)
    const service = h.service({ cli: false })
    await service.start(true)
    expect(service.status().exposure).toMatchObject({ kind: 'blocked', reason: 'cli' })
    expect(service.status().checklist.cli.state).toBe('fail')
    expect(h.calls()).toEqual([])
  })

  it('로그아웃 → blocked(logged_out), serve 호출 0', async () => {
    const h = harness({ backendState: 'NeedsLogin' })
    useFake(h)
    const service = h.service()
    await service.start(true)
    expect(service.status().exposure).toMatchObject({ kind: 'blocked', reason: 'logged_out' })
    expect(service.status().checklist.loggedIn.state).toBe('fail')
    expect(serveCalls(h.calls())).toEqual([])
  })

  it('HTTPS 꺼짐 → blocked(https) + 안내, serve 쓰기 호출 0 (블록하는 CLI 를 부르지 않는다)', async () => {
    const h = harness({ certDomains: null })
    useFake(h)
    const service = h.service()
    const started = Date.now()
    await service.start(true)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(service.status().exposure).toMatchObject({ kind: 'blocked', reason: 'https' })
    expect(service.status().checklist.https).toMatchObject({ state: 'fail', detail: expect.stringContaining('HTTPS Certificates') })
    expect(serveCalls(h.calls())).toEqual([])
  })

  it.each([
    ['최상위 AllowFunnel', { AllowFunnel: { [`${DNS}:443`]: true } }],
    ['Foreground 안', { Foreground: { s1: { AllowFunnel: { [`${DNS}:443`]: true } } } }],
  ])('Funnel 켜짐(%s) → blocked(funnel), serve 쓰기 호출 0', async (_label, serve) => {
    const h = harness({ serve })
    useFake(h)
    const service = h.service()
    await service.start(true)
    expect(service.status().exposure).toMatchObject({ kind: 'blocked', reason: 'funnel' })
    expect(service.status().checklist.funnelOff.state).toBe('fail')
    expect(serveCalls(h.calls())).toEqual([])
  })

  it('CLI 무응답 → 타임아웃 뒤 blocked(unreadable), serve 쓰기 호출 0', async () => {
    const h = harness({ hang: ['status'] })
    useFake(h)
    const service = h.service()
    await service.start(true)
    expect(service.status().exposure).toMatchObject({ kind: 'blocked', reason: 'unreadable' })
    expect(serveCalls(h.calls())).toEqual([])
  }, 15_000)

  it('켜진 동안 Funnel 이 켜지면 재확인 주기에서 corral 항목을 내리고 경고 (A7ⓒ)', async () => {
    const h = harness()
    useFake(h)
    const service = h.service({ recheckMs: 200 })
    await service.start(true)
    expect(service.status().exposure.kind).toBe('exposed')
    h.setFake({ serve: { ...h.serve(), AllowFunnel: { [`${DNS}:443`]: true } } })
    const deadline = Date.now() + 5000
    while (service.status().exposure.kind !== 'blocked' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(service.status().exposure).toMatchObject({ kind: 'blocked', reason: 'funnel' })
    expect(service.status().warning).toContain('Funnel')
    expect(h.serve()).toEqual({ AllowFunnel: { [`${DNS}:443`]: true } })
  })

  it('꺼진 상태 「다시 확인」 은 읽기만 한다', async () => {
    const h = harness()
    useFake(h)
    const service = h.service()
    await service.start(false)
    await service.recheckNow()
    expect(service.status().checklist).toMatchObject({ cli: { state: 'ok' }, loggedIn: { state: 'ok' }, https: { state: 'ok' }, funnelOff: { state: 'ok' } })
    expect(serveCalls(h.calls())).toEqual([])
    expect(service.status().exposure.kind).toBe('off')
  })
})

describe('페어링 QR · push 비밀 (A4ⓐ·A3ⓓ)', () => {
  it('노출 전엔 QR 거절, 노출 뒤 QR = 주소 + 코드, push 에 코드 없음, 끝까지 pair→hello', async () => {
    const h = harness({ certDomains: null })
    useFake(h)
    const service = h.service()
    await service.start(true)
    expect(service.createPairing()).toMatchObject({ ok: false })
    h.setFake({ certDomains: [DNS] })
    await service.recheckNow()
    const pairing = service.createPairing()
    if (!pairing.ok) throw new Error(pairing.error)
    expect(JSON.parse(pairing.payload)).toEqual({ kind: 'corral-pair', v: 1, url: `wss://${DNS}:${PORT}/ws`, code: pairing.code })
    expect(pairing.qr.cells).toHaveLength(pairing.qr.size * pairing.qr.size)
    expect(pairing.qr.cells).toMatch(/^[01]+$/)
    expect(JSON.stringify(h.statuses)).not.toContain(pairing.code)
    expect(service.status().pairingExpiresAt).toBe(pairing.expiresAt)

    const ws = new WebSocket(`ws://127.0.0.1:${service.status().serverPort}/ws`)
    cleanups.push(() => ws.terminate())
    await new Promise((resolve) => ws.once('open', resolve))
    const reply = new Promise<Record<string, unknown>>((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))))
    ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code: pairing.code, name: 'p' }))
    const paired = await reply
    expect(paired.type).toBe('paired')
    expect(JSON.stringify(h.statuses)).not.toContain(String(paired.token))
    expect(service.status().devices).toMatchObject([{ name: 'p', connected: true }])
    expect(service.status().pairingExpiresAt).toBeNull()
  })

  it('끄면 페어링 코드도 폐기', async () => {
    const h = harness()
    useFake(h)
    const service = h.service()
    await service.start(true)
    expect(service.createPairing().ok).toBe(true)
    await service.setEnabled(false)
    expect(service.status().pairingExpiresAt).toBeNull()
  })
})
