// @vitest-environment happy-dom
// Jira 완료 시각(`statuscategorychangedate` → doneAt)이 화면까지 — 보드·백로그 14일 숨김(LIFE-702 규칙)과 상세 「완료」 행.
// 실제 경로 React `TasksPage` → hook → `WorkService` → Jira 출처 → REST fixture(127.0.0.1, node:http). 시계는 Date 만 고정한다.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사에서 빼고 mixed 검사에 둔다(선례 `TasksPage.jira.test.tsx`).
import { request as httpRequest } from 'node:http'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkResponse } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { JIRA_FIXTURE_IDS, JiraRestFixture } from '../../../main/work/jira-rest-fixture.js'
import { jiraSourceEntry } from '../../../main/work/jira-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FAKE_JIRA_EMAIL, FAKE_JIRA_TOKEN, FakeCipher, JIRA_ACCOUNT, MemoryStore } from '../../../main/work/test-kit.js'
import { SEARCH_DEBOUNCE_MS } from '../hooks/useTasksPage.js'
import { TasksPage } from './TasksPage.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const NOW = Date.parse('2026-10-28T03:00:00.000Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
function localDate(ms: number): string {
  const date = new Date(ms)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0')).join('-')
}
/** 행 글 기대값 — fixture 시계(2026-10-10 근처)는 NOW 보다 14일 넘게 앞이라 숨김 표시가 붙는다. 경계는 `DONE_HIDE_MS` 와 따로 적은 14일. */
const rowText = (ms: number): string => `${localDate(ms)}${NOW - ms >= 14 * DAY ? ' · 보드에서 숨김' : ''}`

let host: HTMLDivElement
let root: Root
let fixture: JiraRestFixture | null = null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  act(() => { toast.dismiss() })
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await fixture?.stop()
  fixture = null
})

/** happy-dom fetch 는 CORS 로 127.0.0.1 응답을 막는다 — main 처럼 node:http 로(`TasksPage.jira.test.tsx` 와 같은 이유). */
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

const settle = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
}

type Rig = { fixture: JiraRestFixture; calls: WorkCall[] }

async function rig({ seed }: { seed?: (server: JiraRestFixture) => void } = {}): Promise<Rig> {
  const server = new JiraRestFixture()
  fixture = server
  seed?.(server)
  server.allow({ email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN })
  const url = await server.start()
  let seq = 0
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), activity: new MemoryActivity(),
    sources: new WorkSourceRegistry([jiraSourceEntry({ baseUrlOf: () => url, sleep: async () => {}, fetchImpl: nodeFetch })]),
    repos: () => [], onChange: () => {}, now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
  if (!added.ok) throw new Error(`연결 실패: ${added.error.message}`)
  const connectionId = added.connection.id
  const calls: WorkCall[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: { space: { kind: 'space', connectionId, spaceKey: 'CORE' } } }),
    setUiPrefs: () => {},
    getWorkSettings: async () => service.settings(),
    onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => { calls.push(request.call); return service.request(request) },
    workActivity: async (query: unknown) => service.activity(query),
  })
  act(() => root.render(createElement('div', null, createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
  await settle(20)
  return { fixture: server, calls }
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
const boardCards = (): string[] => [...document.querySelectorAll('[data-tasks-board] [data-issue-card]')].map((card) => card.getAttribute('data-issue-card') ?? '').sort()
const doneCell = (): HTMLElement | null => {
  const found = q('[data-issue-fields] [data-field="done-at"]')
  return found instanceof HTMLElement ? found : null
}
async function typeSearch(value: string): Promise<void> {
  const input = el('[data-tasks-search]')
  if (!(input instanceof HTMLInputElement)) throw new Error('검색 칸')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(Math.ceil(SEARCH_DEBOUNCE_MS / 5) + 20)
}
async function openFromList(itemKey: string): Promise<void> {
  click('[data-tasks-view-tab="list"]')
  await settle()
  click(`[data-tasks-list] [data-issue-row="${itemKey}"]`)
  await settle()
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
}

/**
 * 씨앗에 완료 이슈를 더한다(CORE-6 = 19일 전 완료가 이미 있다).
 * CORE-7 정확히 14일 · CORE-8 14일 − 1분 · CORE-9 3일 · CORE-10 칸 없음(옛날 완료지만 시각을 모름).
 */
function seedDone(server: JiraRestFixture): void {
  const base = server.issue(JIRA_FIXTURE_IDS.done)
  if (base === null) throw new Error('CORE-6')
  const add = ({ n, categoryChanged, fieldValues = {} }: { n: number; categoryChanged: number; fieldValues?: Record<string, unknown> }): void => {
    server.issues.push({ ...base, id: String(20000 + n), key: `CORE-${n}`, summary: `완료 ${n}`, rank: n, duedate: null, categoryChanged, fieldValues })
  }
  add({ n: 7, categoryChanged: NOW - 14 * DAY })
  add({ n: 8, categoryChanged: NOW - 14 * DAY + MINUTE })
  add({ n: 9, categoryChanged: NOW - 3 * DAY })
  add({ n: 10, categoryChanged: NOW - 40 * DAY, fieldValues: { statuscategorychangedate: undefined } })
}

describe('D3 Jira 보드 숨김', () => {
  it('ⓐ 14일 이상(경계 포함) 완료는 보드에 없다 · ⓑ 14일 미만은 보인다 · ⓓ 칸 없는 완료는 보인다', async () => {
    await rig({ seed: seedDone })
    expect(q('[data-tasks-board]')).not.toBeNull()
    const cards = boardCards()
    expect(cards).not.toContain('CORE-6')
    expect(cards).not.toContain('CORE-7')
    expect(cards).toContain('CORE-8')
    expect(cards).toContain('CORE-9')
    expect(cards).toContain('CORE-10')
    // 대조 — 열린 이슈는 그대로.
    expect(cards).toContain('CORE-2')
  })

  it('ⓐ 백로그 보기에도 없다', async () => {
    await rig({ seed: seedDone })
    click('[data-tasks-view-tab="backlog"]')
    await settle()
    const shown = [...document.querySelectorAll('[data-issue-card], [data-issue-row]')].map((entry) => entry.getAttribute('data-issue-card') ?? entry.getAttribute('data-issue-row'))
    expect(shown).not.toContain('CORE-6')
    expect(shown).not.toContain('CORE-7')
  })

  it('ⓒ 숨은 완료도 키 일치·검색으로는 보인다', async () => {
    await rig({ seed: seedDone })
    expect(boardCards()).not.toContain('CORE-7')
    await typeSearch('CORE-7')
    expect(q('[data-issue-card="CORE-7"], [data-issue-row="CORE-7"]')).not.toBeNull()
    await typeSearch('정산')
    expect(q('[data-issue-card="CORE-6"], [data-issue-row="CORE-6"]')).not.toBeNull()
  })
})

describe('D4·D5 Jira 상세 「완료」 행', () => {
  async function pick(statusKey: string): Promise<void> {
    click('[data-issue-status]')
    await settle()
    click(`[data-status-row="${statusKey}"]`)
    if (q('[data-confirm-ok]') !== null) click('[data-confirm-ok]')
    await settle(20)
  }
  const undo = async (): Promise<void> => {
    const shown = [...document.querySelectorAll('[data-toast="moved"]')].filter((entry) => entry.closest('[data-sonner-toast]')?.getAttribute('data-removed') !== 'true')
    const button = shown.at(-1)?.querySelector('[data-toast-undo]')
    if (!(button instanceof HTMLElement)) throw new Error('되돌리기 없음')
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle(20)
  }
  /** 완료 → 다른 완료(Closed) 전이를 둔 워크플로(실제 Jira 에 흔하다). */
  const withClosed = (server: JiraRestFixture): void => {
    const core = server.projects.find((project) => project.key === 'CORE')
    if (core === undefined) throw new Error('CORE')
    for (const statuses of Object.values(core.statusesByType)) statuses.push('10011')
    core.workflow['10003']?.push({ id: '42', name: 'Close', to: '10011' })
    core.workflow['10011'] = [{ id: '43', name: 'Reopen', to: '10002' }]
  }
  const categoryChanged = (r: Rig, id: string): number => r.fixture.issue(id)?.categoryChanged ?? Number.NaN

  it('D4ⓐ 「마감」 바로 뒤 · Jira 칸 값의 로컬 날짜 · 19일이라 숨김 표시 · 3일은 없음', async () => {
    await rig({ seed: seedDone })
    await openFromList('CORE-6')
    const cell = doneCell()
    if (cell === null) throw new Error('완료 행 없음')
    const label = cell.previousElementSibling
    expect(label?.textContent).toBe('완료')
    expect(label?.previousElementSibling?.querySelector('[data-field="due"]')).not.toBeNull()
    expect(label?.previousElementSibling?.previousElementSibling?.textContent).toBe('마감')
    expect(cell.textContent).toBe(`${localDate(Date.parse('2026-10-09T00:00:00.000Z'))} · 보드에서 숨김`)
    await openFromList('CORE-9')
    expect(doneCell()?.textContent).toBe(localDate(NOW - 3 * DAY))
    await openFromList('CORE-10')
    expect(doneCell()).toBeNull()
    await openFromList('CORE-4')
    expect(doneCell()).toBeNull()
  })

  it('D5ⓐ 비완료 → 완료: 응답 뒤 fixture 시계(분류 변경 시각)의 로컬 날짜 · ⓒ 완료 → 다른 완료: 그대로', async () => {
    const r = await rig({ seed: withClosed })
    await openFromList('CORE-4')
    expect(doneCell()).toBeNull()
    await pick('10003')
    const entered = categoryChanged(r, JIRA_FIXTURE_IDS.review)
    expect(entered).toBeGreaterThan(Date.parse('2026-10-01T00:00:00.000Z'))
    expect(doneCell()?.textContent).toBe(rowText(entered))
    await pick('10011')
    expect(el('[data-issue-status]').getAttribute('data-issue-status')).toBe('10011')
    expect(categoryChanged(r, JIRA_FIXTURE_IDS.review)).toBe(entered)
    expect(doneCell()?.textContent).toBe(rowText(entered))
  })

  it('D5ⓑ 완료 → 비완료: 응답을 기다리지 않고 사라진다', async () => {
    const r = await rig()
    await openFromList('CORE-6')
    expect(doneCell()).not.toBeNull()
    const original = window.corral.workRequest
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = 0
    window.corral.workRequest = async (request: WorkRequest): Promise<WorkResponse> => {
      if (request.call.op === 'changeStatus') { held += 1; await gate }
      return original(request)
    }
    await pick('10002')
    expect(held).toBe(1)
    expect(r.fixture.issue(JIRA_FIXTURE_IDS.done)?.statusId).toBe('10003')
    expect(doneCell()).toBeNull()
    await act(async () => { release() })
    await settle(20)
    expect(r.fixture.issue(JIRA_FIXTURE_IDS.done)?.statusId).toBe('10002')
    expect(doneCell()).toBeNull()
  })

  it('D5ⓓ 진입 직후 되돌리기 → 사라짐 · 완료에서 나갔다 되돌리면 출처가 새로 쓴 날짜', async () => {
    const r = await rig()
    await openFromList('CORE-4')
    await pick('10003')
    expect(doneCell()).not.toBeNull()
    await undo()
    expect(el('[data-issue-status]').getAttribute('data-issue-status')).toBe('10002')
    expect(doneCell()).toBeNull()

    await openFromList('CORE-6')
    const old = categoryChanged(r, JIRA_FIXTURE_IDS.done)
    expect(doneCell()?.textContent).toContain(localDate(old))
    await pick('10002')
    expect(doneCell()).toBeNull()
    await undo()
    expect(el('[data-issue-status]').getAttribute('data-issue-status')).toBe('10003')
    const fresh = categoryChanged(r, JIRA_FIXTURE_IDS.done)
    expect(fresh).toBeGreaterThan(old)
    expect(localDate(fresh)).not.toBe(localDate(old))
    expect(doneCell()?.textContent).toBe(rowText(fresh))
  })
})
