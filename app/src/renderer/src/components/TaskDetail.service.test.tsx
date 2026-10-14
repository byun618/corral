// @vitest-environment happy-dom
// LIFE-602 작업 상세 — 실제 WorkService(모의 출처 · 메모리 활동 저장소)를 preload 자리에 이어 화면에서 본다.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사에서 빼고 mixed 검사(tsconfig.mixed.json)에 둔다 — 선례 TasksPage.service.test.tsx.
// 되돌리기는 실제 Sonner Toaster DOM 으로 본다(선례 TasksPage.r4.test.tsx).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkConnectionSummary, WorkRequest, WorkSettingsState } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { foreignEdit, mockSourceEntry, seedMockDemoState, type MockState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FakeCipher, MemoryStore } from '../../../main/work/test-kit.js'
import { TasksPage } from './TasksPage.js'

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
})

type Rig = { service: WorkService; state: MockState; activity: MemoryActivity; calls: WorkCall[]; savedPrefs: unknown[]; closes: number[]; connectionId: string; push: (value: WorkSettingsState) => void }

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const wait = async (ms: number): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }

async function rig({ token = 'mock_l602_fixture', prefs }: { token?: string; prefs?: (connectionId: string) => unknown } = {}): Promise<Rig> {
  const state = seedMockDemoState()
  const activity = new MemoryActivity()
  let seq = 0
  let listener: (value: WorkSettingsState) => void = () => {}
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]), activity,
    repos: () => [], onChange: (value) => listener(value), now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token, replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const connectionId = service.settings().connections[0]?.id ?? ''
  const result: Rig = { service, state, activity, calls: [], savedPrefs: [], closes: [], connectionId, push: (value) => { act(() => listener(value)) } }
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: prefs?.(connectionId) }),
    setUiPrefs: (value: { tasksPage: unknown }) => { result.savedPrefs.push(value.tasksPage) },
    getWorkSettings: async () => service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: (request: WorkRequest) => { result.calls.push(request.call); return service.request(request) },
    workActivity: async (query: unknown) => service.activity(query),
  })
  act(() => root.render(createElement('div', null, createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => result.closes.push(1), onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
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
function setValue(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}
const writes = (calls: WorkCall[]): WorkCall[] => calls.filter((call) => call.op !== 'getItem' && call.op !== 'listItems' && call.op !== 'listSpaces' && call.op !== 'listStatuses' && call.op !== 'listComments' && call.op !== 'listHistory' && call.op !== 'listChildren' && call.op !== 'listTransitions' && call.op !== 'findByKey')
async function openCard(itemKey: string): Promise<void> {
  click(`[data-tasks-board] [data-issue-card="${itemKey}"]`)
  await settle()
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
}

describe('C1 상세 그릇', () => {
  it('카드 → 상세 · ⤢ 패널↔전체(남김) · 부모 경로로 이동 · ✕ 닫기', async () => {
    const r = await rig()
    await openCard('CORE-2')
    expect(el('[data-issue-full]').dataset.issueFull).toBe('panel')
    click('[data-issue-full]')
    expect(el('[data-issue-full]').dataset.issueFull).toBe('full')
    expect(q('.issue-detail.is-full')).not.toBeNull()
    expect(r.savedPrefs.some((value) => typeof value === 'object' && value !== null && Reflect.get(value, 'detailFull') === true)).toBe(true)
    expect(r.savedPrefs.some((value) => typeof value === 'object' && value !== null && Reflect.get(Reflect.get(value, 'detail') ?? {}, 'itemId') === 'm-2')).toBe(true)
    click('[data-issue-parent="CORE-1"]')
    await settle()
    expect(q('[data-issue-detail="CORE-1"]')).not.toBeNull()
    click('[data-issue-close]')
    await settle()
    expect(q('[data-issue-detail]')).toBeNull()
  })

  it('Esc 단계 — 메뉴 → 입력 blur → 상세 닫기 → 페이지 닫기', async () => {
    const r = await rig()
    await openCard('CORE-4')
    click('[data-issue-status]')
    await settle()
    expect(q('[data-tasks-menu="status"]')).not.toBeNull()
    key(document.body, { key: 'Escape' })
    expect(q('[data-tasks-menu="status"]')).toBeNull()
    expect(q('[data-issue-detail="CORE-4"]')).not.toBeNull()
    const title = el('[data-issue-title]')
    act(() => title.focus())
    key(title, { key: 'Escape' })
    await settle()
    expect(q('[data-issue-detail="CORE-4"]')).not.toBeNull()
    key(document.body, { key: 'Escape' })
    await settle()
    expect(q('[data-issue-detail]')).toBeNull()
    expect(r.closes).toHaveLength(0)
    key(document.body, { key: 'Escape' })
    expect(r.closes).toHaveLength(1)
    expect(writes(r.calls)).toHaveLength(0)
  })

  it('복원 — 남긴 열린 상세·전체 크기로 다시 연다', async () => {
    await rig({ prefs: (connectionId) => ({ detail: { connectionId, itemId: 'm-2' }, detailFull: true }) })
    await settle()
    expect(q('[data-issue-detail="CORE-2"]')).not.toBeNull()
    expect(el('[data-issue-full]').dataset.issueFull).toBe('full')
  })

  it('늦은 응답 — 다른 카드로 바꾼 뒤 앞 작업 응답이 상세를 덮지 않는다', async () => {
    await rig({ token: 'mock_l602_delay-120' })
    await wait(400)
    click('[data-tasks-board] [data-issue-card="CORE-2"]')
    await wait(30)
    click('[data-tasks-board] [data-issue-card="CORE-4"]')
    await wait(800)
    expect(q('[data-issue-detail="CORE-4"]')).not.toBeNull()
    expect(el('[data-issue-title]')).toHaveProperty('value', '영수증 메일')
  })
})

describe('C2 상태', () => {
  it('완료함/취소함 갈래 · 허용 전이 각주 · 취소함 고르면 갈래가 남는다', async () => {
    const r = await rig()
    await openCard('CORE-4')
    click('[data-issue-status]')
    await settle()
    expect(q('[data-status-row="core-done"][data-status-resolution="completed"]')).not.toBeNull()
    expect(q('[data-status-row="core-done"][data-status-resolution="cancelled"]')).not.toBeNull()
    expect(q('[data-status-row="core-todo"]')).toBeNull()
    expect(el('[data-status-foot]').textContent).toContain('허용 전이 2개만')
    click('[data-status-row="core-done"][data-status-resolution="cancelled"]')
    await settle()
    expect(el('[data-issue-status]').dataset.issueResolution).toBe('cancelled')
    expect(writes(r.calls)).toEqual([expect.objectContaining({ op: 'changeStatus', statusKey: 'core-done', resolution: 'cancelled' })])
    expect(r.state.items.find((row) => row.id === 'm-4')?.resolution).toBe('cancelled')
  })

  it('분류가 내려가면 확인 팝오버 — 취소 = 요청 0, 되돌리기 = 1', async () => {
    const r = await rig()
    await openCard('CORE-4')
    click('[data-issue-status]')
    await settle()
    click('[data-status-row="core-done"][data-status-resolution="completed"]')
    await settle()
    expect(writes(r.calls)).toHaveLength(1)
    click('[data-issue-status]')
    await settle()
    click('[data-status-row="core-review"]')
    expect(q('[data-issue-confirm]')).not.toBeNull()
    click('[data-confirm-cancel]')
    await settle()
    expect(q('[data-issue-confirm]')).toBeNull()
    expect(writes(r.calls)).toHaveLength(1)
    click('[data-issue-status]')
    await settle()
    click('[data-status-row="core-review"]')
    click('[data-confirm-ok]')
    await settle()
    expect(writes(r.calls).at(-1)).toEqual(expect.objectContaining({ op: 'changeStatus', statusKey: 'core-review' }))
    expect(writes(r.calls)).toHaveLength(2)
    expect(el('[data-issue-status]').dataset.issueStatus).toBe('core-review')
  })

  it('쓰기 불가(연결 권한 없음) — 상태·필드·편집이 막히고 이유를 보인다 · 요청 0', async () => {
    const r = await rig()
    await openCard('CORE-4')
    const settings = r.service.settings()
    const forbidden: WorkConnectionSummary['status'] = 'forbidden'
    r.push({ ...settings, connections: settings.connections.map((connection) => ({ ...connection, status: forbidden })) })
    await settle()
    click('[data-issue-status]')
    expect(q('[data-tasks-menu="status"]')).toBeNull()
    expect(el('[data-issue-status]').getAttribute('title')).toBe('권한이 없어 바꿀 수 없습니다.')
    expect(el('[data-field="priority"]')).toHaveProperty('disabled', true)
    expect(el('[data-issue-body-edit]')).toHaveProperty('disabled', true)
    expect(el('[data-issue-title]')).toHaveProperty('readOnly', true)
    expect(writes(r.calls)).toHaveLength(0)
  })
})

describe('C3 필드 즉시 저장', () => {
  it('우선순위 — 즉시 반영 · 되돌리기 토스트로 원복 · 활동에 한 줄', async () => {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-field="priority"]')
    click('[data-priority-row="high"]')
    expect(el('[data-field="priority"]').textContent).toContain('높음')
    await settle()
    expect(writes(r.calls)).toEqual([expect.objectContaining({ op: 'updateItem', fields: { priority: 'high' } })])
    expect(r.state.items.find((row) => row.id === 'm-2')?.priority).toBe('high')
    const undo = [...document.querySelectorAll('[data-toast="moved"]')].find((entry) => entry.textContent?.includes('CORE-2 우선순위'))?.querySelector('[data-toast-undo]')
    expect(undo).toBeInstanceOf(HTMLElement)
    act(() => { undo?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(writes(r.calls).at(-1)).toEqual(expect.objectContaining({ op: 'updateItem', fields: { priority: 'medium' } }))
    expect(r.state.items.find((row) => row.id === 'm-2')?.priority).toBe('medium')
    expect(r.activity.records.filter((record) => record.itemId === 'm-2')).toHaveLength(2)
  })

  it('거절 — 화면이 출처 값으로 돌아오고 실패를 알린다', async () => {
    const r = await rig({ token: 'mock_l602_reject-writes' })
    await openCard('CORE-2')
    click('[data-field="priority"]')
    click('[data-priority-row="highest"]')
    await settle()
    expect(writes(r.calls)).toHaveLength(1)
    expect(el('[data-field="priority"]').textContent).toContain('보통')
    expect(q('[data-toast="failed"]')).not.toBeNull()
    expect(r.activity.records).toHaveLength(0)
  })

  it('배치 — 백로그로 바꾸면 setPlacement 1회', async () => {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-placement="backlog"]')
    await settle()
    expect(writes(r.calls)).toEqual([expect.objectContaining({ op: 'setPlacement', placement: 'backlog' })])
  })
})

describe('C5 본문 편집기', () => {
  it('⌘↵ 저장 = 입력 바이트 그대로 · Esc = 요청 0', async () => {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-issue-body-edit]')
    const area = el('[data-md-editor] textarea')
    if (!(area instanceof HTMLTextAreaElement)) throw new Error('편집기 없음')
    setValue(area, '첫 줄\n- [ ] 할 일\n\t탭 · 한글 😀  ')
    key(area, { key: 'Escape' })
    await settle()
    expect(q('[data-md-editor]')).toBeNull()
    expect(writes(r.calls)).toHaveLength(0)
    click('[data-issue-body-edit]')
    const again = el('[data-md-editor] textarea')
    if (!(again instanceof HTMLTextAreaElement)) throw new Error('편집기 없음')
    setValue(again, '첫 줄\n- [ ] 할 일\n\t탭 · 한글 😀  ')
    key(again, { key: 'Enter', metaKey: true })
    await settle()
    expect(writes(r.calls)).toEqual([expect.objectContaining({ op: 'updateItem', fields: { body: '첫 줄\n- [ ] 할 일\n\t탭 · 한글 😀  ' } })])
    expect(r.state.items.find((row) => row.id === 'm-2')?.body).toBe('첫 줄\n- [ ] 할 일\n\t탭 · 한글 😀  ')
    expect(q('[data-md-editor]')).toBeNull()
  })

  it('IME — 조합 중 Enter·조합을 끝낸 Enter 는 목록을 잇지 않고 저장도 하지 않는다', async () => {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-issue-body-edit]')
    const area = el('[data-md-editor] textarea')
    if (!(area instanceof HTMLTextAreaElement)) throw new Error('편집기 없음')
    setValue(area, '- 한')
    act(() => { area.setSelectionRange(4, 4) })
    act(() => { area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    const during = key(area, { key: 'Enter', isComposing: true, keyCode: 229 })
    act(() => { area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' })) })
    const after = key(area, { key: 'Enter' })
    expect(during.defaultPrevented).toBe(false)
    expect(after.defaultPrevented).toBe(true)
    expect(area.value).toBe('- 한')
    // 그다음 Enter 는 목록을 잇는다.
    const next = key(area, { key: 'Enter' })
    expect(next.defaultPrevented).toBe(true)
    expect(area.value).toBe('- 한\n- ')
    expect(writes(r.calls)).toHaveLength(0)
  })

  it('체크 칸 — 누르면 그 줄 한 칸만 바꿔 저장한다', async () => {
    const r = await rig()
    await openCard('CORE-1')
    const box = q('[data-issue-body] input[type="checkbox"]')
    if (!(box instanceof HTMLInputElement)) throw new Error('체크 칸 없음')
    const before = r.state.items.find((row) => row.id === 'm-1')?.body ?? ''
    act(() => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    const sent = writes(r.calls)
    expect(sent).toHaveLength(1)
    const after = r.state.items.find((row) => row.id === 'm-1')?.body ?? ''
    const diff = before.split('\n').filter((line, index) => line !== after.split('\n')[index])
    expect(diff).toHaveLength(1)
    expect(after.split('\n')).toHaveLength(before.split('\n').length)
  })
})

describe('C6 연결', () => {
  it('자기 자신·모양 틀린 키 = 쓰기 0 · 맞는 키 = addRelation · 떼기 되돌리기', async () => {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-link-add]')
    const input = el('[data-link-key]')
    if (!(input instanceof HTMLInputElement)) throw new Error('키 칸 없음')
    setValue(input, 'CORE-2')
    click('[data-link-submit]')
    expect(q('[data-link-error]')).not.toBeNull()
    setValue(input, 'not a key')
    click('[data-link-submit]')
    expect(q('[data-link-error]')).not.toBeNull()
    expect(writes(r.calls)).toHaveLength(0)
    setValue(input, 'core-3')
    click('[data-link-submit]')
    await settle()
    expect(writes(r.calls)).toEqual([expect.objectContaining({ op: 'addRelation', otherKey: 'CORE-3', kind: 'relates_to' })])
    expect(q('[data-link-row="CORE-3"]')).not.toBeNull()
    const remove = q('[data-link-row="CORE-3"] [data-link-remove]')
    if (!(remove instanceof HTMLElement)) throw new Error('떼기 없음')
    act(() => { remove.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(q('[data-link-row="CORE-3"]')).toBeNull()
    const undo = [...document.querySelectorAll('[data-toast="moved"]')].find((entry) => entry.textContent?.includes('연결 뗌'))?.querySelector('[data-toast-undo]')
    act(() => { undo?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(writes(r.calls).map((call) => call.op)).toEqual(['addRelation', 'removeRelation', 'addRelation'])
  })

  it('다른 스페이스 상대에 스페이스 표시', async () => {
    await rig()
    await openCard('CORE-1')
    expect(q('[data-link-row="WEB-1"] [data-link-space="WEB"]')).not.toBeNull()
  })
})

describe('C7 자식', () => {
  it('epic = 목록 + 제목만 추가(첫 자식 종류) · story = 추가 없음', async () => {
    const r = await rig()
    await openCard('CORE-1')
    expect(q('[data-child-row="CORE-2"]')).not.toBeNull()
    click('[data-child-add]')
    const input = el('[data-child-title]')
    if (!(input instanceof HTMLInputElement)) throw new Error('자식 칸 없음')
    setValue(input, '새 자식')
    key(input, { key: 'Enter' })
    await settle()
    expect(writes(r.calls)).toEqual([expect.objectContaining({ op: 'createItem', parentId: 'm-1', kindKey: 'story', title: '새 자식', spaceKey: 'CORE' })])
    expect([...document.querySelectorAll('[data-child-row]')].some((row) => row.textContent?.includes('새 자식'))).toBe(true)
    click('[data-issue-close]')
    await settle()
    await openCard('CORE-2')
    expect(q('[data-child-add]')).toBeNull()
  })
})

describe('C8 저장 충돌', () => {
  it('다른 곳이 바꾼 뒤 저장 → 배너(바뀐 칸) · 내 값으로 덮기', async () => {
    const r = await rig()
    await openCard('CORE-2')
    foreignEdit({ state: r.state, itemId: 'm-2', patch: { title: '웹에서 바꾼 제목', priority: 'low' } })
    click('[data-field="priority"]')
    click('[data-priority-row="highest"]')
    await settle()
    expect(q('[data-issue-conflict]')).not.toBeNull()
    expect([...document.querySelectorAll('[data-conflict-field]')].map((node) => node.getAttribute('data-conflict-field')).sort()).toEqual(['priority', 'title'])
    expect(r.state.items.find((row) => row.id === 'm-2')?.priority).toBe('low')
    click('[data-conflict-override]')
    await settle()
    expect(q('[data-issue-conflict]')).toBeNull()
    expect(r.state.items.find((row) => row.id === 'm-2')?.priority).toBe('highest')
  })

  it('충돌 검사가 꺼진 출처 — 배너 없이 나중 저장이 이긴다', async () => {
    const r = await rig({ token: 'mock_l602_cap-conflictCheck-off' })
    await openCard('CORE-2')
    foreignEdit({ state: r.state, itemId: 'm-2', patch: { priority: 'low' } })
    click('[data-field="priority"]')
    click('[data-priority-row="highest"]')
    await settle()
    expect(q('[data-issue-conflict]')).toBeNull()
    expect(writes(r.calls)).toEqual([expect.objectContaining({ op: 'updateItem', ifVersion: null })])
    expect(r.state.items.find((row) => row.id === 'm-2')?.priority).toBe('highest')
  })
})

describe('C9·C10 활동', () => {
  it('corral 기록과 출처 이력이 같은 쓰기 id 면 한 줄 · 다른 곳 변경은 출처 줄로 남는다', async () => {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-field="priority"]')
    click('[data-priority-row="high"]')
    await settle()
    foreignEdit({ state: r.state, itemId: 'm-2', patch: { title: '웹 제목' } })
    click('[data-issue-close]')
    await settle()
    await openCard('CORE-2')
    await settle()
    const changes = [...document.querySelectorAll('[data-activity-row="change"]')]
    const priorityRows = changes.filter((row) => row.textContent?.includes('우선순위'))
    expect(priorityRows).toHaveLength(1)
    expect(priorityRows[0]?.getAttribute('data-activity-origin')).toBe('corral')
    expect(changes.some((row) => row.getAttribute('data-activity-origin') === 'source' && row.textContent?.includes('웹 제목'))).toBe(true)
  })

  it('양성 대조 — 쓰기 id 를 지우면 같은 변경이 두 줄이 된다(합침이 쓰기 id 로 돈다는 근거)', async () => {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-field="priority"]')
    click('[data-priority-row="high"]')
    await settle()
    for (const entry of r.state.history['m-2'] ?? []) entry.writeId = null
    click('[data-issue-close]')
    await settle()
    await openCard('CORE-2')
    await settle()
    const rows = [...document.querySelectorAll('[data-activity-row="change"]')].filter((row) => row.textContent?.includes('우선순위'))
    expect(rows.map((row) => row.getAttribute('data-activity-origin'))).toEqual(['corral', 'source'])
  })

  it('코멘트 ⌘↵ 남기기 · 꺼진 출처는 이유 한 줄 · 숨긴 출처는 없음', async () => {
    const r = await rig()
    await openCard('CORE-2')
    const area = el('[data-comment-composer] textarea')
    if (!(area instanceof HTMLTextAreaElement)) throw new Error('입력창 없음')
    setValue(area, '코멘트 **굵게**')
    key(area, { key: 'Enter', metaKey: true })
    await settle()
    expect(writes(r.calls)).toEqual([expect.objectContaining({ op: 'addComment', body: '코멘트 **굵게**' })])
    expect([...document.querySelectorAll('[data-activity-row="comment"]')].some((row) => row.querySelector('strong')?.textContent === '굵게')).toBe(true)
    act(() => root.unmount())
    root = createRoot(host)
    await rig({ token: 'mock_l602_cap-comments-off' })
    await openCard('CORE-2')
    expect(q('[data-comment-composer]')).toBeNull()
    expect(q('[data-comment-off]')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await rig({ token: 'mock_l602_cap-comments-hide' })
    await openCard('CORE-2')
    expect(q('[data-comment-composer]')).toBeNull()
    expect(q('[data-comment-off]')).toBeNull()
  })
})

describe('C12 같은 잠금', () => {
  it('상세 쓰기를 출처가 확인하는 동안 그 카드는 잠기고, 상세는 확인 중을 보인다', async () => {
    await rig({ token: 'mock_l602_delay-200' })
    await wait(800)
    await openCard('CORE-2')
    await wait(800)
    click('[data-field="priority"]')
    click('[data-priority-row="high"]')
    await wait(50)
    expect(q('[data-issue-busy]')).not.toBeNull()
    expect(q('[data-tasks-board] [data-issue-card="CORE-2"].is-locked')).not.toBeNull()
    expect(el('[data-issue-status]').getAttribute('aria-disabled')).toBe('true')
    await wait(600)
    expect(q('[data-issue-busy]')).toBeNull()
    expect(q('[data-tasks-board] [data-issue-card="CORE-2"].is-locked')).toBeNull()
  })
})
