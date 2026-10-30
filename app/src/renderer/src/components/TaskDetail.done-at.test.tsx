// @vitest-environment happy-dom
// 상세 「완료」 행 — done 분류 + doneAt 이 해석될 때만, 「마감」 바로 뒤, 읽기 전용. 날짜는 마감 칸과 같은 로컬 YYYY-MM-DD,
// 「· 보드에서 숨김」 은 보드와 같은 판정(`isHiddenOnBoard` — 14일 이상). 상태 메뉴 전이 뒤 행은 출처 응답의 doneAt 을 따른다(702 낙관 규칙 그대로).
// 실제 경로 React `TasksPage` → hook → `WorkService` → 모의 출처 · LA 출처 + `LaMcpFixture`(가짜 fetch). Jira 는 `TasksPage.jira-done.test.tsx`.
// 렌더러와 main 을 함께 import 하므로 mixed 검사에 둔다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkCategory, WorkRequest, WorkResponse } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { FIXTURE_IDS, FIXTURE_STATUS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../../main/work/la-source.js'
import { mockSourceEntry, seedMockDemoState, type MockState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FAKE_LA_TOKEN, FAKE_MOCK_TOKEN, FakeCipher, MemoryStore, workHarness } from '../../../main/work/test-kit.js'
import { doneRow } from '../task-detail-model.js'
import { DONE_HIDE_MS } from '../tasks-model.js'
import { TasksPageInPanel } from './TasksPage.harness.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const NOW = Date.parse('2026-10-28T03:00:00.000Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
/** 기대값 — 그 순간을 이 기계의 로컬 시간대로 본 날짜(제품 함수와 따로 계산). */
function localDate(iso: string): string {
  const date = new Date(iso)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0')).join('-')
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => { toast.dismiss() })
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
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

type Rig = { calls: WorkCall[] }

function mount({ service, calls }: { service: WorkService; calls: WorkCall[] }): void {
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => service.settings(),
    onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => { calls.push(request.call); return service.request(request) },
    workActivity: async (query: unknown) => service.activity(query),
  })
  act(() => root.render(createElement('div', null, createElement(TasksPageInPanel, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
}

async function mockRig({ seed }: { seed: (state: MockState) => void }): Promise<Rig> {
  const state = seedMockDemoState()
  state.pageSize = 50
  seed(state)
  let seq = 0
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]), activity: new MemoryActivity(),
    repos: () => [], onChange: () => {}, now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const calls: WorkCall[] = []
  mount({ service, calls })
  await settle(20)
  return { calls }
}

/** 실제 `LaSource` + `LaMcpFixture` — fetch 를 fixture 도구 처리기에 바로 잇는다(`TaskDetail.la-on.test.tsx` 꼴). */
async function laRig({ seed }: { seed: (fixture: LaMcpFixture) => void }): Promise<Rig & { fixture: LaMcpFixture }> {
  const fixture = new LaMcpFixture()
  seed(fixture)
  const fetchImpl = async (_url: unknown, options?: RequestInit): Promise<Response> => {
    const body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } = JSON.parse(String(options?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const reply: { isError: boolean; text: string } | null = body.method === 'initialize' ? null : Reflect.get(fixture, 'tool').call(fixture, { tool: body.params?.name, args: body.params?.arguments ?? {} })
    const result = reply === null ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  const harness = workHarness({ entries: [laSourceEntry({ url: 'http://127.0.0.1:9/not-networked', clientVersion: 'test', fetchImpl })] })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('LA 모의 연결 실패')
  const calls: WorkCall[] = []
  mount({ service: harness.service, calls })
  await settle(30)
  return { calls, fixture }
}

/** 리스트 보기에서 연다 — 리스트는 오래된 완료도 숨기지 않는다(LIFE-702). */
async function openFromList(itemKey: string): Promise<void> {
  click('[data-tasks-view-tab="list"]')
  await settle()
  click(`[data-tasks-list] [data-issue-row="${itemKey}"]`)
  await settle()
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
}
const doneCell = (): HTMLElement | null => {
  const found = q('[data-issue-fields] [data-field="done-at"]')
  return found instanceof HTMLElement ? found : null
}
/** 「완료」 행이 「마감」 행 바로 뒤인가 — 칸 격자는 라벨·값 형제 순서다. */
function assertAfterDue(cell: HTMLElement): void {
  const label = cell.previousElementSibling
  expect(label?.textContent).toBe('완료')
  expect(label?.className).toBe('issue-field-label')
  const dueValue = label?.previousElementSibling
  expect(dueValue?.querySelector('[data-field="due"]')).not.toBeNull()
  expect(dueValue?.previousElementSibling?.textContent).toBe('마감')
}
const WRITE_OPS = new Set(['addComment', 'addRelation', 'changeStatus', 'createItem', 'removeRelation', 'removeWorkLink', 'reorder', 'saveWorkLink', 'setParent', 'setPlacement', 'updateItem'])
const writes = (calls: WorkCall[]): WorkCall[] => calls.filter((call) => WRITE_OPS.has(call.op))

describe('doneRow — 모델(경계)', () => {
  const at = (category: WorkCategory, doneAt: string | null) => doneRow({ item: { category, doneAt }, now: NOW })
  it('done + 해석되는 doneAt → 로컬 날짜', () => {
    expect(at('done', ago(3 * DAY))).toEqual({ date: localDate(ago(3 * DAY)), hidden: false })
  })
  // UTC 날짜 ≠ 로컬 날짜인 순간 — 00:30Z·03:00Z 는 서쪽(음수 오프셋, LA 등), 16:30Z·23:30Z 는 동쪽(KST 등)에서 날이 갈린다.
  // 그래서 doneAt 의 UTC 날짜(`slice(0, 10)`)를 쓰는 회귀는 UTC 가 아닌 시간대면 어디서든 여기서 실패한다.
  const SPLIT = ['2026-10-25T00:30:00.000Z', '2026-10-25T03:00:00.000Z', '2026-10-25T16:30:00.000Z', '2026-10-25T23:30:00.000Z']
  it('로컬 날짜 — UTC 날짜와 갈리는 순간도 이 기계의 로컬 날짜', () => {
    for (const doneAt of SPLIT) expect(at('done', doneAt)?.date, doneAt).toBe(localDate(doneAt))
    if (new Date(NOW).getTimezoneOffset() !== 0) expect(SPLIT.some((doneAt) => localDate(doneAt) !== doneAt.slice(0, 10))).toBe(true)
  })
  it('경계 — 정확히 14일 = 숨김, 14일 − 1분 = 숨김 아님', () => {
    expect(DONE_HIDE_MS).toBe(14 * DAY)
    expect(at('done', ago(14 * DAY))?.hidden).toBe(true)
    expect(at('done', ago(14 * DAY - MINUTE))?.hidden).toBe(false)
  })
  it('행 없음 — todo·in_progress(doneAt 이 남아 있어도) · done + null · done + 해석 불가', () => {
    expect(at('todo', ago(DAY))).toBeNull()
    expect(at('in_progress', ago(DAY))).toBeNull()
    expect(at('done', null)).toBeNull()
    expect(at('done', '어제쯤')).toBeNull()
    expect(at('done', '')).toBeNull()
  })
})

describe('D4 상세 「완료」 행 — 모의 출처', () => {
  const seedDone = (doneAt: string | null) => (state: MockState): void => {
    const done = state.items.find((item) => item.key === 'CORE-7')
    if (done === undefined) throw new Error('CORE-7')
    done.doneAt = doneAt
  }

  it('ⓐ 「마감」 바로 뒤 · 로컬 날짜 · 최근이면 숨김 표시 없음', async () => {
    // KST 등 동쪽 시간대에서 UTC 날짜와 갈리는 순간(서쪽은 LA fixture 의 03:00Z 시드가 가른다).
    const doneAt = '2026-10-25T23:30:00.000Z'
    await mockRig({ seed: seedDone(doneAt) })
    await openFromList('CORE-7')
    const cell = doneCell()
    if (cell === null) throw new Error('완료 행 없음')
    assertAfterDue(cell)
    expect(cell.textContent).toBe(localDate(doneAt))
  })

  for (const { name, ms, hidden } of [{ name: '정확히 14일', ms: 14 * DAY, hidden: true }, { name: '14일 − 1분', ms: 14 * DAY - MINUTE, hidden: false }, { name: '20일', ms: 20 * DAY, hidden: true }]) {
    it(`ⓑ ${name} → 「· 보드에서 숨김」 ${hidden ? '붙음' : '없음'} · 보드 판정과 같다`, async () => {
      const doneAt = ago(ms)
      await mockRig({ seed: seedDone(doneAt) })
      // 보드에 카드가 있는지(보드 판정)와 상세 표시가 같은 쪽이다.
      expect(q('[data-tasks-board] [data-issue-card="CORE-7"]') === null).toBe(hidden)
      await openFromList('CORE-7')
      expect(doneCell()?.textContent).toBe(hidden ? `${localDate(doneAt)} · 보드에서 숨김` : localDate(doneAt))
    })
  }

  it('ⓒ 편집 불가 — 행에 입력·버튼 없음 · 클릭·키 입력에 쓰기 0', async () => {
    const rig = await mockRig({ seed: seedDone(ago(3 * DAY)) })
    await openFromList('CORE-7')
    const cell = doneCell()
    if (cell === null) throw new Error('완료 행 없음')
    expect(cell.querySelectorAll('input, button, select, textarea, [contenteditable], [tabindex]')).toHaveLength(0)
    const label = cell.previousElementSibling
    if (!(label instanceof HTMLElement)) throw new Error('라벨')
    const before = writes(rig.calls).length
    for (const target of [cell, label]) {
      act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      act(() => { target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
      for (const key of ['Enter', ' ', 'Backspace', 'a']) act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    }
    await settle()
    expect(writes(rig.calls)).toHaveLength(before)
    expect(doneCell()).not.toBeNull()
  })

  it('ⓓ 행 없음 — 할 일 · 진행 중 · done + null · done + 해석 불가', async () => {
    await mockRig({ seed: (state) => {
      for (const item of state.items) item.doneAt = ago(DAY)
      const done = state.items.find((item) => item.key === 'CORE-7')
      if (done === undefined) throw new Error('CORE-7')
      done.doneAt = null
      state.items.push({ ...done, id: 'm-x', key: 'CORE-9', title: '해석 안 되는 완료 시각', doneAt: '어제쯤', rank: 'z' })
    } })
    for (const key of ['CORE-6', 'CORE-2', 'CORE-7', 'CORE-9']) {
      await openFromList(key)
      expect(q('[data-issue-fields]'), key).not.toBeNull()
      expect(doneCell(), key).toBeNull()
      expect([...document.querySelectorAll('[data-issue-fields] .issue-field-label')].map((label) => label.textContent), key).not.toContain('완료')
    }
  })
})

describe('D4·D5 LA fixture', () => {
  const CANCEL_STATUS = '00000000-0000-4000-8000-000000009005'
  const DONE_CLOCK = NOW - 2 * MINUTE

  async function rig(): Promise<Rig & { fixture: LaMcpFixture }> {
    return laRig({ seed: (fixture) => {
      fixture.doneClock = () => DONE_CLOCK
      fixture.statuses.push({ id: CANCEL_STATUS, categoryKey: 'done', label: '취소', color: null, position: 1, isDefault: false })
      const doneBug = fixture.issues.find((issue) => issue.id === FIXTURE_IDS.doneBug)
      if (doneBug === undefined) throw new Error('doneBug')
      doneBug.doneAt = ago(20 * DAY)
    } })
  }
  const stored = (fixture: LaMcpFixture, id: string): string | null => fixture.issues.find((issue) => issue.id === id)?.doneAt ?? null
  async function pick({ statusKey, resolution }: { statusKey: string; resolution?: string }): Promise<void> {
    click('[data-issue-status]')
    await settle()
    click(resolution === undefined ? `[data-status-row="${statusKey}"]` : `[data-status-row="${statusKey}"][data-status-resolution="${resolution}"]`)
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

  it('D4ⓐ LA 응답의 doneAt 로컬 날짜 · 20일이라 숨김 표시', async () => {
    await rig()
    await openFromList('LIFE-387')
    const cell = doneCell()
    if (cell === null) throw new Error('완료 행 없음')
    assertAfterDue(cell)
    expect(cell.textContent).toBe(`${localDate(ago(20 * DAY))} · 보드에서 숨김`)
  })

  it('D5ⓐ 비완료 → 완료: 응답 뒤 fixture 시계의 로컬 날짜 · ⓒ 완료 → 다른 완료(취소): 날짜 그대로', async () => {
    const r = await rig()
    await openFromList('LIFE-600')
    expect(doneCell()).toBeNull()
    await pick({ statusKey: FIXTURE_STATUS.done, resolution: 'completed' })
    expect(stored(r.fixture, FIXTURE_IDS.task600)).toBe(new Date(DONE_CLOCK).toISOString())
    expect(doneCell()?.textContent).toBe(localDate(new Date(DONE_CLOCK).toISOString()))
    r.fixture.doneClock = () => NOW + 3 * DAY
    await pick({ statusKey: CANCEL_STATUS, resolution: 'cancelled' })
    expect(el('[data-issue-status]').getAttribute('data-issue-status')).toBe(CANCEL_STATUS)
    expect(doneCell()?.textContent).toBe(localDate(new Date(DONE_CLOCK).toISOString()))
  })

  it('D5ⓑ 완료 → 비완료: 응답을 기다리지 않고 행이 사라진다', async () => {
    const r = await rig()
    await openFromList('LIFE-387')
    expect(doneCell()).not.toBeNull()
    const original = window.corral.workRequest
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = 0
    window.corral.workRequest = async (request: WorkRequest): Promise<WorkResponse> => {
      if (request.call.op === 'changeStatus') { held += 1; await gate }
      return original(request)
    }
    await pick({ statusKey: FIXTURE_STATUS.dev })
    expect(held).toBe(1)
    expect(stored(r.fixture, FIXTURE_IDS.doneBug)).not.toBeNull()
    expect(doneCell()).toBeNull()
    await act(async () => { release() })
    await settle(20)
    expect(stored(r.fixture, FIXTURE_IDS.doneBug)).toBeNull()
    expect(doneCell()).toBeNull()
  })

  it('D5ⓓ 진입 직후 되돌리기 → 행 사라짐 · 완료에서 나갔다 되돌리면 출처가 새로 쓴 날짜(옛 값 아님)', async () => {
    const r = await rig()
    await openFromList('LIFE-600')
    await pick({ statusKey: FIXTURE_STATUS.done, resolution: 'completed' })
    expect(doneCell()).not.toBeNull()
    await undo()
    expect(el('[data-issue-status]').getAttribute('data-issue-status')).toBe(FIXTURE_STATUS.dev)
    expect(doneCell()).toBeNull()

    await openFromList('LIFE-387')
    expect(doneCell()?.textContent).toContain(localDate(ago(20 * DAY)))
    await pick({ statusKey: FIXTURE_STATUS.dev })
    expect(doneCell()).toBeNull()
    await undo()
    expect(el('[data-issue-status]').getAttribute('data-issue-status')).toBe(FIXTURE_STATUS.done)
    expect(stored(r.fixture, FIXTURE_IDS.doneBug)).toBe(new Date(DONE_CLOCK).toISOString())
    expect(doneCell()?.textContent).toBe(localDate(new Date(DONE_CLOCK).toISOString()))
  })
})
