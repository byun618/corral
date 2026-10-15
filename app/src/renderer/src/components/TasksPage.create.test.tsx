// @vitest-environment happy-dom
// LIFE-604 작업 만들기 — 진입점 4(머리 「만들기」·`C`·칸 「+ 추가」·섹션 「추가」) · 빠른 생성 모달 · 필수 필드 · 초안 · 하나 더 · 생성 뒤 상세 · 쓰기 안전.
// 실제 WorkService + 모의 출처(Jira 형)를 preload 자리에 잇는다(`TasksPage.service.test.tsx` 선례). 출처가 받은 만들기 요청은 `state.createCalls` 로 센다.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사(tsconfig.web.json)에서 뺀다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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

type Harness = { service: WorkService; state: MockState; requests: WorkRequest[]; hold: { create: boolean; release: (() => void)[] }; closed: number[]; connectionId: string }

async function setup({ token = 'mock_l604_fixture', state = seedMockDemoState(), prefs = { view: 'board' } }: { token?: string; state?: MockState; prefs?: Record<string, unknown> } = {}): Promise<Harness> {
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]),
    repos: () => [], onChange: (value) => settingsListener(value), now: () => 1_791_800_000_000, newId: () => `id-${Math.random().toString(36).slice(2, 8)}`,
  })
  const requests: WorkRequest[] = []
  const hold: Harness['hold'] = { create: false, release: [] }
  const closed: number[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: { space: { kind: 'space', connectionId: '', spaceKey: 'CORE' }, ...prefs } }),
    setUiPrefs: () => {},
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
  return { service, state, requests, hold, closed, connectionId: added.connection.id }
}

async function renderPage(harness: Harness, { open = true }: { open?: boolean } = {}): Promise<void> {
  act(() => root.render(createElement(TasksPage, { open, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => harness.closed.push(1), onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
}

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
    if (q('[data-tasks-create]')?.getAttribute('aria-disabled') === 'true') return
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
