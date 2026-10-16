// LIFE-605 — Jira Cloud 출처 단위·fixture 시험(계약 묶음 밖의 Jira 사정). 기준 C1·C2·C4–C11 의 「빠른」 칸.
// 자격은 가짜만(`test-kit.ts`). 요청 수·본문은 fixture 의 `requests`(자격 없음)로 본다.
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkResponse } from '../../shared/work.js'
import { basicHeader, errorText, JiraHttp, parseRetryAfter } from './jira-http.js'
import { JiraRestFixture } from './jira-rest-fixture.js'
import { bodyUpdate, checkJiraAccount, jiraFixtureBaseFromEnv, jiraSourceEntry, jqlString, normalizeJiraSite, splitOrderBy, textSearchWords, transitionPlan } from './jira-source.js'
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
    expect(write).toMatchObject({ ok: false, error: { kind: 'network', status: 429, maybeApplied: true } })
    expect(h.fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/comment'))).toHaveLength(1)
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
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/issue/20001', status: 302, headers: { Location: 'https://evil.example/steal' }, once: true })
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

  it('모르는 분류 키는 어느 분류로도 넣지 않는다 — 그 스페이스 응답 어긋남', async () => {
    const h = await connected()
    h.fixture.corrupt = 'unknown-category'
    const refused = await h.send({ op: 'listStatuses', spaceKey: 'WEB' })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    if (!refused.ok) expect(refused.error.message).toContain('분류')
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

  it('R1-E 오프셋 쪽(프로젝트 목록)이 빈 쪽인데 「더 있음」 이면 응답 어긋남 — 조용히 자르지 않는다', async () => {
    const h = await connected()
    h.fixture.faults.push({ match: (request) => request.path === '/rest/api/3/project/search', status: 200, body: { values: [], isLast: false, startAt: 0, maxResults: 2, total: 9 } })
    expect(await h.send({ op: 'listSpaces' })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
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
    expect(await h.send({ op: 'reorder', itemId: '20001', afterId: '20002' })).toMatchObject({ ok: false, error: { kind: 'rejected', status: 207 } })
  })

  it('배치는 켜지 않는다 — 출처에 닿기 전 이유와 함께 거절', async () => {
    const h = await connected()
    const before = h.fixture.requests.length
    expect(await h.send({ op: 'setPlacement', itemId: '20001', placement: 'backlog', ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'unsupported' } })
    expect(h.fixture.requests.length).toBe(before)
  })
})

describe('C8 생성 메타', () => {
  it('새 경로(종류별)만 · 시스템 필드 제외 · 기본값 있는 필수 제외 · 받는 칸 · 고르기 필드 · 하위 작업은 부모 필요', async () => {
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
