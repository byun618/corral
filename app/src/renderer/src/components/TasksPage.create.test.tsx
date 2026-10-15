// @vitest-environment happy-dom
// LIFE-604 작업 만들기 — 진입점 4(머리 「만들기」·`C`·칸 「+ 추가」·섹션 「추가」) · 빠른 생성 모달 · 필수 필드 · 초안 · 하나 더 · 생성 뒤 상세 · 쓰기 안전.
// 실제 WorkService + 모의 출처(Jira 형)를 preload 자리에 잇는다(`TasksPage.service.test.tsx` 선례). 출처가 받은 만들기 요청은 `state.createCalls` 로 센다.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사(tsconfig.web.json)에서 뺀다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import { mockSourceEntry, seedMockDemoState, type MockState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FakeCipher, MemoryStore } from '../../../main/work/test-kit.js'
import { TasksPage } from './TasksPage.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let settingsListener: (value: WorkSettingsState) => void = () => {}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => { toast.dismiss() })
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1)
      else await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

type Harness = {
  service: WorkService; state: MockState; requests: WorkRequest[]; hold: { create: boolean; release: (() => void)[] }; closed: number[]; connectionId: string
  /** `setUiPrefs` 로 나간 값(디스크에 쓰이는 것) — 초안 글이 섞이지 않는지 본다(R1-M). */
  prefsWrites: unknown[]
}

async function setup({ token = 'mock_l604_fixture', state = seedMockDemoState(), prefs = { view: 'board' } }: { token?: string; state?: MockState; prefs?: Record<string, unknown> } = {}): Promise<Harness> {
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]),
    repos: () => [], onChange: (value) => settingsListener(value), now: () => 1_791_800_000_000, newId: () => `id-${Math.random().toString(36).slice(2, 8)}`,
  })
  const requests: WorkRequest[] = []
  const hold: Harness['hold'] = { create: false, release: [] }
  const closed: number[] = []
  const prefsWrites: unknown[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: { space: { kind: 'space', connectionId: '', spaceKey: 'CORE' }, ...prefs } }),
    setUiPrefs: (value: unknown) => { prefsWrites.push(value) },
    getWorkSettings: async () => service.settings(),
    onWorkSettings: (listener: (value: WorkSettingsState) => void) => { settingsListener = listener; return () => {} },
    workActivity: async () => ({ ok: true, records: [] }),
    workRequest: (request: WorkRequest): Promise<WorkResponse> => {
      requests.push(request)
      if (request.call.op === 'createItem' && hold.create) {
        return new Promise((resolve) => { hold.release.push(() => { void service.request(request).then(resolve) }) })
      }
      return service.request(request)
    },
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  // 첫 스페이스 = CORE 로 열리게 저장값의 연결 id 를 맞춘다.
  Reflect.set(window.corral, 'getUiPrefs', async () => ({ tasksPage: { space: { kind: 'space', connectionId: added.connection.id, spaceKey: 'CORE' }, ...prefs } }))
  return { service, state, requests, hold, closed, connectionId: added.connection.id, prefsWrites }
}

async function renderPage(harness: Harness, { open = true }: { open?: boolean } = {}): Promise<void> {
  const page = createElement(TasksPage, { open, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => harness.closed.push(1), onOpenSettings: () => {}, onOpenWorktree: () => {} })
  act(() => root.render(createElement('div', null, page, createElement(Toaster))))
  await settle()
}
const toastText = (kind: string): string => qa(`[data-toast="${kind}"]`).map((node) => node.textContent ?? '').join(' | ')

const q = (selector: string): Element | null => host.querySelector(selector)
const qa = (selector: string): Element[] => [...host.querySelectorAll(selector)]
const el = (selector: string): HTMLElement => {
  const found = q(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`없음: ${selector}`)
  return found
}
const click = (selector: string): void => { act(() => { el(selector).click() }) }
function setValue(selector: string, value: string): void {
  const input = el(selector)
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(target: EventTarget, init: KeyboardEventInit): void {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
}
function valueOf(selector: string): string {
  const node = el(selector)
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : ''
}
const pressC = (): void => key(document.body, { key: 'c' })
const creates = (harness: Harness): number => harness.state.createCalls?.length ?? 0

describe('C1 진입점', () => {
  it('머리 「만들기」 — 검색과 닫기 사이, 누르면 모달이 열리고 제목에 포커스', async () => {
    const harness = await setup()
    await renderPage(harness)
    const head = el('.tasks-head')
    const order = [...head.children].map((child) => (child.hasAttribute('data-tasks-search') ? 'search' : child.hasAttribute('data-tasks-create') ? 'create' : child.hasAttribute('data-tasks-close') ? 'close' : '')).filter((entry) => entry !== '')
    expect(order).toEqual(['search', 'create', 'close'])
    click('[data-tasks-create]')
    await settle()
    expect(q('[data-quick-create]')).not.toBeNull()
    expect(document.activeElement).toBe(q('[data-quick-create-title]'))
  })

  it('`C` — 페이지에서 열림 · 입력 중·수정키·IME·열린 모달이면 무시', async () => {
    const harness = await setup()
    await renderPage(harness)
    // 검색 칸에서 c 는 글자다.
    key(el('[data-tasks-search]'), { key: 'c' })
    key(document.body, { key: 'c', metaKey: true })
    key(document.body, { key: 'c', isComposing: true })
    await settle()
    expect(q('[data-quick-create]')).toBeNull()
    pressC()
    await settle()
    expect(q('[data-quick-create]')).not.toBeNull()
    const session = el('[data-quick-create-title]')
    // 모달이 열린 동안 C 는 새 모달을 열지 않는다(제목 칸 밖 — 버튼에서 눌러도).
    key(el('[data-quick-create-cancel]'), { key: 'c' })
    expect(qa('[data-quick-create]')).toHaveLength(1)
    expect(el('[data-quick-create-title]')).toBe(session)
  })

  it('쓰기가 막히면(권한 부족 배너) 머리 「만들기」 흐림 + 이유 · `C` 안 열림 · 칸 「+ 추가」 흐림', async () => {
    const harness = await setup({ token: 'mock_fault-forbidden' })
    await renderPage(harness)
    const button = el('[data-tasks-create]')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('title')).toContain('권한')
    click('[data-tasks-create]')
    pressC()
    await settle()
    expect(q('[data-quick-create]')).toBeNull()
  })

  it('칸 「+ 추가」 → 한 줄 입력 · 섹션 「추가」 → 그 배치로 모달', async () => {
    const harness = await setup()
    await renderPage(harness)
    const todo = el('[data-board-column="st:core-todo"]')
    act(() => { todo.querySelector<HTMLElement>('[data-inline-add-open]')?.click() })
    await settle()
    expect(todo.querySelector('[data-inline-add]')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    const backlog = await setup({ prefs: { view: 'backlog' } })
    await renderPage(backlog)
    click('[data-section-add="backlog"]')
    await settle()
    expect(q('[data-quick-create]')).not.toBeNull()
    expect(el('[data-quick-create-placement="backlog"]').getAttribute('aria-checked')).toBe('true')
  })
})

describe('C2·C8 빠른 생성 모달', () => {
  it('종류 = 그 스페이스 종류(기본 = 자식을 받지 않는 첫 종류) · 상태는 메타가 허용한 것만 + 각주 · 부모 후보는 그 종류를 받는 작업만', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    expect(qa('[data-quick-create-kind]').map((node) => node.getAttribute('data-quick-create-kind'))).toEqual(['epic', 'story', 'bug'])
    expect(el('[data-quick-create-kind="story"]').getAttribute('aria-checked')).toBe('true')
    click('[data-quick-create-status]')
    expect(qa('[data-quick-create-status-row]').map((node) => node.getAttribute('data-quick-create-status-row'))).toEqual(['core-todo'])
    expect(el('[data-quick-create-status-note]').textContent).toContain('첫 상태로만')
    click('[data-quick-create-parent]')
    // Story 를 받는 것은 Epic(CORE-1) 뿐.
    expect(qa('[data-quick-create-parent-row]').map((node) => node.getAttribute('data-quick-create-parent-row')).filter((entry) => entry !== '')).toEqual(['CORE-1'])
    click('[data-quick-create-parent-row="CORE-1"]')
    expect(el('[data-quick-create-parent]').textContent).toContain('CORE-1')
    // Epic 으로 바꾸면 Epic 은 Epic 을 받지 않는다 → 부모를 비우고 알린다.
    click('[data-quick-create-kind="epic"]')
    await settle()
    expect(el('[data-quick-create-parent]').textContent).toContain('부모 없음')
    expect(el('[data-quick-create-notice]').textContent).toContain('CORE-1')
  })

  it('제목이 공백뿐이면 만들기 흐림 · Bug 는 필수 필드 상자가 나타나고 값 전까지 흐림', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    const submit = (): HTMLButtonElement => {
      const node = el('[data-quick-create-submit]')
      if (!(node instanceof HTMLButtonElement)) throw new Error('submit')
      return node
    }
    setValue('[data-quick-create-title]', '   ')
    expect(submit().disabled).toBe(true)
    setValue('[data-quick-create-title]', '버그 하나')
    expect(submit().disabled).toBe(false)
    expect(q('[data-quick-create-required]')).toBeNull()
    click('[data-quick-create-kind="bug"]')
    await settle()
    expect(q('[data-quick-create-required]')).not.toBeNull()
    expect(submit().disabled).toBe(true)
    click('[data-quick-create-option="impact-high"]')
    expect(submit().disabled).toBe(false)
    key(el('[data-quick-create-title]'), { key: 'Enter', metaKey: true })
    await settle()
    expect(harness.state.createCalls?.at(-1)).toMatchObject({ kindKey: 'bug', title: '버그 하나', statusKey: 'core-todo', placement: 'board', fields: [{ key: 'customfield_impact', value: 'impact-high' }] })
  })

  it('지원 밖 모양의 필수 필드 — 「corral 에서 채울 수 없음」 + 만들기 막힘(양성 대조: Story 는 열림)', async () => {
    const harness = await setup({ token: 'mock_createmeta-unsupported' })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '에픽')
    click('[data-quick-create-kind="epic"]')
    await settle()
    expect(el('[data-quick-create-unsupported]').textContent).toContain('corral 에서 채울 수 없음')
    expect(el('[data-quick-create-submit]').hasAttribute('disabled')).toBe(true)
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    expect(creates(harness)).toBe(0)
    click('[data-quick-create-kind="story"]')
    await settle()
    expect(el('[data-quick-create-submit]').hasAttribute('disabled')).toBe(false)
  })

  it('메타 실패 — 이유 + 다시 시도, 만들기 막힘', async () => {
    const harness = await setup({ token: 'mock_createmeta-fail' })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', 't')
    expect(q('[data-quick-create-meta-error]')).not.toBeNull()
    expect(el('[data-quick-create-submit]').hasAttribute('disabled')).toBe(true)
    const before = harness.requests.filter((request) => request.call.op === 'getCreateMeta').length
    click('[data-quick-create-meta-retry]')
    await settle()
    expect(harness.requests.filter((request) => request.call.op === 'getCreateMeta').length).toBe(before + 1)
  })

  it('IME 조합 중 Enter 는 만들지 않는다 · 제목 Enter 는 만든다', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '한글 제목')
    key(el('[data-quick-create-title]'), { key: 'Enter', isComposing: true })
    await settle()
    expect(creates(harness)).toBe(0)
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    expect(creates(harness)).toBe(1)
  })

  it('모달이 열린 동안 페이지 키(`/`·`1–4`)가 새지 않고, Esc 는 모달만 닫는다(페이지는 그대로)', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    const button = el('[data-quick-create-cancel]')
    key(button, { key: '/' })
    key(button, { key: '2' })
    await settle()
    expect(document.activeElement).not.toBe(q('[data-tasks-search]'))
    expect(el('[data-tasks-page]').getAttribute('data-tasks-view')).toBe('board')
    key(button, { key: 'Escape' })
    await settle()
    expect(q('[data-quick-create]')).toBeNull()
    expect(harness.closed).toHaveLength(0)
  })
})

describe('C5 스페이스별 초안', () => {
  it('글이 있는 채 닫으면 남고 다시 열면 복원 + 안내 · 다른 스페이스는 섞이지 않음 · 비어서 닫으면 없음 · 성공하면 지움', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '초안 제목')
    setValue('[data-quick-create-body]', '초안 본문')
    expect(q('[data-quick-create-draft]')).not.toBeNull()
    key(el('[data-quick-create-title]'), { key: 'Escape' })
    await settle()
    expect(q('[data-quick-create]')).toBeNull()
    pressC()
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('초안 제목')
    expect(valueOf('[data-quick-create-body]')).toBe('초안 본문')
    click('[data-quick-create-cancel]')
    // 다른 스페이스(WEB)로 옮겨 열면 빈 모달.
    click('[data-space-switch]')
    click('[data-space-row="WEB"]')
    await settle()
    pressC()
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('')
    click('[data-quick-create-cancel]')
    // CORE 로 돌아와 초안으로 만들면 초안이 지워진다.
    click('[data-space-switch]')
    click('[data-space-row="CORE"]')
    await settle()
    pressC()
    await settle()
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    pressC()
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('')
    expect(q('[data-quick-create-draft]')).toBeNull()
  })

  it('연결이 해제되면 그 연결 초안을 버린다(같은 출처로 다시 붙여도 복원 없음)', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '버려질 초안')
    click('[data-quick-create-cancel]')
    await act(async () => { harness.service.removeConnection({ connectionId: harness.connectionId }) })
    await act(async () => { settingsListener(harness.service.settings()) })
    await settle()
    const again = await harness.service.addConnection({ sourceId: 'mock-jira', token: 'mock_l604_fixture', replaceId: null })
    if (!again.ok) throw new Error('re-add')
    await act(async () => { settingsListener(harness.service.settings()) })
    await settle(12)
    // 판별은 훅 시험(`useQuickCreate.test.tsx` — 해제 뒤 초안 맵이 빈다)이 한다. 여기서는 다시 붙인 연결에서 실제로 모달이 열려 빈 폼인지까지 본다.
    expect(q('[data-tasks-create]')?.getAttribute('aria-disabled')).not.toBe('true')
    pressC()
    await settle()
    const title = q('[data-quick-create-title]')
    expect(title instanceof HTMLInputElement ? title.value : '').toBe('')
  })
})

describe('C6 하나 더 · 생성 뒤 상세', () => {
  it('끔 = 모달 닫고 그 작업 상세(토글 아님) · 새 작업은 서버 정본으로 보드에 한 장', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '새 스토리')
    key(el('[data-quick-create-title]'), { key: 'Enter', metaKey: true })
    await settle(12)
    expect(q('[data-quick-create]')).toBeNull()
    const made = harness.state.items.find((item) => item.title === '새 스토리')
    if (made === undefined) throw new Error('없음')
    expect(q(`[data-issue-detail="${made.key}"]`)).not.toBeNull()
    expect(qa(`[data-issue-card="${made.key}"]`)).toHaveLength(1)
  })

  it('켬 = 모달 유지 · 제목·설명·필수 값만 비우고 종류·부모·상태·우선순위·배치 유지 · 제목 포커스', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    click('[data-quick-create-another]')
    click('[data-quick-create-kind="bug"]')
    await settle()
    click('[data-quick-create-option="impact-low"]')
    click('[data-quick-create-parent]')
    click('[data-quick-create-parent-row="CORE-1"]')
    click('[data-quick-create-priority]')
    click('[data-quick-create-placement="backlog"]')
    setValue('[data-quick-create-title]', '첫째')
    setValue('[data-quick-create-body]', '설명')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    expect(q('[data-quick-create]')).not.toBeNull()
    expect(valueOf('[data-quick-create-title]')).toBe('')
    expect(valueOf('[data-quick-create-body]')).toBe('')
    expect(el('[data-quick-create-kind="bug"]').getAttribute('aria-checked')).toBe('true')
    expect(el('[data-quick-create-parent]').textContent).toContain('CORE-1')
    expect(el('[data-quick-create-priority]').getAttribute('data-quick-create-priority')).toBe('highest')
    expect(el('[data-quick-create-placement="backlog"]').getAttribute('aria-checked')).toBe('true')
    expect(el('[data-quick-create-option="impact-low"]').getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(q('[data-quick-create-title]'))
    expect(harness.state.createCalls?.at(-1)).toMatchObject({ parentId: 'm-1', priority: 'highest', placement: 'backlog', body: '설명' })
  })
})

describe('C9 쓰기 안전', () => {
  it('만들기·⌘↵·Enter 연타 = 출처 만들기 1회', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    harness.hold.create = true
    setValue('[data-quick-create-title]', '연타')
    click('[data-quick-create-submit]')
    click('[data-quick-create-submit]')
    key(el('[data-quick-create-title]'), { key: 'Enter', metaKey: true })
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    expect(harness.requests.filter((request) => request.call.op === 'createItem')).toHaveLength(1)
    harness.hold.create = false
    act(() => { for (const release of harness.hold.release.splice(0)) release() })
    await settle(12)
    expect(creates(harness)).toBe(1)
  })

  it('실패 — 값 보존 + 분류 문구 · 다시 만들기 가능', async () => {
    const harness = await setup({ token: 'mock_reject-writes' })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '거절될 것')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    expect(el('[data-quick-create-error]').textContent).toContain('출처가 거절했습니다')
    expect(valueOf('[data-quick-create-title]')).toBe('거절될 것')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    expect(creates(harness)).toBe(2)
  })

  it('late(30초) — 실패가 아니다: 「확인 중」, 다시 보내지 못함 · 재전송 0 · 확정 성공이면 상세', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    vi.useFakeTimers()
    harness.hold.create = true
    setValue('[data-quick-create-title]', '늦은 만들기')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    await settle()
    expect(el('[data-quick-create]').getAttribute('data-quick-create-phase')).toBe('late')
    expect(q('[data-quick-create-error]')).toBeNull()
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    click('[data-quick-create-submit]')
    await settle()
    expect(harness.requests.filter((request) => request.call.op === 'createItem')).toHaveLength(1)
    harness.hold.create = false
    await act(async () => { for (const release of harness.hold.release.splice(0)) release() })
    await settle(16)
    expect(q('[data-quick-create]')).toBeNull()
    const made = harness.state.items.find((item) => item.title === '늦은 만들기')
    expect(made).toBeDefined()
    expect(q(`[data-issue-detail="${made?.key ?? ''}"]`)).not.toBeNull()
    expect(creates(harness)).toBe(1)
  })

  it('보내는 중 닫으면 초안을 남기지 않고, 다시 열어도 앞 만들기가 끝날 때까지 보내지 못한다(잠금 유지)', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    harness.hold.create = true
    setValue('[data-quick-create-title]', '닫힌 뒤 성공')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    click('[data-quick-create-cancel]')
    pressC()
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('')
    setValue('[data-quick-create-title]', '두 번째')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    expect(harness.requests.filter((request) => request.call.op === 'createItem')).toHaveLength(1)
    harness.hold.create = false
    await act(async () => { for (const release of harness.hold.release.splice(0)) release() })
    await settle(12)
    expect(creates(harness)).toBe(1)
    // 잠금이 풀리면 지금 모달에서 보낼 수 있다.
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    expect(creates(harness)).toBe(2)
  })
})

describe('C7 인라인 추가', () => {
  it('Enter = 그 칸 상태 · 보드 · 기본 종류로 만들고, 입력은 비운 채 열림(연속) · 만들 수 없는 칸은 흐림 + 이유 · Esc 닫기', async () => {
    const harness = await setup()
    await renderPage(harness)
    const todo = (): HTMLElement => el('[data-board-column="st:core-todo"]')
    act(() => { todo().querySelector<HTMLElement>('[data-inline-add-open]')?.click() })
    await settle()
    const input = (): HTMLInputElement => {
      const node = todo().querySelector('[data-inline-add]')
      if (!(node instanceof HTMLInputElement)) throw new Error('입력 없음')
      return node
    }
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), '인라인 하나')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    key(input(), { key: 'Enter' })
    key(input(), { key: 'Enter' })
    await settle(12)
    expect(harness.state.createCalls).toHaveLength(1)
    expect(harness.state.createCalls?.[0]).toMatchObject({ kindKey: 'story', statusKey: 'core-todo', placement: 'board', parentId: null, title: '인라인 하나' })
    expect(input().value).toBe('')
    // 메타를 받은 뒤 — 첫 상태가 아닌 칸은 흐림 + 이유.
    const doing = el('[data-board-column="st:core-doing"]').querySelector('[data-inline-add-open]')
    expect(doing?.getAttribute('aria-disabled')).toBe('true')
    expect(doing?.getAttribute('title')).toContain('이 상태로 바로 만들 수 없습니다')
    key(input(), { key: 'Escape' })
    await settle()
    expect(todo().querySelector('[data-inline-add]')).toBeNull()
    expect(harness.closed).toHaveLength(0)
  })

  it('기본 종류에 필수 필드가 있으면 Enter 는 그 값으로 모달을 연다 — 빈 값 전송 0', async () => {
    const state = seedMockDemoState()
    state.createFields = { story: [{ key: 'customfield_env', label: 'Environment', shape: 'text' }] }
    const harness = await setup({ state })
    await renderPage(harness)
    const todo = el('[data-board-column="st:core-todo"]')
    act(() => { todo.querySelector<HTMLElement>('[data-inline-add-open]')?.click() })
    await settle()
    const input = todo.querySelector('[data-inline-add]')
    if (!(input instanceof HTMLInputElement)) throw new Error('입력 없음')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '필수 있는 종류')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key(input, { key: 'Enter' })
    await settle()
    expect(creates(harness)).toBe(0)
    expect(valueOf('[data-quick-create-title]')).toBe('필수 있는 종류')
    expect(q('[data-quick-create-required]')).not.toBeNull()
  })
})

describe('「전체」 스페이스', () => {
  it('모달 머리에서 만들 스페이스를 보이고 고른다(기본 = 보이는 첫 스페이스) · 보드 분류 칸에는 「+ 추가」 가 없다', async () => {
    const harness = await setup({ prefs: { view: 'board' } })
    Reflect.set(window.corral, 'getUiPrefs', async () => ({ tasksPage: { space: { kind: 'all' }, view: 'board' } }))
    await renderPage(harness)
    expect(q('[data-inline-add-open]')).toBeNull()
    pressC()
    await settle()
    expect(el('[data-quick-create-target]').textContent).toContain('Core Platform')
    click('[data-quick-create-target]')
    click('[data-quick-create-target-row="WEB"]')
    await settle()
    expect(el('[data-quick-create-target]').textContent).toContain('Web')
    setValue('[data-quick-create-title]', '웹에')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    expect(harness.state.createCalls?.at(-1)).toMatchObject({ spaceKey: 'WEB', statusKey: 'web-open' })
  })
})

describe('수정 1 (리뷰 r1)', () => {
  const typeInline = (column: HTMLElement, text: string): HTMLInputElement => {
    const input = column.querySelector('[data-inline-add]')
    if (!(input instanceof HTMLInputElement)) throw new Error('입력 없음')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    return input
  }
  const openTodoInline = async (): Promise<HTMLElement> => {
    const todo = el('[data-board-column="st:core-todo"]')
    act(() => { todo.querySelector<HTMLElement>('[data-inline-add-open]')?.click() })
    await settle()
    return todo
  }

  it('R1-A 결과를 모르는 만들기(모달) — 「모름」: 다시 보내지 못함(재전송 0) · 「목록 다시 확인」 뒤에야 다시 만들 수 있다', async () => {
    // 한 쪽에 다 들어오게 — 다시 확인한 목록에 출처에 생긴 작업이 보이는지까지 본다(커서 쪽 밖이면 「더 불러오기」 몫).
    const state = seedMockDemoState()
    state.pageSize = 100
    const harness = await setup({ token: 'mock_create-lost', state })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '잃은 답')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    expect(el('[data-quick-create]').getAttribute('data-quick-create-phase')).toBe('unknown')
    expect(el('[data-quick-create-error]').textContent).toContain('만들어졌는지 모릅니다')
    expect(el('[data-quick-create-submit]').hasAttribute('disabled')).toBe(true)
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    key(el('[data-quick-create-title]'), { key: 'Enter', metaKey: true })
    click('[data-quick-create-submit]')
    await settle()
    expect(harness.requests.filter((request) => request.call.op === 'createItem')).toHaveLength(1)
    // 닫았다 다시 열어도 「모름」 이 남는다(값은 초안으로).
    click('[data-quick-create-cancel]')
    pressC()
    await settle()
    expect(el('[data-quick-create]').getAttribute('data-quick-create-phase')).toBe('unknown')
    expect(valueOf('[data-quick-create-title]')).toBe('잃은 답')
    // 확인 — 목록을 다시 받으면 출처에 생긴 작업이 보이고, 그 뒤에는 보낼 수 있다.
    const lists = harness.requests.filter((request) => request.call.op === 'listItems').length
    click('[data-quick-create-recheck]')
    await settle(12)
    expect(harness.requests.filter((request) => request.call.op === 'listItems').length).toBeGreaterThan(lists)
    expect(el('[data-quick-create]').getAttribute('data-quick-create-phase')).toBe('idle')
    expect(el('[data-quick-create-notice]').textContent).toContain('목록을 다시 읽었습니다')
    const made = harness.state.items.find((item) => item.title === '잃은 답')
    expect(qa(`[data-issue-card="${made?.key ?? '-'}"]`)).toHaveLength(1)
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    expect(harness.requests.filter((request) => request.call.op === 'createItem')).toHaveLength(2)
  })

  it('R1-A 대조 — 거절(결과를 앎)은 「모름」 이 아니다: 바로 다시 만들 수 있다', async () => {
    const harness = await setup({ token: 'mock_reject-writes' })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '거절')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    expect(el('[data-quick-create]').getAttribute('data-quick-create-phase')).toBe('idle')
    expect(q('[data-quick-create-recheck]')).toBeNull()
  })

  it('R1-A 결과를 모르는 만들기(인라인) — 「모름」 + 글 보존 · Enter 재전송 0 · 확인 뒤 다시', async () => {
    const harness = await setup({ token: 'mock_create-lost' })
    await renderPage(harness)
    const todo = await openTodoInline()
    const input = typeInline(todo, '인라인 잃은 답')
    key(input, { key: 'Enter' })
    await settle(12)
    expect(input.getAttribute('data-inline-add-phase')).toBe('unknown')
    expect(input.value).toBe('인라인 잃은 답')
    expect(el('[data-inline-add-error]').textContent).toContain('만들어졌는지 모릅니다')
    key(input, { key: 'Enter' })
    await settle()
    expect(harness.requests.filter((request) => request.call.op === 'createItem')).toHaveLength(1)
    click('[data-inline-add-recheck]')
    await settle(12)
    expect(el('[data-board-column="st:core-todo"] [data-inline-add]').getAttribute('data-inline-add-phase')).toBe('idle')
  })

  it('R1-B 커서 쪽 밖에 만든 작업 — 상세에서 상태를 바꾼 뒤 재조회해도 옛 값으로 덮지 않는다', async () => {
    const state = seedMockDemoState()
    state.pageSize = 3
    const harness = await setup({ state })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '쪽 밖')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    const made = harness.state.items.find((item) => item.title === '쪽 밖')
    if (made === undefined) throw new Error('없음')
    expect(el(`[data-issue-card="${made.key}"]`).closest('[data-board-column]')?.getAttribute('data-board-column')).toBe('st:core-todo')
    // 상세(생성 뒤 열림)에서 상태를 바꾼다.
    click('[data-issue-status]')
    await settle()
    click('[data-status-row="core-doing"]')
    await settle(12)
    expect(harness.state.items.find((item) => item.id === made.id)?.statusKey).toBe('core-doing')
    // 스페이스를 갔다 와서 다시 읽는다 — 새 작업은 아직 받지 않은 쪽에 있다.
    click('[data-space-switch]')
    click('[data-space-row="WEB"]')
    await settle()
    click('[data-space-switch]')
    click('[data-space-row="CORE"]')
    await settle(12)
    expect(q('[data-tasks-more-button]')).not.toBeNull()
    expect(qa(`[data-issue-card="${made.key}"]`)).toHaveLength(1)
    expect(el(`[data-issue-card="${made.key}"]`).closest('[data-board-column]')?.getAttribute('data-board-column')).toBe('st:core-doing')
  })

  it('R1-B 커서 쪽 밖에 만든 작업 — 출처(앱 밖)에서 상태가 바뀌거나 지워지면 재조회 뒤 그 값을 따른다', async () => {
    const state = seedMockDemoState()
    state.pageSize = 3
    const harness = await setup({ state })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '밖에서 바뀜')
    click('[data-quick-create-another]')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    setValue('[data-quick-create-title]', '밖에서 지워짐')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    click('[data-quick-create-cancel]')
    const changed = harness.state.items.find((item) => item.title === '밖에서 바뀜')
    const removed = harness.state.items.find((item) => item.title === '밖에서 지워짐')
    if (changed === undefined || removed === undefined) throw new Error('없음')
    expect(qa(`[data-issue-card="${removed.key}"]`)).toHaveLength(1)
    // 앱을 거치지 않고 출처 값을 바꾼다(다른 클라이언트).
    harness.state.items = harness.state.items.filter((item) => item.id !== removed.id).map((item) => (item.id === changed.id ? { ...item, statusKey: 'core-doing' } : item))
    click('[data-space-switch]')
    click('[data-space-row="WEB"]')
    await settle()
    click('[data-space-switch]')
    click('[data-space-row="CORE"]')
    await settle(16)
    expect(q('[data-tasks-more-button]')).not.toBeNull()
    expect(el(`[data-issue-card="${changed.key}"]`).closest('[data-board-column]')?.getAttribute('data-board-column')).toBe('st:core-doing')
    expect(qa(`[data-issue-card="${removed.key}"]`)).toHaveLength(0)
  })

  it('R1-C 진입점 값으로 연 모달(섹션 추가·인라인→모달)을 닫아도 기존 초안은 그대로', async () => {
    const harness = await setup({ prefs: { view: 'backlog' } })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '남겨야 할 초안')
    click('[data-quick-create-cancel]')
    click('[data-section-add="backlog"]')
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('')
    click('[data-quick-create-cancel]')
    pressC()
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('남겨야 할 초안')
    click('[data-quick-create-cancel]')
  })

  it('R1-C 인라인 → 모달(필수 필드) 경로도 기존 초안을 덮지 않는다', async () => {
    const state = seedMockDemoState()
    state.createFields = { story: [{ key: 'customfield_env', label: 'Environment', shape: 'text' }] }
    const harness = await setup({ state })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '원래 초안')
    click('[data-quick-create-cancel]')
    const todo = await openTodoInline()
    const input = typeInline(todo, '인라인 제목')
    key(input, { key: 'Enter' })
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('인라인 제목')
    click('[data-quick-create-cancel]')
    pressC()
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('원래 초안')
  })

  it('R1-D 초안의 부모가 목록에서 사라지면 비우고 알린다 — 칩과 요청이 같다(부모 없이 만든다)', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '부모 있던 초안')
    click('[data-quick-create-parent]')
    click('[data-quick-create-parent-row="CORE-1"]')
    click('[data-quick-create-cancel]')
    // 출처에서 CORE-1 이 사라진다(자식 CORE-2·4·7 은 부모 없음으로).
    harness.state.items = harness.state.items.filter((item) => item.id !== 'm-1').map((item) => (item.parentId === 'm-1' ? { ...item, parentId: null } : item))
    click('[data-space-switch]')
    click('[data-space-row="WEB"]')
    await settle()
    click('[data-space-switch]')
    click('[data-space-row="CORE"]')
    await settle(12)
    pressC()
    await settle()
    expect(el('[data-quick-create-parent]').textContent).toContain('부모 없음')
    expect(el('[data-quick-create-notice]').textContent).toContain('부모가 지금 목록에 없어')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle(12)
    expect(harness.state.createCalls?.at(-1)).toMatchObject({ title: '부모 있던 초안', parentId: null })
  })

  it('R1-E 한글 자판 — `key: ㅊ, code: KeyC` 로도 열린다 · Shift 면 무시', async () => {
    const harness = await setup()
    await renderPage(harness)
    key(document.body, { key: 'ㅊ', code: 'KeyC', shiftKey: true })
    await settle()
    expect(q('[data-quick-create]')).toBeNull()
    key(document.body, { key: 'ㅊ', code: 'KeyC', isComposing: true })
    await settle()
    expect(q('[data-quick-create]')).toBeNull()
    key(document.body, { key: 'ㅊ', code: 'KeyC' })
    await settle()
    expect(q('[data-quick-create]')).not.toBeNull()
  })

  it('R1-H 복원한 초안을 고쳐 보내다 닫고 실패하면 고친 값이 초안으로 돌아온다 + 토스트', async () => {
    const harness = await setup({ token: 'mock_reject-writes' })
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', 'A 초안')
    click('[data-quick-create-cancel]')
    pressC()
    await settle()
    setValue('[data-quick-create-title]', 'B 고침')
    harness.hold.create = true
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    click('[data-quick-create-cancel]')
    harness.hold.create = false
    await act(async () => { for (const release of harness.hold.release.splice(0)) release() })
    await settle(12)
    expect(toastText('failed')).toContain('초안으로 남겼습니다')
    pressC()
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('B 고침')
  })

  it('R1-I 모달이 열린 채 페이지가 닫히면 모달도 닫힌다 — 밖의 Esc 를 가로채지 않는다(글은 초안으로)', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    setValue('[data-quick-create-title]', '닫힐 때 남김')
    await renderPage(harness, { open: false })
    expect(q('[data-quick-create]')).toBeNull()
    const outside = document.createElement('textarea')
    document.body.append(outside)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    let reached = false
    outside.addEventListener('keydown', () => { reached = true })
    act(() => { outside.dispatchEvent(event) })
    outside.remove()
    expect(reached).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    await renderPage(harness)
    pressC()
    await settle()
    expect(valueOf('[data-quick-create-title]')).toBe('닫힐 때 남김')
  })

  it('R1-J 연결 세대가 바뀐 뒤 온 늦은 응답 — 결과를 확인하지 못함(「모름」), 출처 생성 1건', async () => {
    const harness = await setup()
    await renderPage(harness)
    pressC()
    await settle()
    harness.hold.create = true
    setValue('[data-quick-create-title]', '세대 바뀜')
    key(el('[data-quick-create-title]'), { key: 'Enter' })
    await settle()
    // 토큰 교체(같은 연결, 세대 +1).
    const replaced = await harness.service.addConnection({ sourceId: 'mock-jira', token: 'mock_l604_fixture', replaceId: harness.connectionId })
    if (!replaced.ok) throw new Error('replace')
    await act(async () => { settingsListener(harness.service.settings()) })
    await settle()
    harness.hold.create = false
    await act(async () => { for (const release of harness.hold.release.splice(0)) release() })
    await settle(12)
    expect(el('[data-quick-create]').getAttribute('data-quick-create-phase')).toBe('unknown')
    expect(el('[data-quick-create-error]').textContent).toContain('연결이 바뀌어')
    expect(creates(harness)).toBe(1)
  })

  it('R1-J 인라인 실패 — 값 보존 + 분류 문구 · 보내는 중 Esc·blur 로 닫히지 않음 · late 는 「확인 중」', async () => {
    const harness = await setup({ token: 'mock_reject-writes' })
    await renderPage(harness)
    const todo = await openTodoInline()
    const input = typeInline(todo, '인라인 거절')
    harness.hold.create = true
    vi.useFakeTimers()
    key(input, { key: 'Enter' })
    await settle()
    expect(input.getAttribute('data-inline-add-phase')).toBe('sending')
    key(input, { key: 'Escape' })
    act(() => { input.dispatchEvent(new FocusEvent('blur')) ; input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    await settle()
    expect(todo.querySelector('[data-inline-add]')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    await settle()
    expect(el('[data-board-column="st:core-todo"] [data-inline-add]').getAttribute('data-inline-add-phase')).toBe('late')
    expect(el('[data-inline-add-busy]').textContent).toContain('확인 중')
    harness.hold.create = false
    await act(async () => { for (const release of harness.hold.release.splice(0)) release() })
    await settle(12)
    const after = el('[data-board-column="st:core-todo"] [data-inline-add]')
    expect(after.getAttribute('data-inline-add-phase')).toBe('idle')
    expect(after instanceof HTMLInputElement ? after.value : '').toBe('인라인 거절')
    expect(el('[data-inline-add-error]').textContent).toContain('출처가 거절했습니다')
    expect(creates(harness)).toBe(1)
  })

  it('R1-O 인라인 — blur 로 닫히고(C7) 친 글은 칸에 남아 다시 열면 돌아온다', async () => {
    const harness = await setup()
    await renderPage(harness)
    const todo = await openTodoInline()
    const input = typeInline(todo, '쓰다 만 글')
    act(() => { input.dispatchEvent(new FocusEvent('blur')); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    await settle()
    expect(todo.querySelector('[data-inline-add]')).toBeNull()
    act(() => { todo.querySelector<HTMLElement>('[data-inline-add-open]')?.click() })
    await settle()
    const again = todo.querySelector('[data-inline-add]')
    expect(again instanceof HTMLInputElement ? again.value : '').toBe('쓰다 만 글')
    expect(creates(harness)).toBe(0)
  })

  it('R1-M 초안 글은 디스크(ui-prefs)·로그로 나가지 않는다 — 출처 만들기 요청에만', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true })
    try {
      const harness = await setup()
      await renderPage(harness)
      pressC()
      await settle()
      setValue('[data-quick-create-title]', '비밀스러운초안제목')
      setValue('[data-quick-create-body]', '비밀스러운초안본문')
      click('[data-quick-create-cancel]')
      click('[data-space-switch]')
      click('[data-space-row="WEB"]')
      await settle()
      click('[data-space-switch]')
      click('[data-space-row="CORE"]')
      await settle()
      pressC()
      await settle()
      key(el('[data-quick-create-title]'), { key: 'Enter' })
      await settle(12)
      expect(harness.state.createCalls?.at(-1)).toMatchObject({ title: '비밀스러운초안제목' })
      // 양성 대조 — 기록기가 실제로 줄을 받았고(작업 요청 로그), ui-prefs 쓰기도 일어났다.
      expect(lines.some((line) => line.includes('"op":"createItem"'))).toBe(true)
      expect(harness.prefsWrites.length).toBeGreaterThan(0)
      const written = JSON.stringify(harness.prefsWrites) + lines.join('')
      expect(written).not.toContain('비밀스러운초안')
    } finally {
      spy.mockRestore()
    }
  })
})
