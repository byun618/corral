// @vitest-environment happy-dom
// LIFE-605 — 작업 페이지·상세를 실제 WorkService + Jira 출처 + Jira REST fixture(공식 명세 모양, 127.0.0.1)에 이어 화면에서 본다.
// 화면은 출처 이름으로 분기하지 않는다 — 여기서 보는 차이(순서 흐림·완료 한 줄·막힌 전이·본문 잠금·질의 검색 안내)는 전부 능력·descriptor·작업 값에서 온다.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사에서 빼고 mixed 검사(tsconfig.mixed.json)에 둔다 — 선례 TaskDetail.service.test.tsx.
import { request as httpRequest } from 'node:http'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkSettingsState } from '../../../shared/work.js'
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
