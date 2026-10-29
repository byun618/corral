// @vitest-environment happy-dom
// LIFE-602 수정 6 — Codex 리뷰 r6 재현(`raw/review/codex-r6-raw/probes/novel.test.tsx` A·B·C·D · `initial-failure-v3.test.tsx`)을 옮기고, 같은 모양의 다른 칸·다른 경로를 더한다.
// 모든 판정은 지연을 푼 뒤 마지막 서버 값·마지막 화면으로 한다. 규칙·경로 전수 표: specs/LIFE-602-task-detail/raw/claude/detail-async-rules.md.
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

type Rig = { service: WorkService; state: MockState; activity: MemoryActivity; calls: WorkCall[]; savedPrefs: unknown[]; closes: number[]; connectionId: string; push: (value: WorkSettingsState) => void }

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

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
  act(() => root.render(createElement('div', null, createElement(TasksPageInPanel, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => result.closes.push(1), onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
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
async function openCard(itemKey: string): Promise<void> {
  click(`[data-tasks-board] [data-issue-card="${itemKey}"]`)
  await settle()
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
}


function input(selector: string): HTMLInputElement | HTMLTextAreaElement {
  const target=el(selector)
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) throw new Error(selector)
  return target
}


function holdWhere(match: (call: WorkCall) => boolean): { release: () => Promise<void>; held: () => number } {
  const original = window.corral.workRequest
  let release: (() => void) | undefined
  let count = 0
  const pending = new Promise<void>((resolve) => { release = resolve })
  window.corral.workRequest = async (request: WorkRequest) => {
    if (match(request.call)) { count += 1; await pending }
    return original(request)
  }
  return { release: async () => { release?.(); await settle(20) }, held: () => count }
}
function serverItem(r: Rig, id: string): MockState['items'][number] {
  const found = r.state.items.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`서버에 없음: ${id}`)
  return found
}
async function sendComment(text: string): Promise<void> {
  setValue(input('[data-comment-composer] textarea'), text)
  key(input('[data-comment-composer] textarea'), { key: 'Enter', metaKey: true })
  await settle(16)
}
const conflictFieldsShown = (): string[] => [...document.querySelectorAll('[data-conflict-field]')].map((entry) => entry.getAttribute('data-conflict-field') ?? '')

const banner = (): string | null => q('[data-issue-conflict]')?.textContent ?? null

// 지운 토스트는 sonner 가 200ms 퇴장 동안 `data-removed="true"` 로 남긴다 — 그 동안 누른 되돌리기도 hook 이 받지 않지만(소멸), 보이는 토스트로 세지 않는다.
const shown = (entry: Element): boolean => entry.closest('[data-sonner-toast]')?.getAttribute('data-removed') !== 'true'
const undoToast = (label: string): Element | null => [...document.querySelectorAll('[data-toast="moved"]')].find((entry) => shown(entry) && entry.textContent?.includes(label))?.querySelector('[data-toast-undo]') ?? null


/** 실제 끌기 경로 — 손잡이 mousedown → 문턱 넘는 move(놓을 영역은 elementFromPoint) → mouseup. */
async function dragTo({ card, zone }: { card: string; zone: string }): Promise<void> {
  const target = q(`[data-drop-zone="${zone}"]`); const handle = el(`[data-tasks-board] [data-issue-card="${card}"]`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  const mouse = (at: EventTarget, name: string, x = 10, y = 10): void => { act(() => { at.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
  mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle(16)
}
const cardLocked = (card: string): string | null => {
  const found = q(`[data-tasks-board] [data-issue-card="${card}"]`)
  return found !== null && found.classList.contains('is-locked') ? found.getAttribute('title') : null
}

describe('R6-A 덮기는 덮은 칸의 기준만 올린다', () => {
  it('A 리뷰 재현 — 본문 초안을 연 채 우선순위 덮기 → 본문 저장: 외부 본문을 덮지 않고 본문 충돌 배너', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = 'BASE BODY'; await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MY OLD DRAFT')
    server.body = 'EXTERNAL BODY'; server.version++
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    expect(conflictFieldsShown()).toContain('body')
    click('[data-conflict-override]'); await settle(16)
    expect(server.priority).toBe('high'); expect(server.body).toBe('EXTERNAL BODY')
    expect(input('[data-md-editor] textarea').value).toBe('MY OLD DRAFT')
    click('[data-md-save]'); await settle(16)
    console.log('R6-A', { body: server.body, fields: conflictFieldsShown(), draft: q('[data-md-editor] textarea') === null ? null : input('[data-md-editor] textarea').value })
    expect(server.body).toBe('EXTERNAL BODY'); expect(conflictFieldsShown()).toContain('body')
    expect(input('[data-md-editor] textarea').value).toBe('MY OLD DRAFT')
  })
  it('A-title 제목 초안을 잡은 채 우선순위 덮기 → 제목 저장: 외부 본문 변경이 있으니 배너(외부 본문 보존·제목 그대로)', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); await openCard('CORE-2')
    const title = input('[data-issue-title]'); act(() => title.focus()); setValue(title, 'MY TITLE DRAFT')
    server.body = 'EXTERNAL BODY'; server.version++
    // 제목 칸에 초점을 둔 채 우선순위를 바꾸면 blur 가 먼저 저장한다 — 초점을 두지 않고(드래프트만 잡은 채) 다른 칸을 고르는 순서는 아래처럼 흐린 뒤 다시 잡는다.
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    console.log('R6-A-title 1', { title: server.title, fields: conflictFieldsShown() })
    if (q('[data-conflict-override]') !== null) { click('[data-conflict-override]'); await settle(16) }
    const again = input('[data-issue-title]'); act(() => again.focus()); setValue(again, 'MY TITLE DRAFT 2'); act(() => again.blur()); await settle(16)
    console.log('R6-A-title 2', { title: server.title, body: server.body, fields: conflictFieldsShown() })
    expect(server.body).toBe('EXTERNAL BODY'); expect(server.title).not.toContain('MY TITLE DRAFT')
    expect(conflictFieldsShown()).toContain('body')
  })
  it('A-status 본문 초안을 연 채 상태 덮기 → 본문 저장: 외부 본문 보존 · 본문 충돌 배너', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = 'BASE BODY'; await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MY OLD DRAFT')
    server.body = 'EXTERNAL BODY'; server.version++
    click('[data-issue-status]'); await settle(); click('[data-status-row="core-doing"]'); await settle(16)
    expect(conflictFieldsShown()).toContain('body')
    click('[data-conflict-override]'); await settle(16)
    expect(server.statusKey).toBe('core-doing'); expect(server.body).toBe('EXTERNAL BODY')
    click('[data-md-save]'); await settle(16)
    console.log('R6-A-status', { body: server.body, fields: conflictFieldsShown() })
    expect(server.body).toBe('EXTERNAL BODY'); expect(conflictFieldsShown()).toContain('body')
  })
  it('A-due 본문 초안을 연 채 마감 덮기(판 없는 쓰기) 뒤 다시 우선순위 보통 저장 → 본문 저장: 외부 본문 보존', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = 'BASE BODY'; await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MY OLD DRAFT')
    server.body = 'EXTERNAL BODY'; server.version++
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    click('[data-conflict-override]'); await settle(16)
    // 덮기 뒤 새로 읽은 판 위의 평범한 쓰기 — 본문 기준은 여전히 외부 변경 앞이다.
    click('[data-field="priority"]'); click('[data-priority-row="low"]'); await settle(16)
    expect(server.priority).toBe('low')
    click('[data-md-save]'); await settle(16)
    console.log('R6-A-chain', { body: server.body, fields: conflictFieldsShown() })
    expect(server.body).toBe('EXTERNAL BODY'); expect(conflictFieldsShown()).toContain('body')
  })
  it('A-ok 대조 — 외부 변경이 덮은 칸(우선순위)뿐이면 덮기 뒤 본문 저장은 배너 없이 저장(자기 충돌 없음)', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = 'BASE BODY'; await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MY DRAFT')
    server.priority = 'low'; server.version++
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    expect(conflictFieldsShown()).toEqual(['priority'])
    click('[data-conflict-override]'); await settle(16)
    click('[data-md-save]'); await settle(16)
    console.log('R6-A-ok', { body: server.body, priority: server.priority, banner: banner() })
    expect(server.body).toBe('MY DRAFT'); expect(server.priority).toBe('high'); expect(banner()).toBeNull()
  })
})

describe('R6-B · R6-D 보드 쓰기와 상세', () => {
  it('B 리뷰 재현 — 보드 끌기가 시작되면(확인 전) 상세의 앞 되돌리기 토스트가 곧바로 사라진다', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    expect(undoToast('우선순위')).not.toBeNull()
    const held = holdWhere((call) => call.op === 'changeStatus')
    await dragTo({ card: 'CORE-2', zone: 'col:st:core-doing' })
    const during = { undo: undoToast('우선순위') !== null, held: held.held(), busy: q('[data-issue-busy]') !== null }
    await held.release()
    console.log('R6-B', { during, status: server.statusKey })
    expect(during.held).toBe(1); expect(during.busy).toBe(true); expect(during.undo).toBe(false)
    expect(server.statusKey).toBe('core-doing'); expect(server.priority).toBe('high')
  })
  it('D 리뷰 재현 — 상세 재조회 중에는 그 카드를 보드에서 끌 수 없다(잠금 표시 · 요청 0), 끝난 뒤에는 끌린다', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    const held = holdWhere((call) => call.op === 'getItem'); await sendComment('SYNC HOLD')
    const lock = cardLocked('CORE-2')
    await dragTo({ card: 'CORE-2', zone: 'col:st:core-doing' })
    const during = { readHeld: held.held(), lock, writes: r.calls.filter((call) => call.op === 'changeStatus').length, status: server.statusKey }
    await held.release()
    expect(cardLocked('CORE-2')).toBeNull()
    await dragTo({ card: 'CORE-2', zone: 'col:st:core-doing' })
    console.log('R6-D', { during, after: server.statusKey })
    expect(during.readHeld).toBe(1); expect(during.lock).not.toBeNull(); expect(during.writes).toBe(0); expect(during.status).toBe('core-todo')
    expect(server.statusKey).toBe('core-doing')
  })
  it('D-first 상세 첫 읽기 중에도 그 카드는 잠긴다 — 다른 카드는 끌린다', async () => {
    const r = await rig(); const held = holdWhere((call) => call.op === 'getItem')
    click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle()
    const lock = { mine: cardLocked('CORE-2'), other: cardLocked('CORE-4') }
    await dragTo({ card: 'CORE-2', zone: 'col:st:core-doing' })
    const during = r.calls.filter((call) => call.op === 'changeStatus').length
    await held.release()
    console.log('R6-D-first', { lock, during, status: serverItem(r, 'm-2').statusKey })
    expect(lock.mine).not.toBeNull(); expect(lock.other).toBeNull(); expect(during).toBe(0)
  })
  it('D-undo 보드 토스트의 되돌리기도 상세 재조회 중에는 보내지 않는다(버튼은 남아 끝난 뒤 다시 누를 수 있다)', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    await dragTo({ card: 'CORE-2', zone: 'col:st:core-doing' })
    expect(server.statusKey).toBe('core-doing')
    const held = holdWhere((call) => call.op === 'getItem'); await sendComment('SYNC HOLD')
    const button = undoToast('CORE-2'); if (button === null) throw new Error('보드 토스트 없음')
    const before = r.calls.filter((call) => call.op === 'changeStatus').length
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await settle()
    const during = r.calls.filter((call) => call.op === 'changeStatus').length - before
    await held.release()
    const again = undoToast('CORE-2')
    if (again !== null) { act(() => { again.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await settle(16) }
    console.log('R6-D-undo', { during, again: again !== null, status: server.statusKey })
    expect(during).toBe(0); expect(again).not.toBeNull(); expect(server.statusKey).toBe('core-todo')
  })
  it('D-reverse 보드 쓰기 확인 중에는 상세 우선순위 저장이 보내지지 않는다(C12) — 끝난 뒤 저장된다', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    const held = holdWhere((call) => call.op === 'changeStatus')
    await dragTo({ card: 'CORE-2', zone: 'col:st:core-doing' })
    const disabled = el('[data-field="priority"]').hasAttribute('disabled')
    click('[data-field="priority"]'); if (q('[data-priority-row="high"]') !== null) click('[data-priority-row="high"]'); await settle()
    const during = { held: held.held(), disabled, updates: r.calls.filter((call) => call.op === 'updateItem').length }
    await held.release()
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    console.log('R6-D-reverse', { during, status: server.statusKey, priority: server.priority, banner: banner() })
    expect(during.held).toBe(1); expect(during.disabled).toBe(true); expect(during.updates).toBe(0)
    expect(server.statusKey).toBe('core-doing'); expect(server.priority).toBe('high'); expect(banner()).toBeNull()
  })
})

describe('R6-E 상세 읽기 실패는 보이고 다시 시도할 수 있다', () => {
  it('E 리뷰 재현 — 목록 값이 있어도 첫 단건 실패는 오류 + 다시 시도, 잠금·「불러오는 중」 이 남지 않고 다시 시도 뒤 편집된다', async () => {
    const r = await rig(); const original = window.corral.workRequest; let failed = 0
    window.corral.workRequest = async (request: WorkRequest) => {
      if (request.call.op === 'getItem' && request.call.itemId === 'm-2' && failed === 0) { failed += 1; throw new Error('R6 initial read rejected') }
      return original(request)
    }
    await openCard('CORE-2'); await settle(16)
    const before = { error: q('[data-issue-load-error]')?.textContent ?? null, retry: q('[data-issue-retry]') !== null, loading: el('[data-issue-detail]').textContent?.includes('불러오는 중') ?? false, busy: q('[data-issue-busy]') !== null }
    click('[data-issue-retry]'); await settle(16)
    const after = { error: q('[data-issue-load-error]') !== null, readonly: input('[data-issue-title]').readOnly, body: el('[data-issue-body]').textContent }
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    console.log('R6-E', { failed, before, after, priority: serverItem(r, 'm-2').priority })
    expect(before.error).toContain('R6 initial read rejected'); expect(before.retry).toBe(true); expect(before.loading).toBe(false); expect(before.busy).toBe(false)
    expect(after.error).toBe(false); expect(after.readonly).toBe(false); expect(after.body).toContain('카드 저장 본문')
    expect(serverItem(r, 'm-2').priority).toBe('high')
  })
  it('E-response 오류 응답(던짐 아님)도 같다 — 다시 시도도 실패하면 오류가 남고, 그 다음 다시 시도로 복구', async () => {
    const r = await rig(); const original = window.corral.workRequest; let fails = 2
    window.corral.workRequest = async (request: WorkRequest) => {
      if (request.call.op === 'getItem' && request.call.itemId === 'm-2' && fails > 0) { fails -= 1; return { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'network', message: 'R6 read failed', status: null } } }
      return original(request)
    }
    await openCard('CORE-2'); await settle(16)
    expect(q('[data-issue-load-error]')?.textContent).toContain('R6 read failed')
    click('[data-issue-retry]'); await settle(16)
    const second = q('[data-issue-load-error]')?.textContent ?? null
    click('[data-issue-retry]'); await settle(16)
    console.log('R6-E-response', { second, readonly: input('[data-issue-title]').readOnly, error: q('[data-issue-load-error]') !== null })
    expect(second).toContain('R6 read failed'); expect(q('[data-issue-load-error]')).toBeNull(); expect(input('[data-issue-title]').readOnly).toBe(false)
    expect(r.calls.length).toBeGreaterThan(0)
  })
  it('E-reload 충돌 배너의 「새로 불러오기」 가 실패해도 오류 + 다시 시도가 보인다', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    server.priority = 'low'; server.version++
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    expect(banner()).not.toBeNull()
    const original = window.corral.workRequest; let fails = 1
    window.corral.workRequest = async (request: WorkRequest) => {
      if (request.call.op === 'getItem' && fails > 0) { fails -= 1; return { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'network', message: 'R6 reload failed', status: null } } }
      return original(request)
    }
    click('[data-conflict-reload]'); await settle(16)
    const shownError = q('[data-issue-load-error]')?.textContent ?? null
    click('[data-issue-retry]'); await settle(16)
    console.log('R6-E-reload', { shownError, priority: el('[data-field="priority"]').textContent, error: q('[data-issue-load-error]') !== null })
    expect(shownError).toContain('R6 reload failed'); expect(q('[data-issue-load-error]')).toBeNull(); expect(el('[data-field="priority"]').textContent).toContain('낮음')
  })
})
