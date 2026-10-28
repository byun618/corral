// LIFE-577 리뷰 r3·r4 회귀 — 수정 r4(단순화) 정책: 전용 포트 `<host>:8577` 에 corral 의 `/` 외 다른 무엇이 있으면
// corral 은 자기 `/`(기록과 host·target 이 일치하는 Proxy)를 **지울 수는 있지만 다시 올리지 않는다**(foreign · 쓰기 0).
// 남의 것이 **모두** 치워진 뒤 재확인에서 빈 포트 최초 등록으로 올라간다. 대상 교체(크래시 뒤 새 서버 포트)도 같다.
// 시나리오는 리뷰 원자료 `raw/review/codex-r3-raw/probes.mts` · `codex-r4-raw/probes.mts` 를 새 정책 기대값으로 옮겼다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileService } from './service.js'
import { runTailscale, type TailscaleRunner } from './tailscale.js'

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/mobile-repro/fake-tailscale.mjs')
const DNS = 'fix3.example.ts.net'
const PORT = 8577
const KEY = `${DNS}:${PORT}`
const OLD_TARGET = 'http://127.0.0.1:12345'
const OTHER = { Proxy: 'http://127.0.0.1:9000' }
const FOREIGN_HINT = '치우면'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Json = Record<string, unknown>
const record = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {})

type Harness = {
  make: () => MobileService
  get: () => Json
  set: (patch: Json) => void
  handlers: () => Json
  setHandler: (input: { route: string; value: Json | null }) => void
  writes: string[][]
}

/** owned — 비정상 종료 뒤 남은 소유권 기록 + 옛 서버 포트를 향한 자기 `/`. failPostRemoveRead — 성공한 off 직후 조회 한 번만 실패(R4-A1). */
function setup(input: { other: boolean; owned: boolean; failPostRemoveRead?: boolean }): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577g3-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const user = path.join(dir, 'user')
  const handlers: Json = { ...(input.owned ? { '/': { Proxy: OLD_TARGET } } : {}), ...(input.other ? { '/other': OTHER } : {}) }
  const serve = Object.keys(handlers).length === 0 ? {} : { TCP: { [PORT]: { HTTPS: true } }, Web: { [KEY]: { Handlers: handlers } } }
  fs.writeFileSync(file, JSON.stringify({ backendState: 'Running', dnsName: DNS, certDomains: [DNS], serve }))
  if (input.owned) {
    fs.mkdirSync(path.join(user, 'mobile'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(user, 'mobile/serve-owner.json'), JSON.stringify({ host: DNS, httpsPort: PORT, target: OLD_TARGET }), { mode: 0o600 })
  }
  const get = (): Json => JSON.parse(fs.readFileSync(file, 'utf8'))
  const set = (patch: Json): void => fs.writeFileSync(file, JSON.stringify({ ...get(), ...patch }))
  const writes: string[][] = []
  let failNextRead = false
  let injected = false
  const run: TailscaleRunner = async (call) => {
    process.env.FAKE_TAILSCALE_DIR = dir
    if (failNextRead && call.args[0] === 'serve' && call.args[1] === 'status') {
      failNextRead = false
      return { ok: false, reason: 'exit', detail: 'post-remove read failed once (injected)' }
    }
    if (call.args[0] === 'serve' && call.args[1] !== 'status') writes.push([...call.args])
    const out = await runTailscale(call)
    if (input.failPostRemoveRead === true && !injected && call.args.at(-1) === 'off' && out.ok) {
      injected = true
      failNextRead = true
    }
    return out
  }
  const make = (): MobileService => {
    const s = new MobileService({ userData: user, appVersion: 'fix3', readMacName: async () => 'test-mac', log: () => {}, onStatus: () => {}, locate: async () => FAKE, run, recheckMs: 60_000 })
    cleanups.push(() => s.shutdown(3000))
    return s
  }
  const handlersOf = (): Json => record(record(record(record(get().serve).Web)[KEY]).Handlers)
  const setHandler = (change: { route: string; value: Json | null }): void => {
    const next = handlersOf()
    if (change.value === null) delete next[change.route]
    else next[change.route] = change.value
    set({ serve: Object.keys(next).length === 0 ? {} : { TCP: { [PORT]: { HTTPS: true } }, Web: { [KEY]: { Handlers: next } } } })
  }
  return { make, get, set, handlers: handlersOf, setHandler, writes }
}

const adds = (writes: string[][]): string[][] => writes.filter((args) => args.at(-1) !== 'off')

describe('수정 r4 정책 — 남의 것이 있는 8577 에는 다시 올리지 않는다', () => {
  it('공존 + 대상 교체 → 자기 `/` 만 내리고 foreign(쓰기 = off 1회, add 0), `/other` 보존 · 기록 없음 → `/other` 를 치우면 재확인에서 빈 포트 등록', async () => {
    const h = setup({ other: true, owned: true })
    const s = h.make()
    await s.start(true)
    expect(s.status().exposure.kind).toBe('foreign')
    expect(JSON.stringify(s.status().exposure)).toContain(FOREIGN_HINT)
    expect(h.handlers()).toEqual({ '/other': OTHER })
    expect(s.ownerRecord()).toBeNull()
    expect(h.writes.filter((args) => args.at(-1) === 'off')).toHaveLength(1)
    expect(adds(h.writes)).toEqual([])
    await s.recheckNow()
    expect(s.status().exposure.kind).toBe('foreign')
    expect(adds(h.writes)).toEqual([])
    h.setHandler({ route: '/other', value: null })
    await s.recheckNow()
    expect(s.status().exposure.kind).toBe('exposed')
    expect(record(h.handlers()['/']).Proxy).toBe(`http://127.0.0.1:${s.status().serverPort}`)
  })

  it('R4-A1 off 성공 직후 조회 1회 실패 → failed(「설정에 남음」 단정 없음) → 재확인 foreign·기록 없음 → 재기동 foreign → `/other` 치우면 exposed', async () => {
    const h = setup({ other: true, owned: true, failPostRemoveRead: true })
    const s = h.make()
    await s.start(true)
    expect(s.status().exposure.kind).toBe('failed')
    expect(JSON.stringify(s.status().exposure)).not.toContain('설정에 남음')
    expect(h.handlers()).toEqual({ '/other': OTHER })
    await s.recheckNow()
    expect(s.status().exposure.kind).toBe('foreign')
    expect(s.ownerRecord()).toBeNull()
    await s.shutdown(3000)
    const resumed = h.make()
    await resumed.start(true)
    expect(resumed.status().exposure.kind).toBe('foreign')
    expect(adds(h.writes)).toEqual([])
    h.setHandler({ route: '/other', value: null })
    await resumed.recheckNow()
    expect(resumed.status().exposure.kind).toBe('exposed')
  })

  it('R4-A1 대조 — 같은 조회 실패라도 `/other` 가 없으면 재확인에서 빈 포트 등록', async () => {
    const h = setup({ other: false, owned: true, failPostRemoveRead: true })
    const s = h.make()
    await s.start(true)
    await s.recheckNow()
    expect(s.status().exposure.kind).toBe('exposed')
  })

  it.each([
    ['text', { Text: 'hello' }],
    ['path', { Path: '/tmp/site' }],
    ['proxy', { Proxy: 'http://127.0.0.1:7000' }],
  ])('R4-A2 남의 `/`(%s) 가 생겨도 foreign·쓰기 0 — 그 `/` 를 치워도 `/other` 가 남으면 계속 foreign, 모두 치우면 exposed', async (_kind, value) => {
    const h = setup({ other: true, owned: true })
    const s = h.make()
    await s.start(true)
    expect(s.status().exposure.kind).toBe('foreign')
    const writesBefore = h.writes.length
    h.setHandler({ route: '/', value })
    await s.recheckNow()
    expect(s.status().exposure.kind).toBe('foreign')
    expect(h.writes).toHaveLength(writesBefore)
    expect(s.ownerRecord()).toBeNull()
    h.setHandler({ route: '/', value: null })
    await s.recheckNow()
    expect(s.status().exposure.kind).toBe('foreign')
    expect(h.writes).toHaveLength(writesBefore)
    expect(h.handlers()['/other']).toEqual(OTHER)
    h.setHandler({ route: '/other', value: null })
    await s.recheckNow()
    expect(s.status().exposure.kind).toBe('exposed')
  })

  it('기록 없음 + `/other` → foreign(R2-A3)', async () => {
    const h = setup({ other: true, owned: false })
    const s = h.make()
    await s.start(true)
    expect(s.status().exposure.kind).toBe('foreign')
    expect(s.ownerRecord()).toBeNull()
    expect(h.writes).toEqual([])
    expect(h.handlers()).toEqual({ '/other': OTHER })
  })

  it('대조 — `/other` 없는 대상 교체는 바로 exposed · add 1회 실패는 재확인에서 복구', async () => {
    const normal = setup({ other: false, owned: true })
    const a = normal.make()
    await a.start(true)
    expect(a.status().exposure.kind).toBe('exposed')

    const flaky = setup({ other: false, owned: true })
    flaky.set({ failAdd: true })
    const b = flaky.make()
    await b.start(true)
    expect(b.status().exposure.kind).toBe('failed')
    flaky.set({ failAdd: false })
    await b.recheckNow()
    expect(b.status().exposure.kind).toBe('exposed')
  })
})
