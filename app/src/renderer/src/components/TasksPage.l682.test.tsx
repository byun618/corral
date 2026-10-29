// @vitest-environment happy-dom
// LIFE-682 — 작업 상세가 오른쪽 패널의 작업 상세 보기로 옮겨 간 뒤의 경계를 실제 `TasksPage` 경로(+ 실제 WorkService · 모의 출처)로 본다.
// 패널 자리는 `TasksPageInPanel` 하네스가 App 처럼 곁에 둔다. 렌더러와 main 을 함께 import 하므로 mixed 검사(tsconfig.mixed.json)에 둔다.
//   A4 상세 위치 · A5 페이지 무관(닫힌 페이지에서 복원·읽기·편집·시작 모달·Esc) · A6 Q1 같은 카드 · Q2 Esc 사슬 · A7 ⤢ 한 번만 마운트 · Q3 터미널 ⤢ · A8 머리 끝 단추
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkSettingsState } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { mockSourceEntry, seedMockDemoState, type MockState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FakeCipher, MemoryStore } from '../../../main/work/test-kit.js'
import { TasksPageInPanel } from './TasksPage.harness.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => { toast.dismiss() })
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

type Rig = {
  state: MockState
  calls: WorkCall[]
  savedPrefs: unknown[]
  closes: number
  pageOpens: number
  connectionId: string
  render: (input: { open: boolean; head?: boolean }) => void
}

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function rig({ open, panelShown = true, prefs }: { open: boolean; panelShown?: boolean; prefs?: (connectionId: string) => unknown }): Promise<Rig> {
  const state = seedMockDemoState()
  let seq = 0
  let listener: (value: WorkSettingsState) => void = () => {}
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]), activity: new MemoryActivity(),
    repos: () => [], onChange: (value) => listener(value), now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token: 'mock_l682_fixture', replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const connectionId = service.settings().connections[0]?.id ?? ''
  const r: Rig = {
    state, calls: [], savedPrefs: [], closes: 0, pageOpens: 0, connectionId,
    render: ({ open: nextOpen, head = false }) => {
      act(() => root.render(createElement('div', null, createElement(TasksPageInPanel, {
        open: nextOpen, panelShown, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false,
        onClose: () => { r.closes += 1 }, onOpenSettings: () => {}, onOpenWorktree: () => {}, onOpenPage: () => { r.pageOpens += 1 },
        headTail: head ? createElement('button', { type: 'button', 'data-head-tail': '' }, '열기') : null,
      }), createElement(Toaster))))
    },
  }
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: prefs?.(connectionId) }),
    setUiPrefs: (value: { tasksPage: unknown }) => { r.savedPrefs.push(value.tasksPage) },
    getWorkSettings: async () => service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: (request: WorkRequest) => { r.calls.push(request.call); return service.request(request) },
    workActivity: async (query: unknown) => service.activity(query),
    startWorkStatus: async () => null,
  })
  r.render({ open })
  await settle()
  return r
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
function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}
function setValue(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const panelShown = (): string | null => q('[data-right-panel-detail]')?.getAttribute('data-panel-shown') ?? null
const listCalls = (calls: WorkCall[]): WorkCall[] => calls.filter((call) => call.op === 'listItems')
const lastDetailPref = (saved: unknown[]): unknown => {
  const withDetail = saved.filter((value) => typeof value === 'object' && value !== null && 'detail' in value)
  const last = withDetail.at(-1)
  return typeof last === 'object' && last !== null ? Reflect.get(last, 'detail') : undefined
}
async function openCard(itemKey: string): Promise<void> {
  click(`[data-tasks-board] [data-issue-card="${itemKey}"]`)
  await settle()
}

describe('A4 상세 위치 — 페이지 안 aside 가 없고 패널 상세 보기 안에 선다', () => {
  it('카드 클릭 = 패널 상세 + 그 작업, 작업 페이지 안에는 .issue-detail 이 없다', async () => {
    await rig({ open: true, panelShown: false })
    expect(panelShown()).toBe('false')
    await openCard('CORE-2')
    expect(panelShown()).toBe('true')
    expect(q('[data-right-panel-detail] [data-issue-detail="CORE-2"]')).not.toBeNull()
    expect(q('[data-tasks-page] .issue-detail')).toBeNull()
    expect(document.querySelectorAll('.issue-detail')).toHaveLength(1)
  })
  it('선택이 없으면 패널 상세 보기는 빈 상태 한 줄(Q5)', async () => {
    await rig({ open: true })
    expect(el('[data-right-panel-detail] [data-detail-empty]').textContent).toBe('작업을 고르면 여기에 상세가 보입니다')
  })
})

describe('A5 페이지 무관 유지', () => {
  it('ⓓ 페이지를 한 번도 열지 않고도 마지막 상세가 복원돼 읽힌다 — 목록은 받지 않는다', async () => {
    const r = await rig({ open: false, prefs: (connectionId) => ({ detail: { connectionId, itemId: 'm-2' } }) })
    await settle()
    expect(q('[data-right-panel-detail] [data-issue-detail="CORE-2"]')).not.toBeNull()
    expect(el('[data-issue-title]')).toBeInstanceOf(HTMLInputElement)
    expect(r.calls.some((call) => call.op === 'getItem')).toBe(true)
    expect(listCalls(r.calls)).toHaveLength(0)
  })
  it('ⓓ 대조 — 패널이 숨겨져 있으면 복원한 선택이 있어도 읽지 않는다(상세가 안 보이면 읽기 0)', async () => {
    const r = await rig({ open: false, panelShown: false, prefs: (connectionId) => ({ detail: { connectionId, itemId: 'm-2' } }) })
    await settle()
    expect(q('[data-task-detail-host]:not([hidden]) .issue-detail')).toBeNull()
    expect(r.calls.filter((call) => call.op === 'getItem')).toHaveLength(0)
  })
  it('ⓐⓑ 상세를 연 채 페이지를 닫으면 같은 상세가 남고, 그 화면에서 필드 편집이 출처에 쓰인다', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    r.render({ open: false })
    await settle()
    expect(q('[data-tasks-page]')?.classList.contains('is-closed')).toBe(true)
    expect(q('[data-right-panel-detail] [data-issue-detail="CORE-2"]')).not.toBeNull()
    const title = el('[data-issue-title]')
    if (!(title instanceof HTMLInputElement)) throw new Error('제목 칸')
    act(() => title.focus())
    setValue(title, '패널에서 고친 제목')
    key(title, { key: 'Enter' })
    await settle()
    expect(r.state.items.find((item) => item.key === 'CORE-2')?.title).toBe('패널에서 고친 제목')
  })
  it('ⓒ 페이지가 닫힌 화면에서 「작업에서 시작」 모달이 열리고(닫힌 페이지 밖 — inert 아님) 닫힌다', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    r.render({ open: false })
    await settle()
    click('[data-issue-start="first"]')
    await settle()
    const scrim = el('[data-modal-scrim]')
    expect(scrim.closest('[data-tasks-page]')).toBeNull()
    expect(scrim.closest('[inert]')).toBeNull()
    key(document.body, { key: 'Escape' })
    await settle()
    expect(q('[data-modal-scrim]')).toBeNull()
  })
  it('터미널 화면에서 상세 안 Esc 는 입력 blur 까지 — 패널을 숨기지 않는다(Q2)', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    r.render({ open: false })
    await settle()
    const title = el('[data-issue-title]')
    act(() => title.focus())
    key(title, { key: 'Escape' })
    await settle()
    expect(document.activeElement).not.toBe(title)
    // 포커스 없는(body) Esc 는 터미널 몫 — 상세 패널은 그대로.
    key(document.body, { key: 'Escape' })
    expect(panelShown()).toBe('true')
    expect(q('[data-issue-detail="CORE-2"]')).not.toBeNull()
  })
})

describe('A6 닫기 = 숨기기 · Q1 같은 카드', () => {
  it('보이는 카드를 다시 누르면 숨기기(선택 유지·강조 빠짐), 다시 누르면 같은 작업으로 열린다. 숨긴 채 다른 카드 = 열림 + 그 작업', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    expect(q('[data-issue-card="CORE-2"]')?.classList.contains('is-selected')).toBe(true)
    await openCard('CORE-2')
    expect(panelShown()).toBe('false')
    expect(q('[data-task-detail-host]:not([hidden]) .issue-detail')).toBeNull()
    expect(q('[data-issue-card="CORE-2"]')?.classList.contains('is-selected')).toBe(false)
    expect(lastDetailPref(r.savedPrefs)).toMatchObject({ itemId: 'm-2' })
    await openCard('CORE-2')
    expect(panelShown()).toBe('true')
    expect(q('[data-issue-detail="CORE-2"]')).not.toBeNull()
    click('[data-issue-close]')
    expect(panelShown()).toBe('false')
    await openCard('CORE-4')
    expect(panelShown()).toBe('true')
    expect(q('[data-issue-detail="CORE-4"]')).not.toBeNull()
  })
  it('Q2 Esc 사슬 — 입력 blur → 패널 숨기기(선택 유지) → 페이지 닫기', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    const title = el('[data-issue-title]')
    act(() => title.focus())
    key(title, { key: 'Escape' })
    expect(panelShown()).toBe('true')
    key(document.body, { key: 'Escape' })
    expect(panelShown()).toBe('false')
    expect(r.closes).toBe(0)
    expect(lastDetailPref(r.savedPrefs)).toMatchObject({ itemId: 'm-2' })
    key(document.body, { key: 'Escape' })
    expect(r.closes).toBe(1)
  })
})

describe('A7 ⤢ 전체 모드 · Q3', () => {
  it('페이지에서 ⤢ = 보기 영역 위 전체 모드(상세는 하나뿐, 패널 자리는 안내), 다시 ⤢ = 패널 상세 — 같은 aside 노드가 옮겨 간다', async () => {
    await rig({ open: true })
    await openCard('CORE-2')
    const before = el('[data-issue-detail="CORE-2"]')
    click('[data-issue-full]')
    expect(document.querySelectorAll('.issue-detail')).toHaveLength(1)
    expect(q('.tasks-main [data-detail-full-slot] .issue-detail.is-full')).toBe(before)
    expect(q('[data-tasks-head] .issue-detail, .tasks-head .issue-detail')).toBeNull()
    expect(el('[data-right-panel-detail] [data-detail-empty="full"]')).toBeInstanceOf(HTMLElement)
    click('[data-issue-full]')
    expect(q('[data-right-panel-detail] .issue-detail:not(.is-full)')).toBe(before)
    expect(q('[data-detail-full-slot] .issue-detail')).toBeNull()
  })
  it('터미널 화면에서 ⤢ = 전체 모드를 남기고 작업 페이지를 연다(Q3)', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    r.render({ open: false })
    await settle()
    click('[data-issue-full]')
    expect(r.pageOpens).toBe(1)
    expect(r.savedPrefs.some((value) => typeof value === 'object' && value !== null && Reflect.get(value, 'detailFull') === true)).toBe(true)
    r.render({ open: true })
    await settle()
    expect(q('[data-detail-full-slot] .issue-detail.is-full')).not.toBeNull()
  })
})

describe('A8 작업 페이지 머리 끝 — 패널 여는 단추 자리', () => {
  it('App 이 준 headTail 이 머리 오른쪽 끝(닫기 ✕ 뒤)에 선다', async () => {
    const r = await rig({ open: true })
    r.render({ open: true, head: true })
    const head = el('.tasks-head')
    expect(head.lastElementChild?.getAttribute('data-head-tail')).toBe('')
    expect(head.lastElementChild?.previousElementSibling?.hasAttribute('data-tasks-close')).toBe(true)
  })
})

// LIFE-682 fix r1 — 리뷰 r1 재현 RA·RA2·RC·RD(raw/review/claude-r1/TasksPage.zzr1.test.tsx.txt)를 옮겼다.
// 하네스의 패널 숨기기(`shown=false`)는 App 의 ✕·같은 카드·⌘L·탐색기 아이콘·⌘⇧E 가 모두 지나는 같은 경로(`detailPanel.shown` 거짓)다.
function setArea(target: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const shownDetail = (selector: string): Element | null => q(`[data-task-detail-host]:not([hidden]) ${selector}`)

describe('fix r1 지적 1 — 숨기기·보기 전환에 초안이 남는다(마운트는 선택에, 읽기는 보임에)', () => {
  it('RA 코멘트 초안 — ✕ 로 숨겼다 같은 카드로 다시 열면 그대로', async () => {
    await rig({ open: true })
    await openCard('CORE-2')
    const area = el('[data-comment-composer] textarea')
    if (!(area instanceof HTMLTextAreaElement)) throw new Error('textarea')
    setArea(area, '쓰던 코멘트 초안')
    click('[data-issue-close]')
    expect(panelShown()).toBe('false')
    await openCard('CORE-2')
    const after = shownDetail('[data-comment-composer] textarea')
    expect(after instanceof HTMLTextAreaElement ? after.value : null).toBe('쓰던 코멘트 초안')
  })
  it('RA2 본문 편집 중 — 같은 카드 재클릭(숨기기) 뒤 다시 열어도 편집기가 열린 채', async () => {
    await rig({ open: true })
    await openCard('CORE-2')
    click('[data-issue-body-edit]')
    expect(q('[data-issue-body-edit]')).toBeNull()
    await openCard('CORE-2')
    expect(panelShown()).toBe('false')
    await openCard('CORE-2')
    expect(shownDetail('[data-issue-detail="CORE-2"]')).not.toBeNull()
    expect(q('[data-issue-body-edit]')).toBeNull()
  })
  it('숨긴 상세 host 는 hidden + inert(포커스·Tab 대상 아님)이고, 숨긴 동안 단건 읽기를 더 보내지 않는다', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    click('[data-issue-close]')
    await settle()
    const host = el('[data-task-detail-host]')
    expect(host.hidden).toBe(true)
    expect(host.inert).toBe(true)
    expect(host.querySelector('[data-issue-detail="CORE-2"]')).not.toBeNull()
    const reads = r.calls.filter((call) => call.op === 'getItem').length
    await settle()
    expect(r.calls.filter((call) => call.op === 'getItem')).toHaveLength(reads)
    await openCard('CORE-2')
    expect(host.hidden).toBe(false)
    expect(host.inert).toBe(false)
  })
})

describe('fix r1 지적 2 — 메뉴가 열린 채 상세가 숨거나 사라져도 Esc 사슬이 끝까지 내려간다', () => {
  it('RC 우선순위 메뉴를 연 채 같은 카드 재클릭(숨기기) → Esc 가 페이지 닫기까지', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    click('[data-field="priority"]')
    expect(q('[data-detail-menu]')).not.toBeNull()
    await openCard('CORE-2')
    expect(panelShown()).toBe('false')
    key(document.body, { key: 'Escape' })
    expect(r.closes).toBe(1)
  })
  it('선택이 사라져 상세가 언마운트돼도(스페이스 바꾸기) 옛 escapeRef 가 Esc 를 삼키지 않는다', async () => {
    const r = await rig({ open: true })
    await openCard('CORE-2')
    click('[data-field="priority"]')
    expect(q('[data-detail-menu]')).not.toBeNull()
    click('[data-space-switch]')
    click('[data-space-row="all"]')
    await settle()
    expect(q('.issue-detail')).toBeNull()
    key(document.body, { key: 'Escape' })
    expect(r.closes).toBe(1)
  })
})

describe('fix r1 지적 3·4 — 만들기·시작 모달', () => {
  it('RD 만들기 모달이 열린 동안 패널 상세는 inert, 닫으면 풀린다', async () => {
    await rig({ open: true })
    await openCard('CORE-2')
    key(document.body, { key: 'c' })
    await settle()
    expect(q('[data-modal-scrim]')).not.toBeNull()
    expect(q('.issue-detail')?.closest('[inert]')).not.toBeNull()
    key(document.body, { key: 'Escape' })
    await settle()
    expect(q('[data-modal-scrim]')).toBeNull()
    expect(q('.issue-detail')?.closest('[inert]')).toBeNull()
  })
  it('페이지 모달 열림을 App 에 알린다 — 닫힌 페이지의 시작 모달도(App 이 그동안 단축키를 막는다)', async () => {
    const r = await rig({ open: true })
    const changes: boolean[] = []
    act(() => root.render(createElement('div', null, createElement(TasksPageInPanel, {
      open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false,
      onClose: () => { r.closes += 1 }, onOpenSettings: () => {}, onOpenWorktree: () => {}, onModalChange: (open: boolean) => { changes.push(open) },
    }), createElement(Toaster))))
    await settle()
    await openCard('CORE-2')
    key(document.body, { key: 'c' })
    await settle()
    key(document.body, { key: 'Escape' })
    await settle()
    act(() => root.render(createElement('div', null, createElement(TasksPageInPanel, {
      open: false, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false,
      onClose: () => { r.closes += 1 }, onOpenSettings: () => {}, onOpenWorktree: () => {}, onModalChange: (open: boolean) => { changes.push(open) },
    }), createElement(Toaster))))
    await settle()
    click('[data-issue-start="first"]')
    await settle()
    expect(q('[data-modal-scrim]')).not.toBeNull()
    expect(changes.at(-1)).toBe(true)
    key(document.body, { key: 'Escape' })
    await settle()
    expect(changes.at(-1)).toBe(false)
    expect(changes.filter((value) => value)).toHaveLength(2)
  })
})
