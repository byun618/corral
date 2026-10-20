// LIFE-600 수정 r4 — 리뷰 r4(Codex) 지적의 재현(raw/review/codex-r4-raw/state-probes.mts)을 회귀 테스트로 옮긴 것. [R4-x] 는 지적 ID,
// [Tn] 은 notes.md §11 연결 상태 전이 표의 칸이다(r4 에서 T7a·T5a 를 더했다). 토큰은 가짜 `life_pat_` 뿐이다.
import { afterEach, describe, expect, it } from 'vitest'
import { isRecord, safeParse } from '../../shared/json.js'
import type { FixtureFault } from './la-mcp-fixture.js'
import { FIXTURE_IDS } from './la-mcp-fixture.js'
import { laSourceEntry } from './la-source.js'
import { FAKE_LA_TOKEN, laFixtureHarness, workHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('until: 시간 초과')
}

function toolName(init: RequestInit | undefined): string | null {
  const body = typeof init?.body === 'string' ? safeParse(init.body) : null
  const params = isRecord(body) && isRecord(body.params) ? body.params : {}
  return typeof params.name === 'string' ? params.name : null
}

async function rejectedConnection() {
  const h = await laFixtureHarness({ timeoutMs: 300 })
  stops.push(() => h.fixture.stop())
  const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('add')
  const id = added.connection.id
  h.fixture.tokens.delete(FAKE_LA_TOKEN)
  expect(await h.service.testConnection({ connectionId: id })).toMatchObject({ ok: false, error: { kind: 'auth' } })
  return { ...h, id }
}

describe('[R4-A] 자격 무효는 성공한 재검증·교체 성공만 거둔다', () => {
  const faults: { name: string; fault: FixtureFault; kind: 'network' | 'forbidden'; status: string }[] = [
    { name: 'HTTP 500', fault: { kind: 'http', status: 500, body: '{}' }, kind: 'network', status: 'offline' },
    { name: '소켓 단절', fault: { kind: 'drop' }, kind: 'network', status: 'offline' },
    { name: 'HTTP 403', fault: { kind: 'http', status: 403, body: '{}' }, kind: 'forbidden', status: 'forbidden' },
  ]
  for (const { name, fault, kind, status } of faults) {
    it(`[T7a] auth-failed-explicit-retry-allows-ordinary-request (${name}) — 재시험 실패는 장애를 보이되 일반 요청 차단은 그대로`, async () => {
      const h = await rejectedConnection()
      h.fixture.fault = fault
      expect(await h.service.testConnection({ connectionId: h.id })).toMatchObject({ ok: false, error: { kind } })
      expect(h.service.settings().connections[0]?.status).toBe(status)
      h.fixture.fault = null
      const sent = h.fixture.requests.length
      const ordinary = await h.service.request({ requestId: 'ordinary', connectionId: h.id, call: { op: 'listStatuses', spaceKey: FIXTURE_IDS.corral } })
      expect(ordinary).toMatchObject({ ok: false, error: { kind: 'auth' } })
      expect(h.fixture.requests.length).toBe(sent)
    })
  }

  it('[T4] 그 뒤 누른 테스트가 성공하면(자격이 되살아난 경우) 차단이 풀린다', async () => {
    const h = await rejectedConnection()
    h.fixture.fault = { kind: 'http', status: 500, body: '{}' }
    await h.service.testConnection({ connectionId: h.id })
    h.fixture.fault = null
    h.fixture.tokens.set(FAKE_LA_TOKEN, 'write')
    expect(await h.service.testConnection({ connectionId: h.id })).toEqual({ ok: true })
    const sent = h.fixture.requests.length
    expect((await h.service.request({ requestId: 'ordinary', connectionId: h.id, call: { op: 'listStatuses', spaceKey: FIXTURE_IDS.corral } })).ok).toBe(true)
    expect(h.fixture.requests.length).toBeGreaterThan(sent)
  })

  it('[T12] 토큰 교체 성공도 차단을 거둔다(새 세대)', async () => {
    const h = await rejectedConnection()
    h.fixture.tokens.set('life_pat_fixturenew00000000000000000000000000000000', 'write')
    expect((await h.service.addConnection({ sourceId: 'la', token: 'life_pat_fixturenew00000000000000000000000000000000', replaceId: h.id })).ok).toBe(true)
    expect((await h.service.request({ requestId: 'ordinary', connectionId: h.id, call: { op: 'listStatuses', spaceKey: FIXTURE_IDS.corral } })).ok).toBe(true)
  })
})

describe('[R4-C] 상태 순번과 데이터(스페이스 목록) 순번은 따로', () => {
  async function restartedWithHeldList() {
    const harness = await laFixtureHarness()
    stops.push(() => harness.fixture.stop())
    const hold = deferred()
    let active = false
    let held = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const name = toolName(init)
      const response = await fetch(input, init)
      if (active && name === 'issue_list') { held += 1; await hold.promise }
      return response
    }
    const entry = laSourceEntry({ url: harness.url, clientVersion: 'test', fetchImpl })
    const first = workHarness({ entries: [entry] })
    const added = await first.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    // 재시작 — 같은 저장 내용, 새 금고·새 서비스(스페이스 목록 없음).
    const h = workHarness({ entries: [entry] })
    h.store.data = structuredClone(first.store.data)
    active = true
    return { h, fixture: harness.fixture, id: added.connection.id, hold, held: () => held }
  }

  it('[T5a] successful-first-test-loses-spaces-to-unrelated-result — 후행 비목록 성공(listStatuses)이 먼저 시작한 목록 성공을 버리지 않는다', async () => {
    const { h, id, hold, held } = await restartedWithHeldList()
    const test = h.service.testConnection({ connectionId: id })
    await until(() => held() === 5)
    expect((await h.service.request({ requestId: 'newer', connectionId: id, call: { op: 'listStatuses', spaceKey: FIXTURE_IDS.corral } })).ok).toBe(true)
    hold.resolve()
    expect(await test).toEqual({ ok: true })
    const summary = h.service.settings().connections[0]
    expect(summary?.status).toBe('ok')
    expect(summary?.spaces?.map((space) => space.key)).toContain(FIXTURE_IDS.corral)
  })

  it('[T5a·T6] auth 이전에 시작한 목록 성공은 auth 뒤에 와도 받지 않는다(낡은 데이터 차단 유지)', async () => {
    const { h, fixture, id, hold, held } = await restartedWithHeldList()
    const test = h.service.testConnection({ connectionId: id })
    await until(() => held() === 5)
    fixture.tokens.delete(FAKE_LA_TOKEN)
    expect(await h.service.request({ requestId: 'revoked', connectionId: id, call: { op: 'getItem', itemId: FIXTURE_IDS.task601 } })).toMatchObject({ ok: false, error: { kind: 'auth' } })
    hold.resolve()
    await test
    const summary = h.service.settings().connections[0]
    expect(summary?.status).toBe('auth')
    expect(summary?.spaces).toBeNull()
  })
})
