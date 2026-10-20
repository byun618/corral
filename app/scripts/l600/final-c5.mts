// LIFE-600 최종 관문 C5 — 오류 다섯 갈래 묶음(양성 대조). app/ 에서:
//   node --import tsx scripts/l600/final-c5.mts
// 분기마다 그 조건을 만들고 분류값(kind·status·연결 상태)을 한 줄 JSON 으로 낸다. 실제 LA·사용자 키체인 무접촉 —
// 모의 LA MCP 서버(127.0.0.1) · 가짜 cipher(FakeCipher) · 모의 Jira 형 출처. DNS 는 외부 조회 없이 fetch 주입(ENOTFOUND 예외)으로 만든다.
// 토큰은 테스트 가짜(`life_pat_fixture…`)뿐이고 출력에는 싣지 않는다. 종료 코드: 0 = 모든 분기가 기대 분류 · 1 = 하나라도 어긋남.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { FIXTURE_IDS, FIXTURE_STATUS } from '../../src/main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../src/main/work/la-source.js'
import { FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN, FAKE_MOCK_TOKEN, laFixtureHarness, mockHarness, workHarness } from '../../src/main/work/test-kit.js'

type Row = { branch: string; case: string; kind: string | null; status: number | null; connection: string | null; expect: string; pass: boolean; extra?: Record<string, unknown> }
const rows: Row[] = []
const record = (row: Omit<Row, 'pass'>): void => {
  const pass = row.kind === row.expect
  rows.push({ ...row, pass })
  console.log(JSON.stringify({ ...row, pass }))
}
const connectionStatus = (h: { service: { settings(): { connections: { status: string }[] } } }): string | null => h.service.settings().connections[0]?.status ?? null

// ── 보내기 전 거절 — life_pat_ 아닌 토큰
{
  const h = await laFixtureHarness()
  const result = await h.service.addConnection({ sourceId: 'la', token: 'garbage-token-0000', replaceId: null })
  record({ branch: '전송 전 거절', case: 'life_pat_ 아닌 토큰', kind: result.ok ? null : result.error.kind, status: null, connection: null, expect: 'invalid_request', extra: { serverRequests: h.fixture.requests.length, stored: h.store.data.connections.length } })
  if (h.fixture.requests.length !== 0) rows.push({ branch: '전송 전 거절', case: '서버 요청 0', kind: String(h.fixture.requests.length), status: null, connection: null, expect: '0', pass: false })
  await h.fixture.stop()
}

// ── auth — 401
{
  const h = await laFixtureHarness()
  const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('add')
  h.fixture.tokens.delete(FAKE_LA_TOKEN)
  const result = await h.service.testConnection({ connectionId: added.connection.id })
  record({ branch: 'auth', case: '폐기된 토큰 → HTTP 401', kind: result.ok ? null : result.error.kind, status: result.ok ? null : result.error.status, connection: connectionStatus(h), expect: 'auth' })
  const sent = h.fixture.requests.length
  const ordinary = await h.service.request({ requestId: 'o', connectionId: added.connection.id, call: { op: 'listStatuses', spaceKey: FIXTURE_IDS.corral } })
  record({ branch: 'auth', case: '인증 실패 뒤 일반 요청 — 보내지 않음(자격 무효)', kind: ordinary.ok ? null : ordinary.error.kind, status: null, connection: connectionStatus(h), expect: 'auth', extra: { additionalServerRequests: h.fixture.requests.length - sent } })
  await h.fixture.stop()
}

// ── forbidden — LA SDK 꼴(200 · isError · missing scope) · HTTP 403
for (const style of ['sdk', 'http'] as const) {
  const h = await laFixtureHarness()
  h.fixture.scopeStyle = style
  const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_READ_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('add read')
  const result = await h.service.request({ requestId: 'w', connectionId: added.connection.id, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: null } })
  record({ branch: 'forbidden', case: style === 'sdk' ? 'issue:read 토큰으로 쓰기 — LA SDK 꼴 200 + isError `missing scope: issue:write`' : 'issue:read 토큰으로 쓰기 — HTTP 403', kind: result.ok ? null : result.error.kind, status: result.ok ? null : result.error.status, connection: connectionStatus(h), expect: 'forbidden' })
  await h.fixture.stop()
}

// ── network — 5xx(500 ≠ auth) · 소켓 끊김 · 시간 초과 · 연결 거부 · DNS
{
  const h = await laFixtureHarness({ timeoutMs: 300 })
  const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('add')
  const faults = [
    { case: 'HTTP 500 INTERNAL_ERROR (인증 실패로 읽지 않는다)', fault: { kind: 'http' as const, status: 500, body: '{"code":"INTERNAL_ERROR"}' } },
    { case: '소켓 끊김', fault: { kind: 'drop' as const } },
    { case: '시간 초과(응답 지연 > 300ms)', fault: { kind: 'delay' as const, ms: 1000 } },
  ]
  for (const entry of faults) {
    h.fixture.fault = entry.fault
    const result = await h.service.testConnection({ connectionId: added.connection.id })
    record({ branch: 'network', case: entry.case, kind: result.ok ? null : result.error.kind, status: result.ok ? null : result.error.status, connection: connectionStatus(h), expect: 'network' })
  }
  h.fixture.fault = null
  await h.fixture.stop()
}
{
  // 연결 거부 — 닫힌 포트.
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = probe.address()
  if (address === null || typeof address === 'string') throw new Error('address')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const h = workHarness({ entries: [laSourceEntry({ url: `http://127.0.0.1:${address.port}/mcp`, clientVersion: 'final-c5', timeoutMs: 2000 })] })
  const result = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  record({ branch: 'network', case: '연결 거부(닫힌 포트)', kind: result.ok ? null : result.error.kind, status: result.ok ? null : result.error.status, connection: null, expect: 'network', extra: { message: result.ok ? null : result.error.message } })
}
{
  // DNS — 외부 조회 없이 fetch 가 ENOTFOUND 를 던지게 주입.
  const dnsFailure: typeof fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }) }
  const h = workHarness({ entries: [laSourceEntry({ url: 'http://la.invalid/mcp', clientVersion: 'final-c5', fetchImpl: dnsFailure })] })
  const result = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  record({ branch: 'network', case: 'DNS(ENOTFOUND 주입)', kind: result.ok ? null : result.error.kind, status: null, connection: null, expect: 'network', extra: { message: result.ok ? null : result.error.message } })
}

// ── keychain — 가용 아님 · 거부(싸기) · 거부(풀기) · 복호화 실패(빈 결과)
for (const mode of ['unavailable', 'deny-encrypt'] as const) {
  const h = await laFixtureHarness()
  h.cipher.mode = mode
  const result = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  record({ branch: 'keychain', case: mode === 'unavailable' ? '저장 — 암호화 가용 아님' : '저장 — 키체인 거부', kind: result.ok ? null : result.error.kind, status: null, connection: null, expect: 'keychain', extra: { stored: h.store.data.connections.length } })
  await h.fixture.stop()
}
for (const variant of ['deny-decrypt', 'unavailable', 'empty'] as const) {
  const first = await laFixtureHarness()
  const added = await first.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('add')
  const next = workHarness({ entries: [laSourceEntry({ url: first.url, clientVersion: 'final-c5' })] })
  next.store.data = structuredClone(first.store.data)
  const sealedBefore = next.store.data.connections[0]?.sealed
  if (variant === 'empty') next.cipher.decrypt = async () => ''
  else next.cipher.mode = variant
  const result = await next.service.testConnection({ connectionId: added.connection.id })
  const label = variant === 'deny-decrypt' ? '재시작 뒤 풀기 — 키체인 거부' : variant === 'unavailable' ? '재시작 뒤 풀기 — 가용 아님' : '재시작 뒤 풀기 — 복호화 실패(빈 결과)'
  record({ branch: 'keychain', case: label, kind: result.ok ? null : result.error.kind, status: null, connection: connectionStatus(next), expect: 'keychain', extra: { sealedKept: next.store.data.connections[0]?.sealed === sealedBefore } })
  await first.fixture.stop()
}

// ── conflict — 모의 Jira 형(조건부 수정 켜짐)
{
  const h = mockHarness()
  const added = await h.service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('add mock')
  const id = added.connection.id
  const got = await h.service.request({ requestId: 'g', connectionId: id, call: { op: 'getItem', itemId: 'm-2' } })
  if (!got.ok || got.result.op !== 'getItem') throw new Error('get mock')
  const version = got.result.item.version
  const moved = await h.service.request({ requestId: 'p1', connectionId: id, call: { op: 'setPlacement', itemId: 'm-2', placement: 'backlog', ifVersion: version } })
  const stale = await h.service.request({ requestId: 'p2', connectionId: id, call: { op: 'setPlacement', itemId: 'm-2', placement: 'board', ifVersion: version } })
  record({ branch: 'conflict', case: '낡은 판(ifVersion)으로 수정 — 모의 Jira 형', kind: stale.ok ? null : stale.error.kind, status: null, connection: connectionStatus(h), expect: 'conflict', extra: { firstWriteOk: moved.ok } })
}

const passed = rows.filter((row) => row.pass).length
console.log(`# C5 결과 ${passed}/${rows.length}`)
process.exit(passed === rows.length ? 0 : 1)
