// LIFE-577 리뷰 r3 회귀(R3-A1) — 자기 `/` 의 대상 교체(제거 → 재등록) 중 소유 문맥이 add 실패·재확인·서비스 재기동 너머로 남는다.
// 재현 모양은 리뷰 원자료 `raw/review/codex-r3-raw/probes.mts`(seedOwned · failAdd 1회)를 따랐다. 가짜 tailscale CLI + 실제 서버.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileService } from './service.js'
import { runTailscale } from './tailscale.js'

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/l577/fake-tailscale.mjs')
const DNS = 'fix3.example.ts.net'
const PORT = 8577
const KEY = `${DNS}:${PORT}`
const OLD_TARGET = 'http://127.0.0.1:12345'
const OTHER = { Proxy: 'http://127.0.0.1:9000' }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Json = Record<string, unknown>
const record = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {})

function setup(input: { other: boolean; owned: boolean }): { make: () => MobileService; get: () => Json; set: (patch: Json) => void; handlers: () => Json } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577g3-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const user = path.join(dir, 'user')
  const handlers: Json = { '/': { Proxy: OLD_TARGET }, ...(input.other ? { '/other': OTHER } : {}) }
  if (!input.owned) delete handlers['/']
  fs.writeFileSync(file, JSON.stringify({ backendState: 'Running', dnsName: DNS, certDomains: [DNS], serve: { TCP: { [PORT]: { HTTPS: true } }, Web: { [KEY]: { Handlers: handlers } } } }))
  if (input.owned) {
    // 비정상 종료 뒤 남은 소유권 기록 — 옛 서버 포트의 `/`
    fs.mkdirSync(path.join(user, 'mobile'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(user, 'mobile/serve-owner.json'), JSON.stringify({ host: DNS, httpsPort: PORT, target: OLD_TARGET }), { mode: 0o600 })
  }
  const get = (): Json => JSON.parse(fs.readFileSync(file, 'utf8'))
  const make = (): MobileService => {
    const s = new MobileService({ userData: user, appVersion: 'fix3', readMacName: async () => 'test-mac', log: () => {}, onStatus: () => {}, locate: async () => FAKE, run: (call) => { process.env.FAKE_TAILSCALE_DIR = dir; return runTailscale(call) }, recheckMs: 60_000 })
    cleanups.push(() => s.shutdown(3000))
    return s
  }
  return {
    make,
    get,
    set: (patch) => fs.writeFileSync(file, JSON.stringify({ ...get(), ...patch })),
    handlers: () => record(record(record(record(get().serve).Web)[KEY]).Handlers),
  }
}

describe('R3-A1 — 자기 `/` 대상 교체 중 소유 문맥 보존', () => {
  it('① `/other` 공존 + 교체 add 1회 실패 → 다음 재확인에서 exposed, `/other` 보존', async () => {
    const h = setup({ other: true, owned: true })
    h.set({ failAdd: true })
    const s = h.make()
    await s.start(true)
    expect(s.status().exposure.kind).toBe('failed')
    expect(h.handlers()['/other']).toEqual(OTHER)
    h.set({ failAdd: false })
    await s.recheckNow()
    expect(s.status().exposure.kind).toBe('exposed')
    expect(h.handlers()['/other']).toEqual(OTHER)
    expect(record(h.handlers()['/']).Proxy).toBe(`http://127.0.0.1:${s.status().serverPort}`)
    expect(s.ownerRecord()?.target).toBe(`http://127.0.0.1:${s.status().serverPort}`)
  })

  it('② 같은 조건에서 실패 뒤 서비스 재기동 → 복구(exposed, `/other` 보존)', async () => {
    const h = setup({ other: true, owned: true })
    h.set({ failAdd: true })
    const first = h.make()
    await first.start(true)
    expect(first.status().exposure.kind).toBe('failed')
    await first.shutdown(3000)
    h.set({ failAdd: false })
    const resumed = h.make()
    await resumed.start(true)
    expect(resumed.status().exposure.kind).toBe('exposed')
    expect(h.handlers()['/other']).toEqual(OTHER)
  })

  it('③ 기록 없음 + `/other` → 여전히 foreign(R2-A3 유지)', async () => {
    const h = setup({ other: true, owned: false })
    const s = h.make()
    await s.start(true)
    expect(s.status().exposure.kind).toBe('foreign')
    expect(s.ownerRecord()).toBeNull()
    expect(h.handlers()).toEqual({ '/other': OTHER })
  })

  it('④ 대조: 실패 없는 교체는 바로 exposed · `/other` 없이 add 1회 실패는 재확인에서 복구', async () => {
    const normal = setup({ other: true, owned: true })
    const a = normal.make()
    await a.start(true)
    expect(a.status().exposure.kind).toBe('exposed')
    expect(normal.handlers()['/other']).toEqual(OTHER)

    const alone = setup({ other: false, owned: true })
    alone.set({ failAdd: true })
    const b = alone.make()
    await b.start(true)
    expect(b.status().exposure.kind).toBe('failed')
    alone.set({ failAdd: false })
    await b.recheckNow()
    expect(b.status().exposure.kind).toBe('exposed')
  })

  it('⑤ 교체 중 실패한 뒤 사용자가 끄면 자리를 놓는다 — 기록 없음, 다시 켜면 최초 등록 규칙(`/other` 있으면 foreign)', async () => {
    const h = setup({ other: true, owned: true })
    h.set({ failAdd: true })
    const s = h.make()
    await s.start(true)
    expect(s.status().exposure.kind).toBe('failed')
    h.set({ failAdd: false })
    await s.setEnabled(false)
    expect(s.status().exposure.kind).toBe('off')
    expect(s.ownerRecord()).toBeNull()
    await s.setEnabled(true)
    expect(s.status().exposure.kind).toBe('foreign')
    expect(h.handlers()).toEqual({ '/other': OTHER })
  })
})
