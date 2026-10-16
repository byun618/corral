// @vitest-environment happy-dom
// LIFE-605 — 작업 페이지·상세를 실제 WorkService + Jira 출처 + Jira REST fixture(공식 명세 모양, 127.0.0.1)에 이어 화면에서 본다.
// 화면은 출처 이름으로 분기하지 않는다 — 여기서 보는 차이(순서 흐림·완료 한 줄·막힌 전이·본문 잠금·질의 검색 안내)는 전부 능력·descriptor·작업 값에서 온다.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사에서 빼고 mixed 검사(tsconfig.mixed.json)에 둔다 — 선례 TaskDetail.service.test.tsx.
import { request as httpRequest } from 'node:http'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkRequest, WorkSettingsState } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { JiraRestFixture } from '../../../main/work/jira-rest-fixture.js'
import { jiraSourceEntry } from '../../../main/work/jira-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FAKE_JIRA_EMAIL, FAKE_JIRA_TOKEN, FakeCipher, JIRA_ACCOUNT, MemoryStore } from '../../../main/work/test-kit.js'
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

async function rig({ spaceKey = 'CORE' }: { spaceKey?: string } = {}): Promise<Rig> {
  const server = new JiraRestFixture()
  fixture = server
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
    getUiPrefs: async () => ({ tasksPage: { space: { kind: 'space', connectionId, spaceKey } } }),
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
    await settle()
    expect(r.calls.some((call) => call.op === 'searchItems' && call.query === 'summary ~ "영수증"' && call.spaceKeys.join() === 'CORE')).toBe(true)
    expect(el('[data-search-hit="query"]').closest('[data-issue-row]')?.getAttribute('data-issue-row')).toBe('CORE-4')
    expect(q('[data-search-note]')).toBeNull()
    typeSearch('랜딩 ==')
    await settle()
    expect(el('[data-search-note]').textContent).toContain('텍스트')
    // 키 모양은 전과 같이 키 찾기(질의로 보내지 않는다).
    const before = r.calls.filter((call) => call.op === 'searchItems').length
    typeSearch('CORE-2')
    await settle()
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
})
