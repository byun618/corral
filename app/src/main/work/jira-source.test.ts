// LIFE-605 — Jira Cloud 출처 단위·fixture 시험(계약 묶음 밖의 Jira 사정). 기준 C1·C2·C4–C11 의 「빠른」 칸.
// 자격은 가짜만(`test-kit.ts`). 요청 수·본문은 fixture 의 `requests`(자격 없음)로 본다.
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spaceCapabilities, type WorkCall, type WorkCapabilities, type WorkResponse } from '../../shared/work.js'
import { basicHeader, errorText, JiraHttp, parseRetryAfter } from './jira-http.js'
import { JiraRestFixture } from './jira-rest-fixture.js'
import { bodyUpdate, checkJiraAccount, jiraFixtureBaseFromEnv, jiraSourceEntry, jqlString, normalizeJiraSite, splitOrderBy, textSearchWords, transitionPlan } from './jira-source.js'
import { readTransitions } from './jira-shape.js'
import { markdownToAdf } from './adf.js'
import { FAKE_JIRA_EMAIL, FAKE_JIRA_TOKEN, JIRA_ACCOUNT, jiraFixtureHarness, workHarness } from './test-kit.js'
import type { WorkSourceEntry } from './source.js'

type Harness = Awaited<ReturnType<typeof jiraFixtureHarness>>
const opened: Harness[] = []

async function connected(options: Parameters<typeof jiraFixtureHarness>[0] = {}): Promise<Harness & { connectionId: string; send: (call: WorkCall) => Promise<WorkResponse> }> {
  const harness = await jiraFixtureHarness(options)
  opened.push(harness)
  const added = await harness.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
  if (!added.ok) throw new Error(`연결 실패: ${added.error.message}`)
  let n = 0
  const connectionId = added.connection.id
  return { ...harness, connectionId, send: (call) => harness.service.request({ requestId: `t-${++n}`, connectionId, call }) }
}

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.fixture.stop()
  vi.restoreAllMocks()
})

const BASIC_VALUE = basicHeader({ email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN }).slice('Basic '.length)

describe('C1 사이트·자격', () => {
  it('사이트 정규화 — 이름만·스킴 없음·끝 /·브라우저 주소 경로·대문자는 받고 호스트로', () => {
    for (const input of ['acme', 'acme.atlassian.net', 'https://acme.atlassian.net/', 'https://ACME.atlassian.net/jira/software/projects/X/boards/1?a=1#f', 'http://acme.atlassian.net', '  acme.atlassian.net  ']) {
      expect(normalizeJiraSite(input), input).toEqual({ ok: true, host: 'acme.atlassian.net' })
    }
  })

  it('사이트 거절 — atlassian.net 밖(사용자 지정 도메인)·겹 하위 도메인·포트·사용자 정보·다른 스킴·꼬리 붙인 호스트', () => {
    for (const input of ['jira.acme.com', 'acme.atlassian.net.evil.com', 'a.b.atlassian.net', 'atlassian.net', 'https://acme.atlassian.net:8443', 'https://user@acme.atlassian.net', 'ftp://acme.atlassian.net', 'http://127.0.0.1:9', '', 'acme .atlassian.net']) {
      expect(normalizeJiraSite(input).ok, input).toBe(false)
    }
  })

  it('이메일 모양 · 거절 문구에 입력값이 없다', () => {
    const bad = checkJiraAccount({ site: 'acme', email: 'not-an-email-secret' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).not.toContain('not-an-email-secret')
    expect(checkJiraAccount({ site: 'acme', email: ' Dev@Acme.com ' })).toEqual({ ok: true, account: { site: 'acme.atlassian.net', email: 'Dev@Acme.com' } })
  })

  it('그 밖 호스트는 네트워크 전에 거절 — fixture 요청 0, 저장 0 (양성 대조: 맞는 사이트면 요청이 간다)', async () => {
    const harness = await jiraFixtureHarness()
    opened.push(harness)
    const refused = await harness.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: { site: 'jira.acme.com', email: FAKE_JIRA_EMAIL }, replaceId: null })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    expect(harness.fixture.requests).toHaveLength(0)
    expect(harness.store.writes).toBe(0)
    const accepted = await harness.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
    expect(accepted.ok).toBe(true)
    expect(harness.fixture.requests.length).toBeGreaterThan(0)
  })

  it('측정 전용 fixture 주소는 제어 소켓이 있는 격리 실행 + 127.0.0.1 http 일 때만 열린다', () => {
    expect(jiraFixtureBaseFromEnv({})).toBeNull()
    expect(jiraFixtureBaseFromEnv({ CORRAL_JIRA_FIXTURE_URL: 'http://127.0.0.1:4100' })).toBeNull()
    expect(jiraFixtureBaseFromEnv({ CORRAL_CONTROL_SOCKET: '/tmp/x.sock', CORRAL_JIRA_FIXTURE_URL: 'https://127.0.0.1:4100' })).toBeNull()
    expect(jiraFixtureBaseFromEnv({ CORRAL_CONTROL_SOCKET: '/tmp/x.sock', CORRAL_JIRA_FIXTURE_URL: 'http://evil.example:4100' })).toBeNull()
    expect(jiraFixtureBaseFromEnv({ CORRAL_CONTROL_SOCKET: '/tmp/x.sock', CORRAL_JIRA_FIXTURE_URL: 'http://127.0.0.1:4100' })).toBe('http://127.0.0.1:4100')
  })

  it('연결 테스트 = myself + 스페이스 목록 통과 뒤에만 저장 — 401 이면 저장 0', async () => {
    const harness = await jiraFixtureHarness()
    opened.push(harness)
    const refused = await harness.service.addConnection({ sourceId: 'jira', token: 'ATATTwrong000000', account: JIRA_ACCOUNT, replaceId: null })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(harness.store.writes).toBe(0)
    expect(harness.fixture.requests[0]?.path).toBe('/rest/api/3/myself')
  })

  it('카드 요약 — 사이트 호스트·이메일·토큰 끝 4자, 토큰·Basic 값 없음 · 저장 바이트·IPC 응답·로그에도 없다(양성 대조: 심은 값은 잡힌다)', async () => {
    const lines: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    })
    const h = await connected()
    const summary = h.service.settings().connections[0]
    expect(summary).toMatchObject({ sourceId: 'jira', account: { site: 'fixture.atlassian.net', email: FAKE_JIRA_EMAIL }, tokenTail: FAKE_JIRA_TOKEN.slice(-4) })
    // 401 을 일부러 — 오류 문구·로그에 자격이 실리지 않는다.
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/statuses'), status: 401, once: true })
    const failed = await h.send({ op: 'listStatuses', spaceKey: 'CORE' })
    const surfaces = [JSON.stringify(h.service.settings()), JSON.stringify(h.store.data.connections.map((row) => ({ ...row, sealed: null }))), JSON.stringify(failed), JSON.stringify(h.emitted), lines.join('')]
    const leaks = (text: string) => [FAKE_JIRA_TOKEN, BASIC_VALUE, `${FAKE_JIRA_EMAIL}:${FAKE_JIRA_TOKEN}`].filter((secret) => text.includes(secret))
    for (const surface of surfaces) expect(leaks(surface)).toEqual([])
    // 이메일은 카드(설정 상태)에만 — 오류 문구·로그에는 없다.
    expect(JSON.stringify(failed)).not.toContain(FAKE_JIRA_EMAIL)
    expect(lines.join('')).not.toContain(FAKE_JIRA_EMAIL)
    // 암호문은 평문 토큰·이메일을 그대로 담지 않는다(가짜 cipher 도 바이트를 섞는다).
    expect(h.store.data.connections[0]?.sealed).not.toContain(FAKE_JIRA_TOKEN)
    // 양성 대조 — 같은 검사가 심은 값을 잡는다.
    expect(leaks(`x ${FAKE_JIRA_TOKEN} y`)).toEqual([FAKE_JIRA_TOKEN])
    expect(leaks(`Authorization: Basic ${BASIC_VALUE}`)).toEqual([BASIC_VALUE])
  })

  it('R1-B 출처가 자격을 되울려도 지운다 — 추가(연결 테스트) 경로 · 재시작(봉인 JSON 복원) 경로 둘 다: 맨 토큰·URL 인코딩 토큰·Basic 값·이메일:토큰·이메일', async () => {
    const leakToken = 'ATATT+leak/=00000000000000000000'
    const leaky = (base: WorkSourceEntry, state: { leak: boolean }): WorkSourceEntry => ({
      ...base,
      create: (credentials) => {
        const real = base.create(credentials)
        const basic = Buffer.from(`${credentials.account.email ?? ''}:${credentials.token}`, 'utf8').toString('base64')
        const message = `echo ${credentials.token} ${encodeURIComponent(credentials.token)} Basic ${basic} ${credentials.account.email}:${credentials.token} ${credentials.account.email}`
        return { capabilities: () => real.capabilities(), close: () => real.close(), call: async (call, meta) => (state.leak ? { ok: false, error: { kind: 'invalid_response', message, status: null } } : real.call(call, meta)) }
      },
    })
    const fixture = new JiraRestFixture()
    fixture.allow({ email: FAKE_JIRA_EMAIL, token: leakToken })
    const url = await fixture.start()
    try {
      const secretsIn = (text: string): string[] => [leakToken, encodeURIComponent(leakToken), basicHeader({ email: FAKE_JIRA_EMAIL, token: leakToken }).slice(6), FAKE_JIRA_EMAIL].filter((secret) => text.includes(secret))
      const base = jiraSourceEntry({ pageSize: 2, sleep: async () => {}, baseUrlOf: () => url })
      // 추가 경로 — 연결 테스트가 되울린다(아직 금고에 비밀이 없다: service 가 넘긴 목록만으로 지운다).
      const first = { leak: true }
      const adding = workHarness({ entries: [leaky(base, first)] })
      const refused = await adding.service.addConnection({ sourceId: 'jira', token: leakToken, account: JIRA_ACCOUNT, replaceId: null })
      expect(refused.ok).toBe(false)
      expect(secretsIn(JSON.stringify(refused))).toEqual([])
      expect(secretsIn('x ' + leakToken)).toEqual([leakToken])
      // 재시작 경로 — 저장한 뒤 새 서비스가 봉인을 풀어 만든 클라이언트가 되울린다.
      first.leak = false
      const added = await adding.service.addConnection({ sourceId: 'jira', token: leakToken, account: JIRA_ACCOUNT, replaceId: null })
      if (!added.ok) throw new Error(added.error.message)
      const second = { leak: true }
      const restarted = workHarness({ entries: [leaky(base, second)] })
      restarted.store.data = structuredClone(adding.store.data)
      const response = await restarted.service.request({ requestId: 'r', connectionId: added.connection.id, call: { op: 'listStatuses', spaceKey: 'CORE' } })
      expect(response.ok).toBe(false)
      expect(response.ok ? '' : response.error.message).toContain('echo')
      expect(secretsIn(JSON.stringify(response))).toEqual([])
    } finally {
      await fixture.stop()
    }
  })

  it('토큰 다시 붙여넣기 — 사이트는 바꿀 수 없고(거절·요청 0), 이메일·토큰은 바뀐다 · 숨긴 스페이스 유지', async () => {
    const h = await connected()
    expect(h.service.setSpaceHidden({ connectionId: h.connectionId, spaceKey: 'LAB', hidden: true })).toEqual({ ok: true })
    const before = h.fixture.requests.length
    const moved = await h.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: { site: 'other.atlassian.net', email: FAKE_JIRA_EMAIL }, replaceId: h.connectionId })
    expect(moved).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    expect(h.fixture.requests.length).toBe(before)
    h.fixture.allow({ email: 'second@fixture.invalid', token: 'ATATTsecond0000' })
    const replaced = await h.service.addConnection({ sourceId: 'jira', token: 'ATATTsecond0000', account: { site: 'https://fixture.atlassian.net/', email: 'second@fixture.invalid' }, replaceId: h.connectionId })
    expect(replaced.ok).toBe(true)
    expect(h.service.settings().connections[0]).toMatchObject({ account: { email: 'second@fixture.invalid' }, tokenTail: '0000', hiddenSpaceKeys: ['LAB'] })
  })

  it('이전 판 앱이 다시 써 `account` 칸이 떨어진 행도 돈다 — 클라이언트는 암호문 안의 칸으로 만든다', async () => {
    const h = await connected()
    const row = h.store.data.connections[0]
    if (row === undefined) throw new Error('row')
    h.store.data = { ...h.store.data, connections: [{ ...row, account: {} }] }
    h.vault.forget(h.connectionId)
    // 새 서비스(재시작) — 같은 저장소·금고 cipher.
    const restarted = workHarness({ entries: [jiraSourceEntry({ pageSize: 2, baseUrlOf: () => h.url })] })
    restarted.store.data = structuredClone(h.store.data)
    restarted.cipher.mode = 'ok'
    const response = await restarted.service.request({ requestId: 'r', connectionId: h.connectionId, call: { op: 'listStatuses', spaceKey: 'CORE' } })
    expect(response.ok).toBe(true)
    // R1-P 표시 칸은 봉인 안 칸으로 복원된다 — 카드 제목·메타와 교체 폼이 빈 채로 남지 않는다.
    expect(restarted.store.data.connections[0]?.account).toEqual(row.account)
    expect(restarted.service.settings().connections[0]?.account).toEqual(row.account)
  })

  it('R1-P 표시 칸이 떨어진 행의 토큰 교체 — 다른 사이트는 봉인 안 칸과 대조해 거절(요청 0), 같은 사이트는 바뀐다', async () => {
    const h = await connected()
    const row = h.store.data.connections[0]
    if (row === undefined) throw new Error('row')
    h.store.data = { ...h.store.data, connections: [{ ...row, account: {} }] }
    const before = h.fixture.requests.length
    const moved = await h.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: { site: 'other.atlassian.net', email: FAKE_JIRA_EMAIL }, replaceId: h.connectionId })
    expect(moved).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    expect(h.fixture.requests.length).toBe(before)
    const same = await h.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: h.connectionId })
    expect(same.ok).toBe(true)
    expect(h.store.data.connections[0]?.account).toEqual(row.account)
  })
})

describe('C2 오류 분류', () => {
  it('401 → auth · CAPTCHA 표지면 「웹에서 한 번 로그인」 · 403 → forbidden · 5xx → network', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/statuses'), status: 403, once: true })
    expect(await h.send({ op: 'listStatuses', spaceKey: 'CORE' })).toMatchObject({ ok: false, error: { kind: 'forbidden', status: 403 } })
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/statuses'), status: 502, once: true })
    expect(await h.send({ op: 'listStatuses', spaceKey: 'CORE' })).toMatchObject({ ok: false, error: { kind: 'network', status: 502 } })
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/statuses'), status: 401, headers: { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' }, once: true })
    const captcha = await h.send({ op: 'listStatuses', spaceKey: 'CORE' })
    expect(captcha).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } })
    if (!captcha.ok) expect(captcha.error.message).toContain('CAPTCHA')
    // auth 뒤 일반 요청은 같은 자격을 다시 보내지 않는다(T1 규칙).
    const before = h.fixture.requests.length
    expect(await h.send({ op: 'listStatuses', spaceKey: 'CORE' })).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(h.fixture.requests.length).toBe(before)
  })

  it('R1-K C2 공백 — 읽기 시간 초과 · 쓰기 시간 초과(maybeApplied, 한 번만) · DNS 실패(보내기 전) · 쓰기 403(적용 안 됨) · CAPTCHA 표지 403', async () => {
    const h = await connected({ timeoutMs: 150 })
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/statuses'), delayMs: 400, once: true })
    const slowRead = await h.send({ op: 'listStatuses', spaceKey: 'CORE' })
    expect(slowRead).toMatchObject({ ok: false, error: { kind: 'network' } })
    if (!slowRead.ok) { expect(slowRead.error.message).toContain('초과'); expect(slowRead.error.maybeApplied).toBeUndefined() }
    h.fixture.faults.push({ match: (request) => request.method === 'POST' && request.path.endsWith('/comment'), delayMs: 400, once: true })
    const slowWrite = await h.send({ op: 'addComment', itemId: '20001', body: '늦은 코멘트' })
    expect(slowWrite).toMatchObject({ ok: false, error: { kind: 'network', maybeApplied: true } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/comment'))).toHaveLength(1)
    h.fixture.faults.push({ match: (request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20002', status: 403, once: true })
    const denied = await h.send({ op: 'updateItem', itemId: '20002', fields: { title: '권한 없음' }, ifVersion: null })
    expect(denied).toMatchObject({ ok: false, error: { kind: 'forbidden', status: 403 } })
    if (!denied.ok) expect(denied.error.maybeApplied).toBeUndefined()
    expect(h.fixture.requests.filter((request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20002')).toHaveLength(1)
    // CAPTCHA 표지가 403 으로 와도 「웹에서 한 번 로그인」(R1-T).
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/project/WEB/statuses'), status: 403, headers: { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' }, once: true })
    const captcha = await h.send({ op: 'listStatuses', spaceKey: 'WEB' })
    expect(captcha).toMatchObject({ ok: false, error: { kind: 'auth', status: 403 } })
    if (!captcha.ok) expect(captcha.error.message).toContain('CAPTCHA')
    // DNS — undici 가 던지는 모양(cause.code ENOTFOUND). 보내기 전 실패라 쓰기여도 maybeApplied 없음.
    const dns: typeof fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND acme.atlassian.net'), { code: 'ENOTFOUND' }) }) }
    const lost = new JiraHttp({ baseUrl: 'https://acme.atlassian.net', email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN, fetchImpl: dns })
    const unreachable = await lost.request({ method: 'POST', path: '/rest/api/3/issue', body: {}, write: true })
    expect(unreachable).toMatchObject({ ok: false, unsent: true, error: { kind: 'network' } })
    if (!unreachable.ok) expect(unreachable.error.message).toContain('DNS')
  })

  it('404 — 없는/못 보는 이슈: 단건은 거절(인증 실패 아님), 키 찾기는 null', async () => {
    const h = await connected()
    expect(await h.send({ op: 'getItem', itemId: '99999' })).toMatchObject({ ok: false, error: { kind: 'rejected', status: 404 } })
    expect(await h.send({ op: 'findByKey', key: 'CORE-999' })).toMatchObject({ ok: true, result: { item: null } })
    expect(h.service.settings().connections[0]?.status).toBe('ok')
  })

  it('429 + Retry-After — 읽기는 상한 안에서 다시(최대 2번), 쓰기는 한 번만(자동 재전송 0)', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/statuses'), status: 429, headers: { 'Retry-After': '1' }, once: true })
    expect((await h.send({ op: 'listStatuses', spaceKey: 'CORE' })).ok).toBe(true)
    expect(h.fixture.requests.filter((request) => request.path === '/rest/api/3/project/CORE/statuses')).toHaveLength(2)
    h.fixture.faults.push({ match: (request) => request.method === 'POST' && request.path.endsWith('/comment'), status: 429, headers: { 'Retry-After': '1' } })
    const write = await h.send({ op: 'addComment', itemId: '20001', body: '한 번만' })
    // 429 = 처리 전에 받지 않음 — 「적용 안 됨」(R1-M), 다시 보내지 않는다.
    expect(write).toMatchObject({ ok: false, error: { kind: 'network', status: 429 } })
    if (!write.ok) { expect(write.error.maybeApplied).toBeUndefined(); expect(write.error.message).toContain('적용되지 않았습니다') }
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/comment'))).toHaveLength(1)
    // 503 은 어디서 났는지 모른다 — 「적용됐는지 모름」, 한 번만.
    h.fixture.faults.splice(0)
    h.fixture.faults.push({ match: (request) => request.method === 'POST' && request.path.endsWith('/comment'), status: 503, headers: { 'Retry-After': '1' } })
    expect(await h.send({ op: 'addComment', itemId: '20001', body: '503' })).toMatchObject({ ok: false, error: { kind: 'network', status: 503, maybeApplied: true } })
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/comment'))).toHaveLength(2)
    // 긴 Retry-After 는 기다리지 않는다(상한 5 s) — 한 번만.
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/project/WEB/statuses'), status: 429, headers: { 'Retry-After': '120' } })
    const slow = await h.send({ op: 'listStatuses', spaceKey: 'WEB' })
    expect(slow).toMatchObject({ ok: false, error: { kind: 'network', status: 429 } })
    if (!slow.ok) expect(slow.error.message).toContain('120초')
    expect(h.fixture.requests.filter((request) => request.path === '/rest/api/3/project/WEB/statuses')).toHaveLength(1)
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter('soon')).toBeNull()
  })

  it('쓰기 응답 끊김 → maybeApplied(다시 보내지 않음) · 연결 거부(보내기 전) → network, maybeApplied 없음', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20002', destroy: 'after', once: true })
    const cut = await h.send({ op: 'updateItem', itemId: '20002', fields: { title: '끊긴 수정' }, ifVersion: null })
    expect(cut).toMatchObject({ ok: false, error: { kind: 'network', maybeApplied: true } })
    expect(h.fixture.issue('20002')?.summary).toBe('끊긴 수정')
    expect(h.fixture.requests.filter((request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20002')).toHaveLength(1)
    // 닫힌 포트(방금 열었다 닫은 자리) — 요청이 나가기 전 연결 거부.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const address = probe.address()
    if (address === null || typeof address === 'string') throw new Error('address')
    await new Promise((resolve) => probe.close(resolve))
    const dead = new JiraHttp({ baseUrl: `http://127.0.0.1:${address.port}`, email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN, timeoutMs: 2000 })
    const refused = await dead.request({ method: 'POST', path: '/rest/api/3/issue', body: {}, write: true })
    expect(refused).toMatchObject({ ok: false, unsent: true, error: { kind: 'network' } })
  })

  it('응답 모양 어긋남 → invalid_response(경로) · 리다이렉트는 따라가지 않는다', async () => {
    const h = await connected()
    h.fixture.corrupt = 'issue-no-status'
    const broken = await h.send({ op: 'getItem', itemId: '20001' })
    expect(broken).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    if (!broken.ok) expect(broken.error.message).toContain('fields.status')
    h.fixture.corrupt = 'none'
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/issue/20001', status: 302, headers: { Location: 'http://127.0.0.1:9/steal' }, once: true })
    expect(await h.send({ op: 'getItem', itemId: '20001' })).toMatchObject({ ok: false, error: { kind: 'invalid_response', status: 302 } })
  })

  it('키체인 실패 → keychain (교체 저장 0)', async () => {
    const harness = await jiraFixtureHarness()
    opened.push(harness)
    harness.cipher.mode = 'deny-encrypt'
    expect(await harness.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })).toMatchObject({ ok: false, error: { kind: 'keychain' } })
    expect(harness.store.writes).toBe(0)
  })

  it('원격 글은 질의 거부 사유에만 — 제어 글자를 빼고 200자 상한', () => {
    expect(errorText({ body: { errorMessages: ['a\u0000b\n  c'] } })).toBe('a b c')
    expect(errorText({ body: { errorMessages: [], errors: { jql: 'x'.repeat(500) } } })?.length).toBe(200)
    expect(errorText({ body: 'plain' })).toBeNull()
    // R1-S — 경계에 걸린 비밀도 자르기 전에 지운다(자른 뒤 지우면 앞 조각이 남는다).
    const secret = 'S'.repeat(40)
    const cut = errorText({ body: { errorMessages: [`${'x'.repeat(180)}${secret}`] }, redact: (text) => text.replaceAll(secret, '••••') })
    expect(cut).toBe(`${'x'.repeat(180)}••••`)
    expect(cut).not.toContain('SSSS')
  })
})

describe('수정 1 — 순서 능력 (R1-N·R1-O·N20)', () => {
  const orderOf = async (h: Awaited<ReturnType<typeof connected>>, key: string): Promise<unknown> => {
    const spaces = await h.send({ op: 'listSpaces' })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    return spaces.result.spaces.find((space) => space.key === key)?.capabilities.order ?? { state: 'on' }
  }
  const board = (request: { path: string }): boolean => request.path === '/rest/agile/1.0/board'

  it('N20 보드 조회 404(Software 없음) · 401/403(권한) · 그 밖(5xx) 은 사유가 다르다 — 일시 오류는 「권한 없음」 이 아니고 다시 물으면 켜진다(R1-N)', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: board, status: 404, once: true })
    expect(await orderOf(h, 'CORE')).toMatchObject({ state: 'disabled', reason: expect.stringContaining('Jira Software') })
    h.fixture.faults.push({ match: board, status: 403, once: true })
    expect(await orderOf(h, 'CORE')).toMatchObject({ state: 'disabled', reason: expect.stringContaining('권한') })
    h.fixture.faults.push({ match: board, status: 401, once: true })
    expect(await orderOf(h, 'CORE')).toMatchObject({ state: 'disabled', reason: expect.stringContaining('권한') })
    h.fixture.faults.push({ match: board, status: 502, once: true })
    const transient = await orderOf(h, 'CORE')
    expect(transient).toMatchObject({ state: 'disabled', reason: expect.stringContaining('지금 받지 못해') })
    expect(JSON.stringify(transient)).not.toContain('권한')
    expect(await orderOf(h, 'CORE')).toEqual({ state: 'on' })
  })

  it('R1-N 보드 쪽 상한(20쪽)에 닿으면 보드 0 스페이스는 「상한 도달」 이유로 끈다 — 보드 수를 다 못 봤다고 알린다', async () => {
    const h = await connected()
    const core = h.fixture.projects.find((project) => project.key === 'CORE')
    if (core === undefined) throw new Error('seed')
    core.boards = 60
    const before = h.fixture.requests.filter(board).length
    expect(await orderOf(h, 'WEB')).toMatchObject({ state: 'disabled', reason: expect.stringContaining('1000개') })
    expect(await orderOf(h, 'CORE')).toEqual({ state: 'on' })
    // 쪽 크기 2 × 20쪽 = 한 번의 목록에 보드 요청 20번까지 — 두 번 불렀다.
    expect(h.fixture.requests.filter(board).length - before).toBe(40)
  })

  it('R1-O 스페이스 목록 전에 목록을 불러도 순서가 같다 — 보드 있는 스페이스는 Rank 순(재시작 직후)', async () => {
    const h = await connected()
    const restarted = workHarness({ entries: [jiraSourceEntry({ pageSize: 2, sleep: async () => {}, baseUrlOf: () => h.url })] })
    restarted.store.data = structuredClone(h.store.data)
    restarted.cipher.mode = 'ok'
    const before = h.fixture.requests.length
    const listed = await restarted.service.request({ requestId: 'r', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: 'CORE', cursor: null } })
    expect(listed.ok).toBe(true)
    const sent = h.fixture.requests.slice(before)
    expect(sent.some((request) => request.path === '/rest/api/3/project/search')).toBe(false)
    expect(sent.filter((request) => request.path === '/rest/api/3/search/jql').map((request) => request.query.jql)).toEqual(['project = "CORE" ORDER BY Rank ASC'])
  })
})

describe('수정 1 R1-K — 리뷰어 생존 뮤테이션을 죽이는 시험', () => {
  it('N01 close 뒤에는 보내지 않는다 — 클라이언트 close 다음 요청은 fixture 에 닿지 않는다(not_connected)', async () => {
    const h = await connected()
    const client = jiraSourceEntry({ pageSize: 2, sleep: async () => {}, baseUrlOf: () => h.url }).create({ token: FAKE_JIRA_TOKEN, account: { site: 'fixture.atlassian.net', email: FAKE_JIRA_EMAIL } })
    expect((await client.call({ op: 'listStatuses', spaceKey: 'CORE' })).ok).toBe(true)
    client.close()
    const before = h.fixture.requests.length
    expect(await client.call({ op: 'getItem', itemId: '20001' })).toMatchObject({ ok: false, error: { kind: 'not_connected' } })
    expect(h.fixture.requests.length).toBe(before)
  })

  it('N03 지금 못 하는 전이(isAvailable false)는 허용 목록에 넣지 않는다 · 되는 전이는 넣는다(양성 대조)', async () => {
    const h = await connected()
    const status = (id: string, name: string, key: string): Record<string, unknown> => ({ id, name, statusCategory: { id: 4, key, name: key } })
    h.fixture.faults.push({ match: (request) => request.method === 'GET' && request.path === '/rest/api/3/issue/20002/transitions', status: 200, once: true, body: { transitions: [
      { id: '11', name: 'Start', to: status('10001', 'In Progress', 'indeterminate'), hasScreen: false, isGlobal: false, isInitial: false, isAvailable: false, isConditional: true, looped: false, fields: {} },
      { id: '21', name: 'Review', to: status('10002', 'In Review', 'indeterminate'), hasScreen: false, isGlobal: false, isInitial: false, isAvailable: true, isConditional: false, looped: false, fields: {} },
    ] } })
    const listed = await h.send({ op: 'listTransitions', itemId: '20002' })
    if (!listed.ok || listed.result.op !== 'listTransitions') throw new Error('transitions')
    expect(listed.result.statusKeys).toEqual(['10002'])
  })

  it('N06 우선순위 비우기(null)는 보내기 전에 거절 — PUT 0', async () => {
    const h = await connected()
    const puts = (): number => h.fixture.requests.filter((request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20002').length
    const before = puts()
    expect(await h.send({ op: 'updateItem', itemId: '20002', fields: { priority: null }, ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('비울 수 없습니다') } })
    expect(puts()).toBe(before)
  })

  it('N07 이력의 corralWriteId 는 모양이 맞을 때만 쓰기 id — 모양 밖이면 null(지어낸 id 로 corral 기록을 지우지 않는다)', async () => {
    const h = await connected()
    const entry = (id: string, writeId: string): Record<string, unknown> => ({ id, created: '2026-10-10T00:00:00.000+0000', author: { accountId: 'acc-1', displayName: 'Fixture User' }, items: [{ field: 'summary', fieldId: 'summary', fromString: 'a', toString: 'b' }], historyMetadata: { extraData: { corralWriteId: writeId } } })
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/issue/20002/changelog', status: 200, once: true, body: { values: [entry('1', '../bad id'), entry('2', 'w-ok_1')], isLast: true, startAt: 0, maxResults: 100, total: 2 } })
    const history = await h.send({ op: 'listHistory', itemId: '20002' })
    if (!history.ok || history.result.op !== 'listHistory') throw new Error('history')
    expect(history.result.entries.map((row) => row.writeId)).toEqual([null, 'w-ok_1'])
  })

  it('N10 이 출처에 없는 연결 칸은 받지 않는다 — 네트워크 전 거절', async () => {
    const h = await connected()
    const before = h.fixture.requests.length
    expect(await h.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: { ...JIRA_ACCOUNT, password: 'x' }, replaceId: null })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    expect(h.fixture.requests.length).toBe(before)
  })

  it('N14 하위 작업의 부모 지우기는 거절 · M20 다른 스페이스로 옮기기는 첫 가드에서 거절 — 둘 다 PUT 0', async () => {
    const h = await connected()
    const puts = (): number => h.fixture.requests.filter((request) => request.method === 'PUT').length
    const before = puts()
    expect(await h.send({ op: 'setParent', itemId: '20005', spaceKey: 'CORE', parentId: null, ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('하위 작업') } })
    // 다른 스페이스 키 — 부모 없음(null)이면 부모 쪽 가드를 지나므로 첫 가드만이 막는다.
    expect(await h.send({ op: 'setParent', itemId: '20002', spaceKey: 'WEB', parentId: null, ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('다른 스페이스') } })
    expect(puts()).toBe(before)
    expect(h.fixture.issue('20002')?.parentId).toBe('20001')
  })

  it('N17 기본값 있는 필수 필드(hasDefaultValue)는 묻지 않는다 — 기본값 없는 필수만 칸으로', async () => {
    const h = await connected()
    const field = (fieldId: string, hasDefaultValue: boolean): Record<string, unknown> => ({ fieldId, key: fieldId, name: fieldId, required: true, hasDefaultValue, operations: ['set'], schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield', customId: 1 } })
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/issue/createmeta/CORE/issuetypes/10001', status: 200, once: true, body: { fields: [field('summary', false), field('customfield_20001', true), field('customfield_20002', false)], startAt: 0, maxResults: 50, total: 3, isLast: true } })
    const meta = await h.send({ op: 'getCreateMeta', spaceKey: 'CORE', kindKey: '10001' })
    if (!meta.ok || meta.result.op !== 'getCreateMeta') throw new Error('meta')
    expect(meta.result.meta.fields.map((entry) => entry.key)).toEqual(['customfield_20002'])
  })

  it('M18 스페이스 능력은 연결 능력을 좁히기만 — 연결이 꺼진 능력을 스페이스가 켜지 못한다', () => {
    const off = { state: 'disabled', reason: '연결 전체 꺼짐' } as const
    const base: WorkCapabilities = { ...jiraSourceEntry({}).create({ token: FAKE_JIRA_TOKEN, account: { site: 'fixture.atlassian.net', email: FAKE_JIRA_EMAIL } }).capabilities(), order: off }
    expect(spaceCapabilities({ capabilities: base, space: { capabilities: { order: { state: 'on' } } } }).order).toEqual(off)
    // 양성 대조 — 연결이 켠 능력은 스페이스가 끈다.
    const on: WorkCapabilities = { ...base, order: { state: 'on' } }
    expect(spaceCapabilities({ capabilities: on, space: { capabilities: { order: { state: 'disabled', reason: '보드 없음' } } } }).order).toEqual({ state: 'disabled', reason: '보드 없음' })
    // 배치도 같은 규칙(Y22) — 켠 연결에서 스페이스가 끄면 꺼진다.
    const placementOn: WorkCapabilities = { ...base, placement: { state: 'on' } }
    expect(spaceCapabilities({ capabilities: placementOn, space: { capabilities: { placement: { state: 'disabled', reason: '스크럼' } } } }).placement).toEqual({ state: 'disabled', reason: '스크럼' })
  })
})

describe('수정 2 — 리뷰 r2 (R2-C 생존 뮤테이션 · R2-E · R2-F · R2-I)', () => {
  it('R2-E 새로 고침(스페이스 목록)이 상태·우선순위 캐시를 비운다 — Jira 에서 상태를 더하면 새로 고친 뒤 보인다', async () => {
    const h = await connected()
    const count = async (): Promise<number> => {
      const listed = await h.send({ op: 'listStatuses', spaceKey: 'WEB' })
      if (!listed.ok || listed.result.op !== 'listStatuses') throw new Error('statuses')
      return listed.result.statuses.length
    }
    expect(await count()).toBe(2)
    const web = h.fixture.projects.find((project) => project.key === 'WEB')
    if (web === undefined) throw new Error('seed')
    for (const typeId of Object.keys(web.statusesByType)) web.statusesByType[typeId]?.push('10001')
    expect(await count()).toBe(2)
    expect((await h.send({ op: 'listSpaces' })).ok).toBe(true)
    expect(await count()).toBe(3)
    // 우선순위 — 쓴 뒤 이름이 바뀌어도 새로 고친 뒤에는 새 목록으로 고른다.
    expect((await h.send({ op: 'updateItem', itemId: '20002', fields: { priority: 'low' }, ifVersion: null })).ok).toBe(true)
    const searches = (): number => h.fixture.requests.filter((request) => request.path === '/rest/api/3/priority/search').length
    const before = searches()
    expect((await h.send({ op: 'listSpaces' })).ok).toBe(true)
    expect((await h.send({ op: 'updateItem', itemId: '20002', fields: { priority: 'high' }, ifVersion: null })).ok).toBe(true)
    expect(searches()).toBe(before + 1)
  })

  it('R2-F 쓰기 2xx 뒤 응답 모양 어긋남(만들기·코멘트)·연결 추가 뒤 다시 읽기 실패는 maybeApplied + 「…지만」 — 다시 보내지 않는다(Y29)', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.method === 'POST' && request.path === '/rest/api/3/issue', status: 201, body: {}, once: true })
    const made = await h.send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: '10001', title: '모양 어긋난 만들기' })
    expect(made).toMatchObject({ ok: false, error: { kind: 'invalid_response', maybeApplied: true, message: expect.stringContaining('만들어졌지만') } })
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path === '/rest/api/3/issue')).toHaveLength(1)
    h.fixture.faults.push({ match: (request) => request.method === 'POST' && request.path === '/rest/api/3/issue/20001/comment', status: 201, body: { id: '1' }, once: true })
    expect(await h.send({ op: 'addComment', itemId: '20001', body: '모양 어긋난 코멘트' })).toMatchObject({ ok: false, error: { maybeApplied: true, message: expect.stringContaining('만들어졌지만') } })
    const linked = (): boolean => h.fixture.requests.some((request) => request.method === 'POST' && request.path === '/rest/api/3/issueLink')
    h.fixture.faults.push({ match: (request) => request.method === 'GET' && request.path === '/rest/api/3/issue/20001' && linked(), status: 502, once: true })
    expect(await h.send({ op: 'addRelation', itemId: '20001', kind: 'relates_to', otherKey: 'CORE-4' })).toMatchObject({ ok: false, error: { maybeApplied: true, message: expect.stringContaining('적용됐지만') } })
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path === '/rest/api/3/issueLink')).toHaveLength(1)
  })

  it('R2-I 둥근 따옴표가 든 질의는 짝 검사를 믿을 수 없어 질의로 보내지 않는다(텍스트 폴백) · Y32 따옴표 안 역슬래시 · Y33 작은따옴표도 따옴표', async () => {
    expect(splitOrderBy('a = “(” ) OR ( project = WEB ) OR ( b = “)”')).toBeNull()
    expect(splitOrderBy('summary ~ ‘x’')).toBeNull()
    expect(splitOrderBy('summary ~ "a \\" (b"')).toEqual({ where: 'summary ~ "a \\" (b"', orderBy: null })
    expect(splitOrderBy("summary ~ 'a ) b'")).toEqual({ where: "summary ~ 'a ) b'", orderBy: null })
    const h = await connected()
    const searched = await h.send({ op: 'searchItems', spaceKeys: ['CORE'], query: 'a = “(” ) OR ( project = WEB ) OR ( b = “)”' })
    expect(searched).toMatchObject({ ok: true, result: { mode: 'text', note: expect.stringContaining('둥근 따옴표') } })
  })

  it('Y13 읽기 재시도는 2번까지 — 429 가 계속이면 요청 3번에서 멈춘다', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/project/CORE/statuses', status: 429, headers: { 'Retry-After': '1' } })
    expect(await h.send({ op: 'listStatuses', spaceKey: 'CORE' })).toMatchObject({ ok: false, error: { kind: 'network', status: 429 } })
    expect(h.fixture.requests.filter((request) => request.path === '/rest/api/3/project/CORE/statuses')).toHaveLength(3)
  })

  it('Y12 자식 목록 쪽 상한 20 — 표지가 매번 달라도 끝없이 돌지 않는다', async () => {
    const h = await connected()
    let page = 0
    // 실제 이슈 모양(fixture 의 단건 응답 그대로)을 쪽마다 하나씩 — 모양 어긋남이 아니라 쪽 상한으로 멈추는지 본다.
    const bean: unknown = await (await fetch(`${h.url}/rest/api/3/issue/20002`, { headers: { authorization: basicHeader({ email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN }) } })).json()
    const body: Record<string, unknown> = { issues: [bean], nextPageToken: 'T0' }
    h.fixture.faults.push({ match: (request) => {
      if (request.path !== '/rest/api/3/search/jql' || !(request.query.jql ?? '').startsWith('parent = 20001')) return false
      page += 1
      body.nextPageToken = `T${page}`
      return true
    }, status: 200, body })
    expect(await h.send({ op: 'listChildren', itemId: '20001' })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    expect(page).toBe(20)
  })

  it('Y14 jqlString 은 줄바꿈을 공백으로 · Y16 같은 상태로 가는 전이가 여럿이면 Jira 순서의 첫 것', () => {
    expect(jqlString('a\nb\r\nc')).toBe('"a b c"')
    const to = { id: '10003', name: 'Done', statusCategory: { key: 'done' } }
    const plan = transitionPlan(readTransitions({ transitions: [{ id: '31', name: 'First', to, isAvailable: true, looped: false }, { id: '41', name: 'Second', to, isAvailable: true, looped: false }] }))
    expect(plan.open.get('10003')?.id).toBe('31')
  })

  it('Y17 이력의 description 은 본문(body) 칸 — 원문은 싣지 않는다', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/issue/20002/changelog', status: 200, once: true, body: { values: [{ id: '1', created: '2026-10-10T00:00:00.000+0000', items: [{ field: 'description', fieldId: 'description', fromString: '옛 본문', toString: '새 본문' }] }], isLast: true, startAt: 0, maxResults: 100, total: 1 } })
    const history = await h.send({ op: 'listHistory', itemId: '20002' })
    if (!history.ok || history.result.op !== 'listHistory') throw new Error('history')
    expect(history.result.entries.map((entry) => ({ field: entry.field, from: entry.from, to: entry.to }))).toEqual([{ field: 'body', from: null, to: null }])
  })

  it('Y10 표시 칸 복원은 행에 있는 값을 덮지 않는다 · Y23 연결 칸 앞뒤 공백은 저장 전에 다듬는다', async () => {
    const h = await connected()
    const row = h.store.data.connections[0]
    if (row === undefined) throw new Error('row')
    h.store.data = { ...h.store.data, connections: [{ ...row, account: { email: 'shown@fixture.invalid' } }] }
    h.vault.forget(h.connectionId)
    const restarted = workHarness({ entries: [jiraSourceEntry({ pageSize: 2, sleep: async () => {}, baseUrlOf: () => h.url })] })
    restarted.store.data = structuredClone(h.store.data)
    restarted.cipher.mode = 'ok'
    expect((await restarted.service.request({ requestId: 'r', connectionId: h.connectionId, call: { op: 'listStatuses', spaceKey: 'CORE' } })).ok).toBe(true)
    expect(restarted.store.data.connections[0]?.account).toEqual({ site: row.account.site, email: 'shown@fixture.invalid' })
    const fresh = await jiraFixtureHarness()
    opened.push(fresh)
    const added = await fresh.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: { site: JIRA_ACCOUNT.site, email: `  ${FAKE_JIRA_EMAIL}  ` }, replaceId: null })
    expect(added.ok).toBe(true)
    expect(fresh.store.data.connections[0]?.account.email).toBe(FAKE_JIRA_EMAIL)
  })

  it('Y26 CAPTCHA 표지 값은 대소문자 무시 · Y27 Retry-After 는 HTTP 날짜도 읽는다', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path.endsWith('/statuses'), status: 401, headers: { 'X-Seraph-LoginReason': 'authentication_denied' }, once: true })
    const captcha = await h.send({ op: 'listStatuses', spaceKey: 'CORE' })
    if (captcha.ok) throw new Error('captcha')
    expect(captcha.error.message).toContain('CAPTCHA')
    const wait = parseRetryAfter(new Date(Date.now() + 4000).toUTCString())
    expect(wait).not.toBeNull()
    expect(wait ?? 0).toBeGreaterThan(1000)
    expect(wait ?? 0).toBeLessThanOrEqual(4000)
  })

  it('Y28 리다이렉트 응답 본문은 읽지 않고 닫는다(연결을 붙잡지 않는다)', async () => {
    let cancelled = false
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({ cancel: () => { cancelled = true } }), { status: 302, headers: { Location: 'http://127.0.0.1:9/x' } })
    const http = new JiraHttp({ baseUrl: 'https://acme.atlassian.net', email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN, fetchImpl })
    expect(await http.request({ method: 'GET', path: '/rest/api/3/myself', write: false })).toMatchObject({ ok: false, error: { kind: 'invalid_response', status: 302 } })
    expect(cancelled).toBe(true)
  })
})

describe('R1-X 쓰기 뒤 다시 읽기 실패', () => {
  it('쓰기는 적용됐다 — 일반 실패가 아니라 maybeApplied(다시 보내지 않게) + 「적용됐지만」 문구 · 수정·상태·순서', async () => {
    const h = await connected()
    const wrote = (method: string, path: string): boolean => h.fixture.requests.some((request) => request.method === method && request.path === path)
    h.fixture.faults.push({ match: (request) => request.method === 'GET' && request.path === '/rest/api/3/issue/20002' && wrote('PUT', '/rest/api/3/issue/20002'), status: 502, once: true })
    const edited = await h.send({ op: 'updateItem', itemId: '20002', fields: { title: '다시 못 읽음' }, ifVersion: null })
    expect(edited).toMatchObject({ ok: false, error: { kind: 'network', maybeApplied: true, message: expect.stringContaining('적용됐지만') } })
    expect(h.fixture.issue('20002')?.summary).toBe('다시 못 읽음')
    h.fixture.faults.push({ match: (request) => request.method === 'GET' && request.path === '/rest/api/3/issue/20002' && wrote('POST', '/rest/api/3/issue/20002/transitions'), status: 502, once: true })
    expect(await h.send({ op: 'changeStatus', itemId: '20002', statusKey: '10001', ifVersion: null })).toMatchObject({ ok: false, error: { maybeApplied: true } })
    expect(h.fixture.issue('20002')?.statusId).toBe('10001')
    h.fixture.faults.push({ match: (request) => request.method === 'GET' && request.path === '/rest/api/3/issue/20003' && wrote('PUT', '/rest/agile/1.0/issue/rank'), status: 502, once: true })
    expect(await h.send({ op: 'reorder', itemId: '20003', afterId: '20001' })).toMatchObject({ ok: false, error: { maybeApplied: true } })
    expect(h.fixture.requests.filter((request) => request.path === '/rest/agile/1.0/issue/rank')).toHaveLength(1)
  })
})

describe('R1-U 이슈 id 모양', () => {
  it('숫자 밖 id(`..`·`/`·키)는 경로에 넣기 전에 거절 — 요청 0 · 숫자 id 는 그대로(양성 대조)', async () => {
    const h = await connected()
    const before = h.fixture.requests.length
    for (const call of [
      { op: 'getItem', itemId: '..' },
      { op: 'getItem', itemId: '../../myself' },
      { op: 'listComments', itemId: '20001/..' },
      { op: 'getItem', itemId: 'CORE-1' },
      { op: 'reorder', itemId: '20001', afterId: '..' },
      { op: 'setParent', itemId: '20002', spaceKey: 'CORE', parentId: '%2e%2e', ifVersion: null },
      { op: 'updateItem', itemId: ' 20001', fields: { title: 'x' }, ifVersion: null },
    ] satisfies WorkCall[]) expect(await h.send(call)).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(h.fixture.requests.length).toBe(before)
    expect((await h.send({ op: 'getItem', itemId: '20001' })).ok).toBe(true)
  })
})

describe('C4 스페이스·상태·전이', () => {
  it('프로젝트 목록 모든 쪽(쪽 크기 2 → 3쪽) · 상태 합집합(같은 id 하나) · 분류 → 처음 나온 순 · 종류 계층', async () => {
    const h = await connected()
    expect(h.fixture.requests.filter((request) => request.path === '/rest/api/3/project/search')).toHaveLength(3)
    const spaces = await h.send({ op: 'listSpaces' })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    expect(spaces.result.spaces.map((space) => space.key)).toEqual(['CORE', 'DOCS', 'LAB', 'OPS', 'WEB'])
    const statuses = await h.send({ op: 'listStatuses', spaceKey: 'CORE' })
    if (!statuses.ok || statuses.result.op !== 'listStatuses') throw new Error('statuses')
    expect(statuses.result.statuses.map((status) => [status.label, status.category, status.order])).toEqual([['To Do', 'todo', 0], ['In Progress', 'in_progress', 1], ['In Review', 'in_progress', 2], ['Blocked', 'in_progress', 3], ['Done', 'done', 4]])
    expect(Object.fromEntries(statuses.result.kinds.map((kind) => [kind.label, kind.childKinds]))).toEqual({ Epic: ['10001', '10002'], Story: ['10003'], Bug: ['10003'], Subtask: [] })
  })

  it('R1-I 모르는 분류 키는 어느 분류로도 넣지 않는다 — 그 상태만 목록에서 빠지고(스페이스는 쓸 수 있다), 그 상태의 작업은 응답 어긋남', async () => {
    const h = await connected()
    h.fixture.corrupt = 'unknown-category'
    const listed = await h.send({ op: 'listStatuses', spaceKey: 'WEB' })
    if (!listed.ok || listed.result.op !== 'listStatuses') throw new Error('statuses')
    // 모르는 분류의 Closed(10011)는 할 일로도 넣지 않고 뺀다 — Open(10010)은 그대로.
    expect(listed.result.statuses.map((status) => status.key)).toEqual(['10010'])
    // 완료 상태의 작업(CORE-6)은 분류를 지어내지 않는다.
    const done = await h.send({ op: 'getItem', itemId: '20006' })
    expect(done).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    if (!done.ok) expect(done.error.message).toContain('분류')
    // 다른 상태 작업은 그대로 읽힌다.
    expect((await h.send({ op: 'getItem', itemId: '20101' })).ok).toBe(true)
  })

  it('R1-I 분류 `undefined`(명세의 No Category) 는 명시 규칙으로 할 일 — 거절하지 않는다', async () => {
    const h = await connected()
    h.fixture.noCategory.add('10010')
    const listed = await h.send({ op: 'listStatuses', spaceKey: 'WEB' })
    if (!listed.ok || listed.result.op !== 'listStatuses') throw new Error('statuses')
    expect(listed.result.statuses.find((status) => status.key === '10010')?.category).toBe('todo')
    const item = await h.send({ op: 'getItem', itemId: '20101' })
    if (!item.ok || item.result.op !== 'getItem') throw new Error('item')
    expect(item.result.item.category).toBe('todo')
  })

  it('필수 필드를 묻는 전이는 이유와 함께 막는다 — 허용 목록에 없고, 보내지 않는다(POST 0) · 같은 상태로 가는 전이가 여럿이면 채울 수 있는 첫 것', async () => {
    const h = await connected()
    // CORE-2 To Do → In Progress
    expect((await h.send({ op: 'changeStatus', itemId: '20002', statusKey: '10001', ifVersion: null })).ok).toBe(true)
    const open = await h.send({ op: 'listTransitions', itemId: '20002' })
    if (!open.ok || open.result.op !== 'listTransitions') throw new Error('transitions')
    expect(open.result.statusKeys.sort()).toEqual(['10000', '10002'])
    expect(open.result.blocked).toEqual([{ statusKey: '10005', reason: expect.stringContaining('Blocker reason') }])
    const posts = () => h.fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/transitions')).length
    const before = posts()
    const blocked = await h.send({ op: 'changeStatus', itemId: '20002', statusKey: '10005', ifVersion: null })
    expect(blocked).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    if (!blocked.ok) expect(blocked.error.message).toContain('Blocker reason')
    expect(posts()).toBe(before)
    // In Review → Done: Approve(필수 필드) 와 Done 둘 — Done(32) 을 보낸다.
    expect((await h.send({ op: 'changeStatus', itemId: '20002', statusKey: '10002', ifVersion: null })).ok).toBe(true)
    expect((await h.send({ op: 'changeStatus', itemId: '20002', statusKey: '10003', ifVersion: null })).ok).toBe(true)
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/transitions')).at(-1)?.body).toMatchObject({ transition: { id: '32' } })
    expect(transitionPlan([]).open.size).toBe(0)
  })

  it('완료 갈래 — 고르지 않는다(능력 꺼짐), 읽기는 Done → completed', async () => {
    const h = await connected()
    const done = await h.send({ op: 'getItem', itemId: '20006' })
    expect(done).toMatchObject({ ok: true, result: { item: { category: 'done', resolution: 'completed' } } })
    expect(await h.send({ op: 'changeStatus', itemId: '20001', statusKey: '10003', ifVersion: null, resolution: 'completed' })).toMatchObject({ ok: false, error: { kind: 'unsupported' } })
  })
})

describe('C5 목록·페이지·질의 검색', () => {
  it('목록 = /search/jql(옛 /search 0) · fields 명시 · 커서 = nextPageToken 그대로 · 칸 없으면 끝(isLast 없이) · Rank 순', async () => {
    const h = await connected()
    const pages: string[][] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page += 1) {
      const response = await h.send({ op: 'listItems', spaceKey: 'CORE', cursor })
      if (!response.ok || response.result.op !== 'listItems') throw new Error('list')
      pages.push(response.result.items.map((item) => item.key))
      cursor = response.result.nextCursor
      if (cursor === null) break
    }
    expect(pages).toEqual([['CORE-1', 'CORE-2'], ['CORE-3', 'CORE-4'], ['CORE-5', 'CORE-6']])
    const searches = h.fixture.requests.filter((request) => request.path === '/rest/api/3/search/jql')
    expect(searches.every((request) => request.query.fields?.includes('summary') && request.query.fields.includes('status'))).toBe(true)
    expect(searches[0]?.query.jql).toBe('project = "CORE" ORDER BY Rank ASC')
    expect(searches.some((request) => request.query.nextPageToken !== undefined)).toBe(true)
    expect(h.fixture.legacyCalls()).toBe(0)
    // 보드 없는 스페이스는 만든 순(Rank 필드를 쓰지 않는다).
    await h.send({ op: 'listItems', spaceKey: 'WEB', cursor: null })
    expect(h.fixture.requests.filter((request) => request.path === '/rest/api/3/search/jql').at(-1)?.query.jql).toBe('project = "WEB" ORDER BY created ASC')
  })

  it('옛 경로 410 양성 대조 — 옛 /search 를 부르면 fixture 가 거절한다', async () => {
    const fixture = new JiraRestFixture()
    fixture.allow({ email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN })
    const url = await fixture.start()
    try {
      const http = new JiraHttp({ baseUrl: url, email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN })
      expect(await http.request({ method: 'GET', path: '/rest/api/3/search', query: { jql: 'project = CORE' }, write: false })).toMatchObject({ ok: false, status: 410 })
      expect(await http.request({ method: 'GET', path: '/rest/api/3/issue/createmeta', write: false })).toMatchObject({ ok: false, status: 410 })
      expect(fixture.legacyCalls()).toBe(2)
    } finally {
      await fixture.stop()
    }
  })

  it('질의 검색 — JQL 이 400 이면 텍스트로 다시 찾고 사유를 준다(사유에 자격 없음) · 텍스트 검색어 주입은 글로 남는다', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/search/jql' && (request.query.jql ?? '').includes('status = '), status: 400, body: { errorMessages: [`bad for ${FAKE_JIRA_EMAIL} ${FAKE_JIRA_TOKEN}`] }, once: true })
    const fallback = await h.send({ op: 'searchItems', spaceKeys: ['CORE', 'WEB'], query: 'status = 랜딩' })
    if (!fallback.ok || fallback.result.op !== 'searchItems') throw new Error('search')
    expect(fallback.result.mode).toBe('text')
    expect(fallback.result.note).toContain('bad for')
    expect(fallback.result.note).not.toContain(FAKE_JIRA_TOKEN)
    expect(fallback.result.note).not.toContain(FAKE_JIRA_EMAIL)
    const textJql = h.fixture.requests.filter((request) => request.path === '/rest/api/3/search/jql').at(-1)?.query.jql
    expect(textJql).toBe('project in ("CORE", "WEB") AND text ~ "status 랜딩" ORDER BY updated DESC')
    expect(textSearchWords('a" OR project = "WEB')).toBe('a OR project WEB')
    expect(jqlString('a" OR x = "b\\')).toBe('"a\\" OR x = \\"b\\\\"')
    // 질의는 스페이스 안에서만 — 사용자 ORDER BY 는 스페이스 조건 뒤로.
    await h.send({ op: 'searchItems', spaceKeys: ['CORE'], query: 'summary ~ "카드" ORDER BY created DESC' })
    expect(h.fixture.requests.filter((request) => request.path === '/rest/api/3/search/jql').at(-1)?.query.jql).toBe('project in ("CORE") AND (summary ~ "카드") ORDER BY created DESC')
  })
})

describe('수정 1 — 질의 범위·쪽 순회 (R1-C·R1-E·N12·N13)', () => {
  const jqls = (h: { fixture: JiraRestFixture }): string[] => h.fixture.requests.filter((request) => request.path === '/rest/api/3/search/jql').map((request) => request.query.jql ?? '')

  it('R1-C 괄호로 스페이스 조건을 벗어나는 질의는 보내지 않고 텍스트로 — WEB 작업이 CORE 검색에 섞이지 않는다', async () => {
    const h = await connected()
    const before = jqls(h).length
    const escaped = await h.send({ op: 'searchItems', spaceKeys: ['CORE'], query: 'status = "To Do") OR (project = WEB' })
    if (!escaped.ok || escaped.result.op !== 'searchItems') throw new Error('search')
    expect(escaped.result.mode).toBe('text')
    expect(escaped.result.note).toContain('괄호')
    expect(escaped.result.items.some((item) => item.spaceKey === 'WEB')).toBe(false)
    const sent = jqls(h).slice(before)
    expect(sent.some((jql) => jql.includes('OR (project = WEB'))).toBe(false)
    expect(sent.every((jql) => jql.startsWith('project in ("CORE") AND text ~ '))).toBe(true)
    // 양성 대조 — 균형 잡힌 OR 는 괄호 안에 갇혀 그대로 질의로 간다.
    await h.send({ op: 'searchItems', spaceKeys: ['CORE'], query: 'status = "To Do" OR project = WEB' })
    expect(jqls(h).at(-1)).toBe('project in ("CORE") AND (status = "To Do" OR project = WEB) ORDER BY updated DESC')
  })

  it('splitOrderBy — 따옴표 안 괄호·ORDER BY 는 글 · 닫히지 않은 따옴표·깊이 음수는 null · 빈 조건은 issuekey IS NOT EMPTY(N12)', () => {
    expect(splitOrderBy('summary ~ "a ) OR (b" ORDER BY created DESC')).toEqual({ where: 'summary ~ "a ) OR (b"', orderBy: 'created DESC' })
    expect(splitOrderBy('summary ~ "order by me"')).toEqual({ where: 'summary ~ "order by me"', orderBy: null })
    expect(splitOrderBy('a = 1) OR (b = 2')).toBeNull()
    expect(splitOrderBy('summary ~ "open')).toBeNull()
    expect(splitOrderBy('(a = 1')).toBeNull()
    expect(splitOrderBy('ORDER BY created DESC')).toEqual({ where: 'issuekey IS NOT EMPTY', orderBy: 'created DESC' })
    expect(splitOrderBy('status = Done order by')).toEqual({ where: 'status = Done', orderBy: 'updated DESC' })
  })

  it('N12 ORDER BY 만 있는 질의 — 스페이스 조건 뒤 빈 괄호를 보내지 않는다', async () => {
    const h = await connected()
    await h.send({ op: 'searchItems', spaceKeys: ['CORE'], query: 'ORDER BY created DESC' })
    expect(jqls(h).at(-1)).toBe('project in ("CORE") AND (issuekey IS NOT EMPTY) ORDER BY created DESC')
  })

  it('R1-E 빈 쪽 + 같은 다음 쪽 표지를 계속 주면 끝없이 돌지 않고 응답 어긋남 — 검색·자식 목록 둘 다(요청 수 상한)', async () => {
    const h = await connected()
    const loop = { status: 200, body: { issues: [], nextPageToken: 'SAME', isLast: false } }
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/search/jql', ...loop })
    const before = jqls(h).length
    expect(await h.send({ op: 'searchItems', spaceKeys: ['CORE'], query: 'status = Done' })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    expect(jqls(h).length - before).toBeLessThanOrEqual(3)
    const mid = jqls(h).length
    expect(await h.send({ op: 'listChildren', itemId: '20001' })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    expect(jqls(h).length - mid).toBeLessThanOrEqual(3)
    // 같은 표지 반복(쪽마다 1건 이상이어도) — 두 번째 같은 표지에서 멈춘다.
    h.fixture.faults.splice(0)
    const one = await h.send({ op: 'getItem', itemId: '20002' })
    if (!one.ok) throw new Error('get')
    const issueBean = h.fixture.requests.length
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/search/jql', status: 200, body: { issues: [{ id: '20002', key: 'CORE-2', fields: {} }], nextPageToken: 'SAME' } })
    expect(await h.send({ op: 'listChildren', itemId: '20001' })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    expect(h.fixture.requests.length - issueBean).toBeLessThanOrEqual(4)
  })

  it('R1-E 오프셋 쪽(프로젝트 목록)이 빈 쪽인데 「더 있음」 이면 응답 어긋남 — 조용히 자르지 않고, 그 쪽에서 바로 멈춘다(요청 1)', async () => {
    const h = await connected()
    const projects = (request: { path: string }): boolean => request.path === '/rest/api/3/project/search'
    h.fixture.faults.push({ match: projects, status: 200, body: { values: [], isLast: false, startAt: 0, maxResults: 2, total: 9 } })
    const before = h.fixture.requests.filter(projects).length
    expect(await h.send({ op: 'listSpaces' })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    expect(h.fixture.requests.filter(projects).length - before).toBe(1)
  })

  it('N13 검색 결과 상한 100 — 넘으면 앞 100건 + truncated', async () => {
    const h = await connected()
    const template = h.fixture.issue('20101')
    if (template === null) throw new Error('seed')
    for (let index = 0; index < 120; index += 1) h.fixture.issues.push({ ...template, id: String(40000 + index), key: `WEB-${100 + index}`, summary: `대량 ${index}`, rank: 1000 + index, created: template.created + index })
    const found = await h.send({ op: 'searchItems', spaceKeys: ['WEB'], query: 'summary ~ "대량"' })
    if (!found.ok || found.result.op !== 'searchItems') throw new Error('search')
    expect(found.result.items).toHaveLength(100)
    expect(found.result.truncated).toBe(true)
  })
})

describe('C6 본문 ADF', () => {
  it('R2-D·Y25 지원 표 안이어도 왕복에서 바뀌는 본문(줄 끝 공백 둘 + 줄바꿈)은 bodyLock — 안내가 몇 번째 어떤 블록인지 말하고, 저장은 거절(PUT 0) · 끝 빈 문단만 있는 본문은 잠그지 않는다', async () => {
    const h = await connected()
    const issue = h.fixture.issue('20002')
    if (issue === null) throw new Error('seed')
    issue.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '첫' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'line one  ' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] }] }
    const got = await h.send({ op: 'getItem', itemId: '20002' })
    if (!got.ok || got.result.op !== 'getItem') throw new Error('get')
    expect(got.result.item.bodyLock).toContain('편집기 서식 — 2번째 블록 문단')
    const edited = await h.send({ op: 'updateItem', itemId: '20002', fields: { body: `${got.result.item.body ?? ''}\n\n덧붙임` }, ifVersion: null })
    expect(edited).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(h.fixture.requests.filter((request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20002')).toHaveLength(0)
    issue.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '본문' }] }, { type: 'paragraph' }] }
    const plain = await h.send({ op: 'getItem', itemId: '20002' })
    if (!plain.ok || plain.result.op !== 'getItem') throw new Error('get')
    expect(plain.result.item.bodyLock).toBeNull()
    expect(plain.result.item.body).toBe('본문')
  })

  it('바꿀 수 없는 요소(멘션·패널)가 있으면 bodyLock 이유 · 본문 저장은 거절(PUT 0) · 체크 칸만 바꾸면 그 상태만 바뀐 ADF 를 보낸다', async () => {
    const h = await connected()
    const got = await h.send({ op: 'getItem', itemId: '20003' })
    if (!got.ok || got.result.op !== 'getItem') throw new Error('get')
    const item = got.result.item
    expect(item.bodyLock).toContain('멘션')
    expect(item.bodyLock).toContain('패널')
    const puts = () => h.fixture.requests.filter((request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20003').length
    const edited = await h.send({ op: 'updateItem', itemId: '20003', fields: { body: `${item.body ?? ''}\n\n덧붙임` }, ifVersion: null })
    expect(edited).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(puts()).toBe(0)
    const toggled = (item.body ?? '').replace('- [ ] 고치기', '- [x] 고치기')
    expect(toggled).not.toBe(item.body)
    expect((await h.send({ op: 'updateItem', itemId: '20003', fields: { body: toggled }, ifVersion: null })).ok).toBe(true)
    const sent = h.fixture.requests.filter((request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20003').at(-1)?.body
    const description = JSON.stringify(sent)
    expect(description).toContain('"type":"mention"')
    expect(description).toContain('"type":"panel"')
    expect(description).toContain('"localId":"ti-2","state":"DONE"')
    expect(description).toContain('"localId":"ti-1","state":"TODO"')
  })

  it('bodyUpdate — 같으면 보내지 않음 · 지원 표 안 바꿈은 새 ADF · 빈 본문은 null', () => {
    const doc = markdownToAdf('하나')
    expect(bodyUpdate({ current: doc, next: '하나' })).toEqual({ ok: true })
    expect(bodyUpdate({ current: doc, next: '둘' })).toMatchObject({ ok: true, doc: { type: 'doc' } })
    expect(bodyUpdate({ current: doc, next: '' })).toEqual({ ok: true, doc: null })
  })

  it('코멘트 읽기·쓰기도 같은 변환 — 보낸 본문은 ADF', async () => {
    const h = await connected()
    expect((await h.send({ op: 'addComment', itemId: '20001', body: '**굵게** 코멘트' })).ok).toBe(true)
    expect(JSON.stringify(h.fixture.requests.at(-1)?.body)).toContain('"type":"doc"')
    const listed = await h.send({ op: 'listComments', itemId: '20001' })
    expect(listed).toMatchObject({ ok: true, result: { comments: [{ body: '**굵게** 코멘트', author: 'Fixture User' }] } })
  })
})

describe('C7 순서·스페이스별 능력', () => {
  it('보드 있는 CORE 는 순서 켜짐, 보드 없는 WEB 는 흐림+이유 — 한 연결 안 두 스페이스가 다르다', async () => {
    const h = await connected()
    const spaces = await h.send({ op: 'listSpaces' })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    const of = (key: string) => spaces.result.op === 'listSpaces' ? spaces.result.spaces.find((space) => space.key === key)?.capabilities : undefined
    expect(of('CORE')).toEqual({})
    expect(of('WEB')).toEqual({ order: { state: 'disabled', reason: expect.stringContaining('보드가 없어') } })
    expect(h.service.settings().connections[0]?.spaces?.find((space) => space.key === 'WEB')?.capabilities.order?.state).toBe('disabled')
    const refused = await h.send({ op: 'reorder', itemId: '20101', afterId: null })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'unsupported' } })
    expect(h.fixture.requests.filter((request) => request.path === '/rest/agile/1.0/issue/rank')).toHaveLength(0)
  })

  it('Jira Software 없는 사이트(agile 404) — 모든 스페이스 순서 흐림', async () => {
    const harness = await jiraFixtureHarness()
    opened.push(harness)
    harness.fixture.agile = false
    const added = await harness.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
    if (!added.ok) throw new Error('add')
    expect(added.connection.spaces?.every((space) => space.capabilities.order?.state === 'disabled')).toBe(true)
  })

  it('Rank — afterId 기준 뒤 · null = 맨 앞 · 207 은 실패(양성 대조)', async () => {
    const h = await connected()
    expect((await h.send({ op: 'reorder', itemId: '20003', afterId: null })).ok).toBe(true)
    expect(h.fixture.requests.filter((request) => request.path === '/rest/agile/1.0/issue/rank').at(-1)?.body).toEqual({ issues: ['20003'], rankBeforeIssue: '20001' })
    h.fixture.corrupt = 'rank-207'
    const partial = await h.send({ op: 'reorder', itemId: '20001', afterId: '20002' })
    expect(partial).toMatchObject({ ok: false, error: { kind: 'rejected', status: 207 } })
    // R1-L 한 경로(2xx 본문)로 읽고 이슈별로 적는다 — 키 · 상태, 원격 글 없음.
    if (!partial.ok) { expect(partial.error.message).toContain('CORE-1(503)'); expect(partial.error.message).not.toContain('JIRA Agile'); expect(partial.error.maybeApplied).toBeUndefined() }
    h.fixture.corrupt = 'none'
    const rank = (request: { path: string }): boolean => request.path === '/rest/agile/1.0/issue/rank'
    h.fixture.faults.push({ match: rank, status: 207, body: { entries: [] }, once: true })
    expect(await h.send({ op: 'reorder', itemId: '20001', afterId: '20002' })).toMatchObject({ ok: false, error: { kind: 'rejected', status: 207 } })
    h.fixture.faults.push({ match: rank, status: 207, body: { entries: [{ issueId: 20001 }] }, once: true })
    expect(await h.send({ op: 'reorder', itemId: '20001', afterId: '20002' })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    h.fixture.faults.push({ match: rank, status: 207, body: { entries: [{ issueId: 20001, status: 200 }] }, once: true })
    expect(await h.send({ op: 'reorder', itemId: '20001', afterId: '20002' })).toMatchObject({ ok: true })
  })

  it('배치는 켜지 않는다 — 출처에 닿기 전 이유와 함께 거절', async () => {
    const h = await connected()
    const before = h.fixture.requests.length
    expect(await h.send({ op: 'setPlacement', itemId: '20001', placement: 'backlog', ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'unsupported' } })
    expect(h.fixture.requests.length).toBe(before)
  })
})

describe('R1-J 우선순위 로케일', () => {
  it('이름이 번역된 사이트 — 기본 id(1–5)로 읽고 쓴다 · 이름도 id 도 기본이 아니면 읽기 null · 쓰기 거절', async () => {
    const h = await connected()
    const names: Record<string, string> = { '1': '가장 높음', '2': '높음', '3': '보통', '4': '낮음', '5': '가장 낮음' }
    for (const priority of h.fixture.priorities) priority.name = names[priority.id] ?? priority.name
    const item = await h.send({ op: 'getItem', itemId: '20003' })
    if (!item.ok || item.result.op !== 'getItem') throw new Error('item')
    expect(item.result.item.priority).toBe('highest')
    expect(await h.send({ op: 'updateItem', itemId: '20003', fields: { priority: 'low' }, ifVersion: null })).toMatchObject({ ok: true })
    const put = h.fixture.requests.filter((request) => request.method === 'PUT' && request.path === '/rest/api/3/issue/20003').at(-1)
    expect(put?.body).toMatchObject({ fields: { priority: { id: '4' } } })
    // 사이트 고유 우선순위(id 도 이름도 기본 밖) — 지어내지 않는다.
    const fresh = await connected()
    fresh.fixture.priorities.splice(0, fresh.fixture.priorities.length, { id: '10100', name: 'P0' })
    expect(await fresh.send({ op: 'updateItem', itemId: '20003', fields: { priority: 'high' }, ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('high') } })
  })
})

describe('C8 생성 메타', () => {
  it('새 경로(종류별)만 · 시스템 필드 제외(보고자 포함 — R1-F, Jira 가 부른 사람으로 채운다) · 받는 칸 · 고르기 필드 · 하위 작업은 부모 필요', async () => {
    const h = await connected()
    const bug = await h.send({ op: 'getCreateMeta', spaceKey: 'CORE', kindKey: '10002' })
    expect(bug).toMatchObject({ ok: true, result: { meta: { accepts: { body: true, priority: true }, statusKeys: ['10000'], placement: 'ignored', fields: [{ key: 'customfield_10050', label: 'Severity', shape: 'option', options: [{ id: '10100', label: 'S1' }, { id: '10101', label: 'S2' }, { id: '10102', label: 'S3' }] }] } } })
    expect(await h.send({ op: 'getCreateMeta', spaceKey: 'CORE', kindKey: '10000' })).toMatchObject({ ok: true, result: { meta: { accepts: { body: true, priority: false }, fields: [] } } })
    expect(await h.send({ op: 'getCreateMeta', spaceKey: 'CORE', kindKey: '10003' })).toMatchObject({ ok: true, result: { meta: { unavailable: expect.stringContaining('자식 추가') } } })
    expect(h.fixture.requests.some((request) => request.path === '/rest/api/3/issue/createmeta/CORE/issuetypes/10002')).toBe(true)
    expect(h.fixture.legacyCalls()).toBe(0)
  })

  it('만들기 — 요청 본문에 요약·종류·부모·우선순위·필수 필드 값이 그대로, 하위 작업은 부모 아래에서만', async () => {
    const h = await connected()
    const created = await h.send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: '10002', title: '새 버그', body: '본문', priority: 'high', fields: [{ key: 'customfield_10050', value: '10101' }] })
    expect(created).toMatchObject({ ok: true, result: { item: { title: '새 버그', body: '본문', priority: 'high', statusKey: '10000' } } })
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path === '/rest/api/3/issue').at(-1)?.body).toMatchObject({ fields: { project: { key: 'CORE' }, issuetype: { id: '10002' }, summary: '새 버그', priority: { id: '2' }, customfield_10050: { id: '10101' }, description: { type: 'doc' } } })
    const child = await h.send({ op: 'createItem', spaceKey: 'CORE', parentId: '20002', kindKey: '10003', title: '하위' })
    expect(child).toMatchObject({ ok: true, result: { item: { parentId: '20002' } } })
    expect(await h.send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: '10003', title: '맨 위 하위' })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
  })

  it('자식 추가(T3 — 제목만)로 필수 필드가 있는 종류를 만들면 보내기 전 거절(POST 0) · 사유에 필드 이름 · 받지 않는 우선순위도 거절', async () => {
    const h = await connected()
    const posts = () => h.fixture.requests.filter((request) => request.method === 'POST' && request.path === '/rest/api/3/issue').length
    const child = await h.send({ op: 'createItem', spaceKey: 'CORE', parentId: '20001', kindKey: '10002', title: '제목만' })
    expect(child).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    if (!child.ok) expect(child.error.message).toContain('Severity')
    expect(await h.send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: '10000', title: '에픽', priority: 'high' })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(posts()).toBe(0)
  })

  it('만들기 응답 끊김 → 「만들어졌는지 모릅니다」 maybeApplied, 다시 보내지 않음', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.method === 'POST' && request.path === '/rest/api/3/issue', destroy: 'after', once: true })
    const lost = await h.send({ op: 'createItem', spaceKey: 'WEB', parentId: null, kindKey: '10004', title: '끊긴 만들기' })
    expect(lost).toMatchObject({ ok: false, error: { maybeApplied: true } })
    if (!lost.ok) expect(lost.error.message.startsWith('만들어졌는지 모릅니다')).toBe(true)
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path === '/rest/api/3/issue')).toHaveLength(1)
  })
})

describe('C9 이력·연결·부모', () => {
  it('historyMetadata 로 쓰기 id 가 이력에 되돌아온다 · 되돌아오지 않는 사이트면 writeId null(지어내지 않는다)', async () => {
    const h = await connected()
    expect((await h.send({ op: 'updateItem', itemId: '20002', fields: { title: '이력 제목' }, ifVersion: null })).ok).toBe(true)
    const sentMeta = h.fixture.requests.filter((request) => request.method === 'PUT').at(-1)?.body
    expect(sentMeta).toMatchObject({ historyMetadata: { extraData: { corralWriteId: expect.any(String) } } })
    const history = await h.send({ op: 'listHistory', itemId: '20002' })
    if (!history.ok || history.result.op !== 'listHistory') throw new Error('history')
    const title = history.result.entries.find((entry) => entry.field === 'title')
    expect(title?.writeId).not.toBeNull()
    h.fixture.echoHistory = false
    expect((await h.send({ op: 'changeStatus', itemId: '20002', statusKey: '10001', ifVersion: null })).ok).toBe(true)
    const again = await h.send({ op: 'listHistory', itemId: '20002' })
    if (!again.ok || again.result.op !== 'listHistory') throw new Error('history')
    expect(again.result.entries.find((entry) => entry.field === 'status')).toMatchObject({ from: 'To Do', to: 'In Progress', writeId: null })
  })

  it('연결 종류 이름 대응 — 사이트에 없는 종류는 이유와 함께 거절 · Cloners 처럼 대응 없는 연결은 보이지 않는다', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/issueLinkType', status: 200, body: { issueLinkTypes: [{ id: '1', name: 'Relates', inward: 'relates to', outward: 'relates to' }] }, once: true })
    const refused = await h.send({ op: 'addRelation', itemId: '20001', kind: 'blocks', otherKey: 'CORE-2' })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    h.fixture.links.push({ id: '777', typeId: '10003', inward: '20001', outward: '20002' })
    const item = await h.send({ op: 'getItem', itemId: '20001' })
    expect(item.ok && item.result.op === 'getItem' && item.result.item.relations?.some((relation) => relation.id === '777')).toBe(false)
  })

  it('스페이스를 넘는 부모 변경은 이유와 함께 거절(PUT 0)', async () => {
    const h = await connected()
    expect(await h.send({ op: 'setParent', itemId: '20101', spaceKey: 'CORE', parentId: '20001', ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(await h.send({ op: 'setParent', itemId: '20002', spaceKey: 'CORE', parentId: '20101', ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(h.fixture.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
  })
})

describe('C10·C11 작업 링크·쓰기 안전', () => {
  it('R1-H 작업 링크 저장 — 능력 꺼짐(이유) · 저장·지우기·자동 연결 모두 Jira 요청 0 · 단건은 remote link 를 읽지 않는다', async () => {
    const h = await connected()
    const caps = h.service.settings().connections[0]?.capabilities
    expect(caps?.workLinkStore).toEqual({ state: 'disabled', reason: expect.stringContaining('로컬 경로') })
    const before = h.fixture.requests.length
    const link = { kind: 'worktree' as const, path: '/Users/someone/repo/.claude/worktrees/CORE-1-pay', repoRoot: '/Users/someone/repo' }
    for (const action of ['save', 'remove'] as const) {
      expect(await h.service.storeLink({ connectionId: h.connectionId, itemId: '20001', link, action })).toEqual({ state: 'skipped', message: expect.stringContaining('로컬 경로') })
    }
    // 브랜치 키 자동 감지 경로(links.ts flushAutoStores → storeAutoLink) — 키 찾기조차 보내지 않는다.
    expect(await h.service.storeAutoLink({ connectionId: h.connectionId, key: 'CORE-1', link })).toEqual({ state: 'skipped', message: expect.stringContaining('로컬 경로') })
    expect(h.fixture.requests.slice(before)).toEqual([])
    const got = await h.send({ op: 'getItem', itemId: '20001' })
    expect(got).toMatchObject({ ok: true, result: { item: { workLinks: [] } } })
    expect(h.fixture.requests.some((request) => request.path.includes('remotelink'))).toBe(false)
  })

  it('동시 요청 상한 — 스무 개를 한꺼번에 보내도 fixture 가 본 동시 요청은 4 이하', async () => {
    const h = await connected()
    h.fixture.maxActive = 0
    h.fixture.faults.push({ match: (request) => request.path.startsWith('/rest/api/3/issue/') && request.method === 'GET', delayMs: 30 })
    await Promise.all(Array.from({ length: 20 }, () => h.send({ op: 'getItem', itemId: '20002' })))
    expect(h.fixture.maxActive).toBeLessThanOrEqual(4)
    expect(h.fixture.maxActive).toBeGreaterThan(1)
  })

  it('해제 뒤 늦은 응답은 덧씌우지 않는다(not_connected) · 닫힌 클라이언트는 더 보내지 않는다', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/issue/20002' && request.method === 'GET', delayMs: 80, once: true })
    const late = h.send({ op: 'getItem', itemId: '20002' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.service.removeConnection({ connectionId: h.connectionId })).toEqual({ ok: true })
    expect(await late).toMatchObject({ ok: false, error: { kind: 'not_connected' } })
  })
})
