// @vitest-environment happy-dom
// LIFE-632 C5 ② — 모의 출처(충돌 검사 켜짐)에서 자기 충돌: 같은 카드에 답이 안 온 내 쓰기가 있으면 상세 쓰기는 기다린다(배너 아님).
// 출발점: 622 리뷰 r2 `codex-r2-raw/detail-self.log`(같은 칸 연속 저장) · 632 리뷰 r1 `codex-r1-raw/TaskDetail.review-mock.test.tsx`(이식).
// 실제 경로 React `TasksPage` → hook → `WorkService` → 모의 출처. A 의 늦음은 렌더러 30초 한도 타이머만 손으로 터뜨린다. 렌더러와 main 을 함께 import 하므로 mixed 검사에 둔다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { mockSourceEntry, seedMockDemoState, type MockState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FAKE_MOCK_TOKEN, FakeCipher, MemoryStore } from '../../../main/work/test-kit.js'
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

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

type Rig = { service: WorkService; state: MockState; calls: WorkCall[]; connectionId: string }

async function rig(): Promise<Rig> {
  const state = seedMockDemoState()
  let seq = 0
  let listener: (value: WorkSettingsState) => void = () => {}
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]), activity: new MemoryActivity(),
    repos: () => [], onChange: (value) => listener(value), now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const result: Rig = { service, state, calls: [], connectionId: added.connection.id }
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: (request: WorkRequest) => { result.calls.push(request.call); return service.request(request) },
    workActivity: async (query: unknown) => service.activity(query),
  })
  act(() => root.render(createElement('div', null, createElement(TasksPageInPanel, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
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
function input(selector: string): HTMLInputElement | HTMLTextAreaElement {
  const target = el(selector)
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) throw new Error(selector)
  return target
}
function setValue(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function serverItem(r: Rig, id: string): MockState['items'][number] {
  const found = r.state.items.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`서버에 없음: ${id}`)
  return found
}
const banner = (): Element | null => q('[data-issue-conflict]')
const disabled = (selector: string): boolean => { const button = el(selector); return button instanceof HTMLButtonElement && button.disabled }
function saveBody(value: string): void {
  click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), value); click('[data-md-save]')
}

/** A(우선순위 highest)를 출처에서 처리한 뒤(또는 거절 답을 만든 뒤) 배달만 붙든다 — 30초 한도 타이머를 손으로 터뜨려 늦음으로. */
async function lateA({ refuse = false }: { refuse?: boolean } = {}): Promise<() => Promise<void>> {
  const original = window.corral.workRequest
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  let captured = false
  window.corral.workRequest = async (request: WorkRequest) => {
    const hit = !captured && request.call.op === 'updateItem' && request.call.fields.priority === 'highest'
    const response: WorkResponse = hit && refuse ? { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'rejected', message: 'fixture refused', status: 400 } } : await original(request)
    if (hit) { captured = true; await pending }
    return response
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]'); click('[data-priority-row="highest"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers()
  await settle(20)
  expect(captured).toBe(true)
  return async () => { await act(async () => { release() }); await settle(30) }
}

it('622 r2 원장면(모의) — 같은 칸 연속 저장: 기다렸다가 저장, 배너 없음, 서버 = lowest', async () => {
  const r = await rig()
  click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle()
  const releaseA = await lateA()
  expect(serverItem(r, 'm-2').priority).toBe('highest')
  expect(disabled('[data-field="priority"]')).toBe(true)
  expect(banner()).toBeNull()
  await releaseA()
  click('[data-field="priority"]'); click('[data-priority-row="lowest"]')
  await settle(30)
  expect(banner()).toBeNull()
  expect(serverItem(r, 'm-2').priority).toBe('lowest')
})

it('다른 칸(모의) — 우선순위 늦음 → 본문: 기다렸다가 저장, 배너 없음', async () => {
  const r = await rig()
  serverItem(r, 'm-2').body = 'BEFORE'
  click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle()
  const releaseA = await lateA()
  expect(disabled('[data-issue-body-edit]')).toBe(true)
  await releaseA()
  saveBody('B 본문'); await settle(30)
  expect(banner()).toBeNull()
  expect(serverItem(r, 'm-2').body).toBe('B 본문')
  expect(serverItem(r, 'm-2').priority).toBe('highest')
})

it('연결 세대 교체(모의, 리뷰 r1 X1-4) — 옛 세대 A(거절) 답 전 교체 → 새 세대 외부 변경 → 본문 저장 = 배너', async () => {
  const r = await rig()
  const server = serverItem(r, 'm-2')
  server.body = 'BEFORE'
  click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle()
  const releaseA = await lateA({ refuse: true })
  await act(async () => { await r.service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: r.connectionId }) })
  await settle(30)
  expect(disabled('[data-issue-body-edit]')).toBe(false)
  server.priority = 'highest'; server.version += 1
  saveBody('B 본문'); await settle(30)
  expect(banner()).not.toBeNull()
  expect(server.body).toBe('BEFORE')
  await releaseA()
})

it('앞 쓰기 거절 + 외부가 같은 값(모의, 리뷰 r1 m15) — 기다리는 동안 같은 칸 B 는 나가지 않고, 답 뒤 상세는 서버 값을 받는다', async () => {
  const r = await rig()
  const server = serverItem(r, 'm-2')
  click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle()
  const releaseA = await lateA({ refuse: true })
  server.priority = 'highest'; server.version += 1
  const before = r.calls.length
  expect(disabled('[data-field="priority"]')).toBe(true)
  await releaseA()
  expect(r.calls.slice(before).filter((call) => call.op === 'getItem').length).toBeGreaterThanOrEqual(1)
  saveBody('B 본문'); await settle(30)
  expect(banner()).toBeNull()
  expect(server.priority).toBe('highest')
  expect(server.body).toBe('B 본문')
})

/** 실제 끌기 경로 — 손잡이 mousedown → 문턱 넘는 move(놓을 영역은 elementFromPoint) → mouseup. */
async function dragTo({ card, zone }: { card: string; zone: string }): Promise<void> {
  const target = q(`[data-drop-zone="${zone}"]`); const handle = el(`[data-tasks-board] [data-issue-card="${card}"]`)
  const spy = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  const mouse = (at: EventTarget, name: string, x = 10, y = 10): void => { act(() => { at.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
  mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle(16)
  spy.mockRestore()
}

// LIFE-632 수정 2 — 리뷰 r2 X2-1(모의): 본문 초안을 연 채 보드에서 완료로(갈래 생략 → 출처 기본 완료함) → 본문 저장 = 배너 없음.
it('X2-1(모의) — 본문 초안 + 보드 완료 이동 → 본문 저장 = 배너 없음', async () => {
  const r = await rig()
  const server = serverItem(r, 'm-2')
  server.body = 'BEFORE'
  // 모의 CORE 의 전이 규칙은 Review → Done 만 허용한다 — 서버에서 Review 로 두고 연다(상세는 서버 값을 읽는다).
  server.statusKey = 'core-review'
  click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle()
  click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MY BODY')
  await dragTo({ card: 'CORE-2', zone: 'col:st:core-done' })
  expect(server.statusKey).toBe('core-done')
  expect(server.resolution).toBe('completed')
  click('[data-md-save]'); await settle(30)
  expect(banner()).toBeNull()
  expect(server.body).toBe('MY BODY')
})
