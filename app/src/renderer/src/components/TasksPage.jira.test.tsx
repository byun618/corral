// @vitest-environment happy-dom
// LIFE-605 — 작업 페이지·상세를 실제 WorkService + Jira 출처 + Jira REST fixture(공식 명세 모양, 127.0.0.1)에 이어 화면에서 본다.
// 화면은 출처 이름으로 분기하지 않는다 — 여기서 보는 차이(순서 흐림·완료 한 줄·막힌 전이·본문 잠금·질의 검색 안내)는 전부 능력·descriptor·작업 값에서 온다.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사에서 빼고 mixed 검사(tsconfig.mixed.json)에 둔다 — 선례 TaskDetail.service.test.tsx.
import { request as httpRequest } from 'node:http'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { JiraRestFixture } from '../../../main/work/jira-rest-fixture.js'
import { jiraSourceEntry } from '../../../main/work/jira-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FAKE_JIRA_EMAIL, FAKE_JIRA_TOKEN, FakeCipher, JIRA_ACCOUNT, MemoryStore } from '../../../main/work/test-kit.js'
import { SEARCH_DEBOUNCE_MS, looksLikeQuery, splitSearchCalls } from '../hooks/useTasksPage.js'
import { TasksPage } from './TasksPage.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let fixture: JiraRestFixture | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  vi.restoreAllMocks()
  act(() => root.unmount())
  host.remove()
  await fixture?.stop()
  fixture = null
})

/**
 * happy-dom 의 fetch 는 브라우저처럼 CORS 를 따져 127.0.0.1 fixture 응답을 막는다 — main 은 Node fetch 를 쓰므로 여기서는 node:http 로 같은 일을 한다.
 * 리다이렉트는 따라가지 않는다(node:http 는 원래 따라가지 않는다 — 제품의 `redirect: 'manual'` 과 같다).
 */
const nodeFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  const body = typeof init?.body === 'string' ? init.body : undefined
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', headers }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') responseHeaders.set(name, value)
        const status = incoming.statusCode ?? 500
        resolve(new Response(status === 204 ? null : Buffer.concat(chunks).toString('utf8'), { status, headers: responseHeaders }))
      })
      incoming.on('error', reject)
    })
    outgoing.on('error', reject)
    init?.signal?.addEventListener('abort', () => outgoing.destroy(new Error('aborted')))
    outgoing.end(body)
  })
}

type Rig = { service: WorkService; fixture: JiraRestFixture; calls: WorkCall[]; connectionId: string }

const settle = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
}

async function rig({ spaceKey = 'CORE', seed, all = false }: { spaceKey?: string; seed?: (server: JiraRestFixture) => void; all?: boolean } = {}): Promise<Rig> {
  const server = new JiraRestFixture()
  fixture = server
  seed?.(server)
  server.allow({ email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN })
  const url = await server.start()
  let seq = 0
  let listener: (value: WorkSettingsState) => void = () => {}
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), activity: new MemoryActivity(),
    sources: new WorkSourceRegistry([jiraSourceEntry({ baseUrlOf: () => url, sleep: async () => {}, fetchImpl: nodeFetch })]),
    repos: () => [], onChange: (value) => listener(value), now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
  if (!added.ok) throw new Error(`연결 실패: ${added.error.message}`)
  const connectionId = added.connection.id
  const result: Rig = { service, fixture: server, calls: [], connectionId }
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: { space: all ? { kind: 'all' } : { kind: 'space', connectionId, spaceKey } } }),
    setUiPrefs: () => {},
    getWorkSettings: async () => service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: (request: WorkRequest) => { result.calls.push(request.call); return service.request(request) },
    workActivity: async (query: unknown) => service.activity(query),
  })
  act(() => root.render(createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
  return result
}

const q = (selector: string): Element | null => document.querySelector(selector)
function el(selector: string): HTMLElement {
  const found = q(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`없음: ${selector}`)
  return found
}
function click(selector: string): void {
  const target = el(selector)
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function mouse(target: EventTarget, name: string, x = 10, y = 10): void {
  act(() => { target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) })
}
/** 끌기 시작 — 손잡이 mousedown → 문턱 넘는 move(놓을 영역은 elementFromPoint). 놓기는 부른 쪽이 mouseup. */
function startDrag({ handle, zone }: { handle: string; zone: string }): Element {
  const target = q(`[data-drop-zone="${zone}"]`)
  if (target === null) throw new Error(`끌기 대상 없음 ${zone}`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  mouse(el(handle), 'mousedown')
  mouse(document, 'mousemove', 50, 500)
  return target
}
/** 질의 검색은 입력이 멈춘 뒤에 간다(R1-D) — 디바운스를 넘겨 기다린다. */
const settleQuery = (): Promise<void> => settle(Math.ceil(SEARCH_DEBOUNCE_MS / 5) + 20)
function typeSearch(value: string): void {
  const input = el('[data-tasks-search]')
  if (!(input instanceof HTMLInputElement)) throw new Error('검색 칸')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('LIFE-605 작업 페이지 × Jira fixture', () => {
  it('목록 — CORE 카드가 보이고, 옛 경로 호출 0', async () => {
    const r = await rig()
    expect(q('[data-issue-card="CORE-1"]')).not.toBeNull()
    expect(q('[data-issue-card="CORE-4"]')).not.toBeNull()
    expect(r.fixture.legacyCalls()).toBe(0)
  })

  it('질의 검색 — JQL 모양이면 searchItems 로 찾아 「질의」 결과 · 거부되면 텍스트로 찾고 사유 줄(data-search-note)', async () => {
    const r = await rig()
    typeSearch('summary ~ "영수증"')
    await settleQuery()
    expect(r.calls.some((call) => call.op === 'searchItems' && call.query === 'summary ~ "영수증"' && call.spaceKeys.join() === 'CORE')).toBe(true)
    expect(el('[data-search-hit="query"]').closest('[data-issue-row]')?.getAttribute('data-issue-row')).toBe('CORE-4')
    expect(q('[data-search-note]')).toBeNull()
    typeSearch('랜딩 ==')
    await settleQuery()
    expect(el('[data-search-note]').textContent).toContain('텍스트')
    // 키 모양은 전과 같이 키 찾기(질의로 보내지 않는다).
    const before = r.calls.filter((call) => call.op === 'searchItems').length
    typeSearch('CORE-2')
    await settleQuery()
    expect(r.calls.some((call) => call.op === 'findByKey' && call.key === 'CORE-2')).toBe(true)
    expect(r.calls.filter((call) => call.op === 'searchItems')).toHaveLength(before)
  })

  it('상세 — 본문에 바꿀 수 없는 요소가 있으면 편집 전 안내 · 편집 흐림 · 체크 칸은 열려 있다', async () => {
    await rig()
    click('[data-issue-card="CORE-3"]')
    await settle()
    expect(el('[data-issue-body-lock]').textContent).toContain('멘션')
    expect(el('[data-issue-body-edit]').hasAttribute('disabled')).toBe(true)
    const check = q('[data-issue-body] input[type="checkbox"]')
    expect(check instanceof HTMLInputElement && !check.disabled).toBe(true)
    // 잠금 없는 작업은 안내 없음.
    click('[data-issue-card="CORE-1"]')
    await settle()
    expect(q('[data-issue-body-lock]')).toBeNull()
  })

  it('R4-B 상세 — 빈 문단이 든 본문은 편집하는 동안 「빈 줄 간격이 빠진다」 안내, 편집 전·빈 문단 없는 본문은 안내 없음', async () => {
    await rig({ seed: (server) => {
      const issue = server.issue('20001')
      if (issue !== null) issue.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '위' }] }, { type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: '아래' }] }] }
    } })
    click('[data-issue-card="CORE-1"]')
    await settle()
    expect(q('[data-issue-body-save-note]')).toBeNull()
    click('[data-issue-body-edit]')
    await settle()
    expect(el('[data-issue-body-save-note]').textContent).toContain('빈 줄 간격(빈 문단)이 빠집니다')
    click('[data-issue-card="CORE-2"]')
    await settle()
    click('[data-issue-body-edit]')
    await settle()
    expect(q('[data-issue-body-save-note]')).toBeNull()
  })

  it('상태 메뉴 — 완료는 갈래 없이 한 줄 · 필수 필드 전이는 흐린 행 + 이유(누를 수 없다)', async () => {
    const r = await rig()
    const moved = await r.service.request({ requestId: 'pre', connectionId: r.connectionId, call: { op: 'changeStatus', itemId: '20002', statusKey: '10001', ifVersion: null } })
    expect(moved.ok).toBe(true)
    await settle()
    click('[data-issue-card="CORE-2"]')
    await settle()
    click('[data-issue-status]')
    await settle()
    expect(el('[data-status-blocked="10005"]').textContent).toContain('Blocker reason')
    expect(q('[data-status-row="10005"]')).toBeNull()
    const before = r.fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/transitions')).length
    click('[data-status-blocked="10005"]')
    await settle()
    expect(r.fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/transitions'))).toHaveLength(before)
    // In Progress 에서 Done 으로 바로 가는 전이가 없는 워크플로 — 진행 중 → In Review 로 간 뒤 완료 행을 본다.
    click('[data-status-row="10002"]')
    await settle()
    click('[data-issue-status]')
    await settle()
    const doneRows = [...document.querySelectorAll('[data-status-row="10003"]')]
    expect(doneRows).toHaveLength(1)
    expect(doneRows[0]?.getAttribute('data-status-resolution')).toBe('')
  })

  it('R1-D 질의 검색 디바운스 — 이어 치는 동안은 보내지 않고, 멈춘 뒤 마지막 검색어 하나만 보낸다', async () => {
    const r = await rig()
    for (const value of ['status =', 'status = D', 'status = Do', 'status = Done']) {
      typeSearch(value)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
    expect(r.calls.filter((call) => call.op === 'searchItems')).toHaveLength(0)
    await settleQuery()
    const sent = r.calls.filter((call) => call.op === 'searchItems')
    expect(sent.map((call) => call.op === 'searchItems' ? call.query : '')).toEqual(['status = Done'])
  })

  it('R1-D 질의 모양 — `in (`·`is EMPTY`·`order by` 도 질의, 글자만은 글 · 스페이스 50 초과는 50개씩 나눠 보낸다', () => {
    const pattern = jiraSourceEntry({ baseUrlOf: () => 'http://127.0.0.1:1' }).descriptor.queryPattern
    for (const query of ['project in (CORE, WEB)', 'assignee is EMPTY', 'resolution IS NOT null', 'text ~ x order by created', 'status = Done']) expect(looksLikeQuery({ query, pattern })).toBe(true)
    for (const query of ['this is broken', 'login in progress', '영수증 정리', 'empty inbox']) expect(looksLikeQuery({ query, pattern })).toBe(false)
    // 질의 모양이 없는 출처(LA·모의)는 연산자가 든 글도 질의로 보내지 않는다(Y20 — T2 무회귀).
    for (const query of ['a = b', 'x < 3', 'summary ~ y']) expect(looksLikeQuery({ query, pattern: null })).toBe(false)
    const keys = Array.from({ length: 120 }, (_, index) => `P${index}`)
    const split = splitSearchCalls([{ connectionId: 'c1', call: { op: 'searchItems', spaceKeys: keys, query: 'a = b' } }, { connectionId: 'c2', call: { op: 'findByKey', key: 'A-1' } }])
    expect(split.map(({ call }) => call.op === 'searchItems' ? call.spaceKeys.length : call.op)).toEqual([50, 50, 20, 'findByKey'])
    expect(split.flatMap(({ call }) => call.op === 'searchItems' ? call.spaceKeys : [])).toEqual(keys)
  })

  it('R1-K 보드 끌기 — 보드 없는 스페이스(WEB)는 같은 칸 순서가 흐림 + 이유, 놓아도 rank 0', async () => {
    const r = await rig({
      spaceKey: 'WEB',
      seed: (server) => {
        const web = server.issue('20101')
        if (web === null) throw new Error('seed')
        server.issues.push({ ...web, id: '20102', key: 'WEB-2', summary: '랜딩 두 번째', rank: 2 })
      },
    })
    const column = el('[data-issue-card="WEB-1"]').closest('[data-board-column]')
    const zone = column?.querySelector('[data-drop-zone]')?.getAttribute('data-drop-zone')
    if (column === null || column === undefined || zone === null || zone === undefined) throw new Error('칸')
    startDrag({ handle: '[data-issue-card="WEB-1"]', zone })
    await settle()
    expect(column.classList.contains('drag-blocked')).toBe(true)
    expect(column.querySelector('[data-column-reason]')?.textContent).toContain('순서를 바꿀 수 없습니다')
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(r.calls.filter((call) => call.op === 'reorder')).toHaveLength(0)
    expect(r.fixture.requests.filter((request) => request.path === '/rest/agile/1.0/issue/rank')).toHaveLength(0)
  })

  it('R1-K 보드 끌기 양성 대조 — 보드 있는 CORE 는 같은 칸 순서가 열려 있다', async () => {
    await rig()
    const column = el('[data-issue-card="CORE-1"]').closest('[data-board-column]')
    const zone = column?.querySelector('[data-drop-zone]')?.getAttribute('data-drop-zone')
    if (column === null || column === undefined || zone === null || zone === undefined) throw new Error('칸')
    startDrag({ handle: '[data-issue-card="CORE-1"]', zone })
    await settle()
    expect(column.classList.contains('drag-blocked')).toBe(false)
    mouse(document, 'mouseup', 50, 500)
    await settle()
  })

  it('R2-J 스페이스 50 초과로 나눠 보낸 질의가 같은 연결에서 다른 안내를 두 줄 내도 React key 가 겹치지 않는다', async () => {
    const errors = vi.spyOn(console, 'error')
    const r = await rig({
      all: true,
      seed: (server) => {
        const web = server.projects.find((project) => project.key === 'WEB')
        if (web === undefined) throw new Error('seed')
        for (let index = 0; index < 50; index += 1) server.projects.push({ ...web, id: String(30000 + index), key: `P${String(index).padStart(2, '0')}`, name: `P${index}` })
        const jql = (request: { path: string; query: Record<string, string> }, key: string): boolean => request.path === '/rest/api/3/search/jql' && (request.query.jql ?? '').includes('AND (status') && (request.query.jql ?? '').includes(`"${key}"`)
        server.faults.push({ match: (request) => jql(request, 'CORE'), status: 400, body: { errorMessages: ['첫 묶음 사유'] }, once: true })
        server.faults.push({ match: (request) => jql(request, 'WEB'), status: 400, body: { errorMessages: ['둘째 묶음 사유'] }, once: true })
      },
    })
    typeSearch('status = Done')
    await settleQuery()
    const sent = r.calls.filter((call) => call.op === 'searchItems')
    expect(sent.length).toBe(2)
    const notes = [...document.querySelectorAll('[data-search-note]')].map((node) => node.textContent ?? '')
    expect(notes).toHaveLength(2)
    expect(notes.some((text) => text.includes('첫 묶음 사유')) && notes.some((text) => text.includes('둘째 묶음 사유'))).toBe(true)
    expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
  })
})

// LIFE-623 R2-B — 쓰기 뒤 단건 GET 한 번이 `description`·`issuelinks` 를 빼고 오면(부분 응답) 그 값을 빈 정본으로 만들지 않는다:
// 화면 본문이 빈 본문으로 바뀌지 않고, 새로 연 편집기·저장이 서버 본문을 지우지 않는다(리뷰 r2 X2-2, `codex-r2-raw/TasksPage.x2jira.test.tsx` 이식).
it('LIFE-623 R2-B 쓰기 뒤 부분 응답(description·issuelinks 없음)은 빈 정본이 아니다 — 화면·저장이 서버 본문을 지우지 않는다', async () => {
  const live = { type: 'doc' as const, version: 1 as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'LIVE JIRA BODY' }] }] }
  const r = await rig({ seed: (server) => { const issue = server.issues.find((entry) => entry.id === '20002'); if (issue !== undefined) issue.description = live } })
  click('[data-tasks-board] [data-issue-card="CORE-2"]')
  await settle(30)
  expect(el('[data-issue-body]').textContent).toContain('LIVE JIRA BODY')
  r.fixture.omitOnce.set('20002', ['description', 'issuelinks'])
  click('[data-field="priority"]')
  click('[data-priority-row="highest"]')
  await settle(30)
  expect(r.fixture.omitOnce.has('20002')).toBe(false)
  expect(el('[data-issue-body]').textContent).toContain('LIVE JIRA BODY')
  click('[data-issue-body-edit]')
  const editor = q('[data-md-editor] textarea')
  expect(editor instanceof HTMLTextAreaElement ? editor.value : null).toBe('LIVE JIRA BODY')
  click('[data-md-save]')
  await settle(30)
  expect(r.fixture.issues.find((entry) => entry.id === '20002')?.description).not.toBeNull()
  expect(JSON.stringify(r.fixture.issues.find((entry) => entry.id === '20002')?.description)).toContain('LIVE JIRA BODY')
})

// LIFE-623 R3-B — 잠긴 서식 본문(멘션·패널, CORE-3)의 체크 칸 하나를 누를 때, 저장 전 조회 응답에 description 칸이 빠지면 PUT 을 보내지 않는다(원본 ADF 유지).
// 정상 응답이면 전처럼 PUT 1회·멘션·패널 보존(리뷰 r3 X3-2, `codex-r3-raw/TasksPage.x3-safety.test.tsx` 이식).
it.each([false, true])('LIFE-623 R3-B 잠긴 본문 체크 칸 — 저장 전 조회 description 누락=%s 이면 PUT 0, 원본 서식 유지', async (omit) => {
  const r = await rig()
  click('[data-tasks-board] [data-issue-card="CORE-3"]')
  await settle(25)
  expect(el('[data-issue-body-lock]').textContent).toContain('멘션')
  const issue = r.fixture.issues.find((entry) => entry.id === '20003')
  if (issue === undefined) throw new Error('fixture')
  const before = JSON.stringify(issue.description)
  expect(before).toContain('mention')
  expect(before).toContain('panel')
  if (omit) r.fixture.omitOnce.set(issue.id, ['description'])
  const count = r.fixture.requests.length
  const check = document.querySelectorAll('[data-issue-body] input[type="checkbox"]')[1]
  if (!(check instanceof HTMLInputElement)) throw new Error('체크 칸 없음')
  expect(check.disabled).toBe(false)
  act(() => { check.click() })
  await settle(30)
  const after = JSON.stringify(issue.description)
  expect(r.fixture.requests.slice(count).filter((request) => request.method === 'PUT')).toHaveLength(omit ? 0 : 1)
  expect(after.includes('mention')).toBe(true)
  expect(after.includes('panel')).toBe(true)
  if (omit) expect(after).toBe(before)
})

// LIFE-623 R4-A — 쓰기가 「적용됐을 수 있음」(`invalid_response` + `maybeApplied`)으로 끝나면 상세도 정본을 확보하지 못한 것이다:
// 미확인으로 두고 단건을 다시 읽으며, 받기 전에는 본문 편집이 막힌다. 받은 뒤 새 편집기·저장은 외부가 바꾼 서버 본문 그대로(리뷰 r4 X4-1,
// `codex-r4-raw/probes/TasksPage.x4partial.test.tsx` 이식 — 쓰기 뒤 GET 한 번만 description·issuelinks 를 뺀다).
const OLD_JIRA = { type: 'doc' as const, version: 1 as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'OLD JIRA BODY' }] }] }
const NEW_JIRA = { type: 'doc' as const, version: 1 as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'NEW EXTERNAL BODY' }] }] }
type ExternalMode = 'unchanged' | 'cleared' | 'replaced' | 'filled'
/** CORE-2 를 열고(이전 본문) 외부에서 본문을 바꾼다. 서버의 바뀐 본문을 돌려준다. */
async function openExternal({ mode }: { mode: ExternalMode }): Promise<{ r: Rig; issue: JiraRestFixture['issues'][number]; canonical: unknown }> {
  const r = await rig({ seed: (server) => { const found = server.issues.find((entry) => entry.id === '20002'); if (found !== undefined) found.description = mode === 'filled' ? null : OLD_JIRA } })
  click('[data-tasks-board] [data-issue-card="CORE-2"]')
  await settle(30)
  const issue = r.fixture.issues.find((entry) => entry.id === '20002')
  if (issue === undefined) throw new Error('fixture')
  if (mode === 'cleared') issue.description = null
  if (mode === 'replaced' || mode === 'filled') issue.description = NEW_JIRA
  return { r, issue, canonical: structuredClone(issue.description) }
}
/** `after` 연산의 응답이 돌아온 뒤 첫 단건 읽기(상세 재조회)를 풀 때까지 붙든다. 붙든 단건 수를 센다. */
function holdReadAfter(after: WorkCall['op']): { release: () => Promise<void>; held: () => number } {
  const original = window.corral.workRequest
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  let armed = false
  let held = 0
  window.corral.workRequest = async (request: WorkRequest) => {
    if (armed && request.call.op === 'getItem') { held += 1; await pending }
    const response = await original(request)
    if (request.call.op === after) armed = true
    return response
  }
  return { release: async () => { release(); await settle(30) }, held: () => held }
}
const bodyEditDisabled = (): boolean => { const button = el('[data-issue-body-edit]'); return button instanceof HTMLButtonElement && button.disabled }
/** 막힘이 풀린 뒤 새 편집기 → 그대로 저장 — 편집기 초기값과 저장 뒤 서버 본문. */
async function saveFresh(issue: JiraRestFixture['issues'][number]): Promise<{ editor: string | null; server: unknown }> {
  click('[data-issue-body-edit]')
  const editor = q('[data-md-editor] textarea')
  const value = editor instanceof HTMLTextAreaElement ? editor.value : null
  click('[data-md-save]')
  await settle(30)
  return { editor: value, server: issue.description }
}

it.each((['unchanged', 'cleared', 'replaced', 'filled'] as const).flatMap((mode) => [false, true].map((omit) => ({ mode, omit }))))('LIFE-623 R4-A 즉시 상세 쓰기 — 외부 $mode · 부분 응답=$omit 이면 미확인·재조회 뒤 저장이 서버 본문을 덮지 않는다', async ({ mode, omit }) => {
  const { r, issue, canonical } = await openExternal({ mode })
  if (omit) r.fixture.omitOnce.set('20002', ['description', 'issuelinks'])
  const gate = holdReadAfter('updateItem')
  const outcomes: unknown[] = []
  const request = window.corral.workRequest
  window.corral.workRequest = async (value: WorkRequest) => { const out = await request(value); if (value.call.op === 'updateItem') outcomes.push(out.ok ? 'ok' : out.error.maybeApplied === true ? 'maybeApplied' : 'failed'); return out }
  click('[data-field="priority"]')
  click('[data-priority-row="highest"]')
  await settle(30)
  expect(outcomes).toEqual([omit ? 'maybeApplied' : 'ok'])
  // 적용됐을 수 있는 실패면 단건 재조회 1회가 나가고, 받는 동안 본문 편집은 막힌다. 정상이면 재조회 없음·막힘 없음.
  expect(gate.held()).toBe(omit ? 1 : 0)
  expect(bodyEditDisabled()).toBe(omit)
  await gate.release()
  expect(bodyEditDisabled()).toBe(false)
  const saved = await saveFresh(issue)
  expect(saved.server).toEqual(canonical)
})

// R4-A 늦은 실패 — 30초 넘어 온 「적용됐을 수 있음」 실패도 같은 미확인·재조회(늦은 일반 실패의 재조회와 겹치지 않고 1회).
it.each(['cleared', 'replaced'] as const)('LIFE-623 R4-A 늦은 상세 쓰기 실패(maybeApplied) — 외부 %s 뒤 재조회 1회·막힘, 저장이 서버 본문을 덮지 않는다', async (mode) => {
  const { r, issue, canonical } = await openExternal({ mode })
  r.fixture.omitOnce.set('20002', ['description', 'issuelinks'])
  const gate = holdReadAfter('updateItem')
  const original = window.corral.workRequest
  let deliver: () => void = () => {}
  const delivery = new Promise<void>((resolve) => { deliver = resolve })
  const box: { late: WorkResponse | null } = { late: null }
  window.corral.workRequest = async (value: WorkRequest) => {
    const response = await original(value)
    if (value.call.op === 'updateItem' && box.late === null) { box.late = response; await delivery }
    return response
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]')
  click('[data-priority-row="highest"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers()
  await settle(30)
  const late = box.late
  expect(late !== null && !late.ok && late.error.maybeApplied === true).toBe(true)
  expect(gate.held()).toBe(0)
  await act(async () => { deliver() })
  await settle(30)
  expect(gate.held()).toBe(1)
  expect(bodyEditDisabled()).toBe(true)
  await gate.release()
  expect(bodyEditDisabled()).toBe(false)
  const saved = await saveFresh(issue)
  expect(saved.server).toEqual(canonical)
})

// R4-A 보드 쓰기 — 상세가 열린 채 보드 상태 변경이 「적용됐을 수 있음」 으로 실패해도 상세는 미확인·재조회.
it.each(['cleared', 'replaced'] as const)('LIFE-623 R4-A 상세가 열린 채 보드 쓰기 실패(maybeApplied) — 외부 %s 뒤 재조회 1회·막힘, 저장이 서버 본문을 덮지 않는다', async (mode) => {
  const { r, issue, canonical } = await openExternal({ mode })
  r.fixture.omitOnce.set('20002', ['description', 'issuelinks'])
  const gate = holdReadAfter('changeStatus')
  const zone = [...document.querySelectorAll('[data-tasks-board] [data-drop-zone^="col:"]')].map((entry) => entry.getAttribute('data-drop-zone')).find((value) => value !== null && el('[data-tasks-board] [data-issue-card="CORE-2"]').closest(`[data-board-column]`)?.querySelector(`[data-drop-zone="${value}"]`) === null)
  if (zone === undefined || zone === null) throw new Error('다른 칸 없음')
  const statusBefore = issue.statusId
  startDrag({ handle: '[data-tasks-board] [data-issue-card="CORE-2"]', zone })
  await settle()
  mouse(document, 'mousemove', 52, 502)
  mouse(document, 'mouseup', 52, 502)
  await settle(30)
  expect(r.calls.filter((call) => call.op === 'changeStatus')).toHaveLength(1)
  expect(issue.statusId).not.toBe(statusBefore)
  expect(gate.held()).toBe(1)
  expect(bodyEditDisabled()).toBe(true)
  await gate.release()
  expect(bodyEditDisabled()).toBe(false)
  const saved = await saveFresh(issue)
  expect(saved.server).toEqual(canonical)
})

// R4-A 늦은 실패 + 재조회 거절 — 늦은 일반 실패의 재조회(R1-C)는 실패하면 옛 base 를 편집 기준으로 남겼다. 적용됐을 수 있는 실패는 미확인이라
// 재조회가 실패해도 막힘 + 「다시 시도」, 다시 받은 뒤에야 저장한다.
it('LIFE-623 R4-A 늦은 상세 쓰기 실패(maybeApplied) + 재조회 거절 — 막힘·오류 표시, 다시 시도 뒤 저장이 외부 비우기를 덮지 않는다', async () => {
  const { r, issue, canonical } = await openExternal({ mode: 'cleared' })
  r.fixture.omitOnce.set('20002', ['description', 'issuelinks'])
  const original = window.corral.workRequest
  let deliver: () => void = () => {}
  const delivery = new Promise<void>((resolve) => { deliver = resolve })
  const box: { late: WorkResponse | null; refuse: boolean } = { late: null, refuse: false }
  window.corral.workRequest = async (value: WorkRequest) => {
    if (box.refuse && value.call.op === 'getItem') { box.refuse = false; return { requestId: value.requestId, connectionId: value.connectionId, ok: false, error: { kind: 'rejected', message: 'fixture reconcile refused', status: null } } }
    const response = await original(value)
    if (value.call.op === 'updateItem' && box.late === null) { box.late = response; box.refuse = true; await delivery }
    return response
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]')
  click('[data-priority-row="highest"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers()
  await settle(30)
  const late = box.late
  expect(late !== null && !late.ok && late.error.maybeApplied === true).toBe(true)
  await act(async () => { deliver() })
  await settle(30)
  expect(box.refuse).toBe(false)
  expect(bodyEditDisabled()).toBe(true)
  expect(q('[data-issue-load-error]')).not.toBeNull()
  click('[data-issue-retry]')
  await settle(30)
  expect(bodyEditDisabled()).toBe(false)
  expect(q('[data-issue-load-error]')).toBeNull()
  const saved = await saveFresh(issue)
  expect(saved.server).toEqual(canonical)
})

// LIFE-632 C1 — 미확인 경계(R5-A). 623 리뷰 r5 `codex-r5-raw/probes/TasksPage.x5probe.test.tsx` 이식.
// 「적용됐을 수 있음」 실패 B 로 상세가 미확인이 된 뒤, 그보다 **먼저** 보낸 쓰기 A 의 늦은 성공·먼저 시작한 최초 단건 읽기가 도착해도
// 막힘·오류를 풀지 않고 base 가 되지 않는다(옛 본문으로 외부 비우기를 되살리지 않는다). 경계 **뒤** 근거(재조회·쓰기 확정)는 푼다(양성 대조).
/** 다른 상태 칸 하나(CORE-2 가 없는 칸). */
function otherZone(): string {
  const zone = [...document.querySelectorAll('[data-tasks-board] [data-drop-zone^="col:"]')].map((entry) => entry.getAttribute('data-drop-zone')).find((value) => value !== null && el('[data-tasks-board] [data-issue-card="CORE-2"]').closest('[data-board-column]')?.querySelector(`[data-drop-zone="${value}"]`) === null)
  if (zone === undefined || zone === null) throw new Error('다른 칸 없음')
  return zone
}
const loadError = (): string | null => q('[data-issue-load-error]')?.textContent ?? null
const reread400 = (r: Rig): void => { r.fixture.faults.push({ match: (value) => value.method === 'GET' && value.path === '/rest/api/3/issue/20002', status: 400 }) }

it.each([false, true])('LIFE-632 C1 ① 옛 쓰기 A 의 늦은 성공 — 더 새 B 가 미확인(재조회 거절=%s)이면 A 가 막힘·오류를 풀지 않고 외부 비우기를 되살리지 않는다', async (failRead) => {
  const { r, issue } = await openExternal({ mode: 'unchanged' })
  const original = window.corral.workRequest
  let deliver: () => void = () => {}
  const delivery = new Promise<void>((resolve) => { deliver = resolve })
  const box: { a: WorkResponse | null; b: WorkResponse | null } = { a: null, b: null }
  window.corral.workRequest = async (value: WorkRequest) => {
    const response = await original(value)
    if (value.call.op === 'updateItem' && value.call.fields.priority === 'highest' && box.a === null) { box.a = response; await delivery }
    if (value.call.op === 'updateItem' && value.call.fields.priority === 'low') { box.b = response; if (failRead) reread400(r) }
    return response
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]'); click('[data-priority-row="highest"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers(); await settle(30)
  expect(box.a !== null && box.a.ok).toBe(true)
  // 외부가 본문을 비운 뒤 B — 쓰기는 적용, 뒤 GET 부분 응답이라 maybeApplied.
  issue.description = null
  r.fixture.omitOnce.set('20002', ['description', 'issuelinks'])
  click('[data-field="priority"]'); click('[data-priority-row="low"]')
  await settle(30)
  const b = box.b
  expect(b !== null && !b.ok && b.error.maybeApplied === true).toBe(true)
  expect(bodyEditDisabled()).toBe(failRead)
  // 양성 대조 ⓐ — 경계 뒤 시작한 재조회가 성공하면(거절 아님) 막힘이 풀리고 빈 본문이 base.
  if (!failRead) expect(el('[data-issue-body]').textContent).not.toContain('OLD JIRA BODY')
  await act(async () => { deliver() }); await settle(30)
  if (failRead) {
    // A(경계 전 보냄)의 늦은 성공은 미확인을 풀지 않는다 — 막힘·오류 그대로, 옛 본문을 base 로 올리지 않는다.
    expect(bodyEditDisabled()).toBe(true)
    expect(loadError()).not.toBeNull()
    r.fixture.faults.length = 0
    click('[data-issue-retry]'); await settle(30)
  }
  expect(bodyEditDisabled()).toBe(false)
  expect(loadError()).toBeNull()
  const saved = await saveFresh(issue)
  expect(saved.editor).toBe('')
  expect(issue.description).toBeNull()
})

it('LIFE-632 C1 ② 옛 최초 읽기 — 미확인 전에 시작한 최초 단건 GET 이 늦게 와도 막힘·오류를 풀지 않는다, 다시 시도 뒤 빈 본문', async () => {
  const { r, issue } = await openExternal({ mode: 'unchanged' })
  const original = window.corral.workRequest
  let runWrite: () => void = () => {}
  const writeGate = new Promise<void>((resolve) => { runWrite = resolve })
  let deliverRead: () => void = () => {}
  const readGate = new Promise<void>((resolve) => { deliverRead = resolve })
  const box: { capture: boolean; captured: boolean; oldRead: string | null; failed: WorkResponse | null } = { capture: false, captured: false, oldRead: null, failed: null }
  window.corral.workRequest = async (value: WorkRequest) => {
    const heldWrite = value.call.op === 'updateItem' && value.call.fields.priority === 'highest'
    if (heldWrite) await writeGate
    const response = await original(value)
    if (box.capture && value.call.op === 'getItem' && value.call.itemId === '20002' && !box.captured) {
      box.captured = true
      if (response.ok && response.result.op === 'getItem') box.oldRead = response.result.item.body
      await readGate
    }
    if (heldWrite) { box.failed = response; reread400(r) }
    return response
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]'); click('[data-priority-row="highest"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers(); await settle(20)
  // 다시 연다 — 최초 단건 GET 이 옛 본문을 읽은 채 배달을 붙든다.
  click('[data-issue-close]'); await settle(10)
  box.capture = true
  click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle(20)
  expect(box.captured).toBe(true)
  expect(box.oldRead).toBe('OLD JIRA BODY')
  issue.description = null
  r.fixture.omitOnce.set('20002', ['description', 'issuelinks'])
  await act(async () => { runWrite() }); await settle(30)
  const failed = box.failed
  expect(failed !== null && !failed.ok && failed.error.maybeApplied === true).toBe(true)
  expect(loadError()).not.toBeNull()
  await act(async () => { deliverRead() }); await settle(30)
  expect(bodyEditDisabled()).toBe(true)
  expect(loadError()).not.toBeNull()
  r.fixture.faults.length = 0
  click('[data-issue-retry]'); await settle(30)
  expect(bodyEditDisabled()).toBe(false)
  const saved = await saveFresh(issue)
  expect(saved.editor).toBe('')
  expect(issue.description).toBeNull()
})

it('LIFE-632 C1 양성 대조 ⓑ — 경계 뒤 보낸 쓰기(보드 상태 변경)의 확정은 미확인을 푼다, 저장은 빈 본문', async () => {
  const { r, issue } = await openExternal({ mode: 'unchanged' })
  const original = window.corral.workRequest
  window.corral.workRequest = async (value: WorkRequest) => {
    const response = await original(value)
    if (value.call.op === 'updateItem' && value.call.fields.priority === 'low') reread400(r)
    return response
  }
  issue.description = null
  r.fixture.omitOnce.set('20002', ['description', 'issuelinks'])
  click('[data-field="priority"]'); click('[data-priority-row="low"]')
  await settle(30)
  expect(bodyEditDisabled()).toBe(true)
  expect(loadError()).not.toBeNull()
  r.fixture.faults.length = 0
  startDrag({ handle: '[data-tasks-board] [data-issue-card="CORE-2"]', zone: otherZone() })
  await settle()
  mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502)
  await settle(30)
  expect(bodyEditDisabled()).toBe(false)
  expect(loadError()).toBeNull()
  const saved = await saveFresh(issue)
  expect(saved.editor).toBe('')
  expect(issue.description).toBeNull()
})

// LIFE-632 C4 — 첫 읽기 복구(R5-C). 623 리뷰 r5 `probes/TasksPage.x5initial.test.tsx` 이식. 첫 단건 GET 이 실패한 뒤 같은 카드의 보드 상태 변경이 성공하면
// 상세는 그 값을 받는다 — 그때 부가 읽기(상태 목록·자식·부모·활동)가 이어져 정상 최초 읽기와 같은 화면이 된다(「다시 시도」 없이 메뉴 0·자식 0 으로 남지 않는다).
it.each([false, true])('LIFE-632 C4 첫 단건 실패=%s 뒤 보드 성공 — 상태 메뉴·자식·상태 라벨이 정상 최초 읽기와 같다', async (failed) => {
  const r = await rig()
  if (failed) r.fixture.faults.push({ match: (value) => value.method === 'GET' && value.path === '/rest/api/3/issue/20002', status: 400, once: true })
  click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle(30)
  expect(loadError() !== null).toBe(failed)
  startDrag({ handle: '[data-tasks-board] [data-issue-card="CORE-2"]', zone: otherZone() })
  await settle()
  mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502)
  await settle(30)
  expect(bodyEditDisabled()).toBe(false)
  click('[data-issue-status]'); await settle(30)
  const shown = { statusRows: document.querySelectorAll('[data-status-row]').length, children: document.querySelectorAll('[data-child-row]').length, status: q('[data-issue-status]')?.textContent ?? null }
  // 정상 대조 값(623 r5 `x5-initial-recovery.log` failed=false): 상태 행 3 · 자식 1 · 「In Progress▾」.
  expect(shown).toEqual({ statusRows: 3, children: 1, status: 'In Progress▾' })
  expect(loadError()).toBeNull()
})
