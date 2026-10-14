// @vitest-environment happy-dom
// LIFE-602 수정 5(범위 축소) — Codex 리뷰 r5 재현(`raw/review/codex-r5-raw/probes/novel.test.tsx` A·B·B2·C · `title.test.tsx` D)을 바뀐 기준(01-criteria 변경 기록
// 2026-10-14 r5 뒤: 체크 토스트 없음 · 충돌 자동 재시도 없음 · 상세 되돌리기 토스트 소멸 · 같은 작업 쓰기 직렬화)으로 옮기고, 소멸·직렬화·자기 충돌 배너의 처리를 더한다.
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


function hold(op: WorkCall['op']): () => Promise<void> {
  const original = window.corral.workRequest
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => { release = resolve })
  window.corral.workRequest = async (request: WorkRequest) => {
    if (request.call.op === op) await pending
    return original(request)
  }
  return async () => { release?.(); await settle(16) }
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
async function changeGeneration(r: Rig): Promise<void> {
  await act(async () => { await r.service.addConnection({ sourceId: 'mock-jira', token: 'mock_l602_new_generation', replaceId: r.connectionId }) })
  await settle()
}

const undoToast = (label: string): Element | null => [...document.querySelectorAll('[data-toast="moved"]')].find((entry) => entry.textContent?.includes(label))?.querySelector('[data-toast-undo]') ?? null
const toastWith = (label: string): boolean => [...document.querySelectorAll('[data-toast]')].some((entry) => entry.textContent?.includes(label))

// --- 리뷰 r5 재현(바뀐 기준의 기대로 — 원 기대와 다른 칸은 test-audit.md 「기준 변경으로 기대 수정」) ---
describe('r5 재현 — 바뀐 기준', () => {
  it('A 상태 완료함 → 외부 갈래 취소함 → 재조회 → 우선순위 왕복: 상태 되돌리기 토스트는 사라졌고 외부 갈래 보존', async () => {
    const r = await rig(); await openCard('CORE-4'); const server = serverItem(r, 'm-4')
    click('[data-issue-status]'); await settle(); click('[data-status-resolution="completed"]'); await settle(16)
    expect(server.resolution).toBe('completed')
    server.resolution = 'cancelled'; server.version++
    await sendComment('TRIGGER SYNC'); expect(el('[data-issue-status]').textContent).toContain('취소함')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    click('[data-field="priority"]'); click('[data-priority-row="medium"]'); await settle(16)
    const statusUndo = undoToast('CORE-4 →')
    if (statusUndo !== null) { act(() => { statusUndo.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await settle(16) }
    console.log('R5-A', { statusUndo: statusUndo !== null, status: server.statusKey, resolution: server.resolution, banner: banner() })
    expect(statusUndo).toBeNull()
    expect(server.statusKey).toBe('core-done'); expect(server.resolution).toBe('cancelled')
  })
  it('B 체크 두 줄 — 체크 칸은 되돌리기 토스트를 내지 않고 두 줄 다 저장', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = '- [ ] FIRST\n- [ ] SECOND\n'; await openCard('CORE-2')
    click('[data-md-check="1"]'); await settle(16)
    click('[data-md-check="2"]'); await settle(16)
    console.log('R5-B', { body: server.body, toast: toastWith('체크 칸') })
    expect(server.body).toBe('- [x] FIRST\n- [x] SECOND\n'); expect(toastWith('체크 칸')).toBe(false)
  })
  it('B2 체크 뒤 본문 편집으로 문단 추가 — 체크 되돌리기가 없어 뒤 문단 보존', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = '- [ ] FIRST\n'; await openCard('CORE-2')
    click('[data-md-check="1"]'); await settle(16)
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), '- [x] FIRST\nLATER OWN PARAGRAPH'); click('[data-md-save]'); await settle(16)
    console.log('R5-B2', { body: server.body, undo: undoToast('체크 칸') !== null })
    expect(undoToast('체크 칸')).toBeNull()
    expect(server.body).toBe('- [x] FIRST\nLATER OWN PARAGRAPH'); expect(q('[data-md-editor]')).toBeNull()
  })
  it('C 앞 세대에서 거절된 같은 값은 증거가 아니다 — 다음 저장은 배너 · 서버 = 외부 값(자동 재시도 없음)', async () => {
    const r = await rig(); await openCard('CORE-2'); const release = hold('updateItem'); const server = serverItem(r, 'm-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'IDENTICAL'); click('[data-md-save]')
    await changeGeneration(r)
    server.body = 'IDENTICAL'; server.version++
    await release()
    setValue(input('[data-md-editor] textarea'), 'NEXT'); click('[data-md-save]'); await settle(16)
    console.log('R5-C', { body: server.body, fields: conflictFieldsShown(), writes: writes(r.calls).length })
    expect(server.body).toBe('IDENTICAL'); expect(q('[data-issue-conflict]')).not.toBeNull()
  })
  it('D 재조회 대기 중 제목 — 입력이 잠겨 저장도 화면 값도 남지 않고, 재조회 뒤 고친 제목은 자기 충돌 없이 저장', async () => {
    const r = await rig(); await openCard('CORE-2'); const release = hold('updateItem'); const server = serverItem(r, 'm-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'GEN V1'); click('[data-md-save]')
    await changeGeneration(r); await release()
    expect(server.body).toBe('GEN V1')
    click('.md-editor-cancel'); await settle()
    const held = holdWhere((call) => call.op === 'getItem')
    await sendComment('TRIGGER SYNC')
    const title = input('[data-issue-title]'); act(() => title.focus()); setValue(title, 'NEW TITLE'); act(() => title.blur()); await settle()
    const during = { readOnly: title.readOnly, shown: title.value, writes: writes(r.calls).filter((call) => call.op === 'updateItem' && call.fields.title !== undefined).length }
    await held.release()
    expect(input('[data-issue-title]').value).toBe('카드 저장')
    const again = input('[data-issue-title]'); act(() => again.focus()); setValue(again, 'NEW TITLE'); act(() => again.blur()); await settle(16)
    console.log('R5-D', { during, title: server.title, banner: banner() })
    expect(during.readOnly).toBe(true); expect(during.writes).toBe(0); expect(during.shown).toBe('카드 저장')
    expect(server.title).toBe('NEW TITLE'); expect(banner()).toBeNull()
  })
})

describe('r5 되돌리기 토스트 소멸(R5r-A 계열)', () => {
  it('X-next 같은 작업에 다음 쓰기가 시작되면 앞 토스트의 되돌리기가 사라진다', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    expect(undoToast('우선순위')).not.toBeNull()
    click('[data-placement="backlog"]'); await settle(16)
    console.log('R5-X-next', { priorityUndo: undoToast('우선순위') !== null, placementUndo: undoToast('백로그') !== null })
    expect(undoToast('우선순위')).toBeNull(); expect(undoToast('백로그')).not.toBeNull()
    expect(server.priority).toBe('high'); expect(server.placement).toBe('backlog')
  })
  it('X-board 보드 끌기 확정으로 서버 판이 그 쓰기 결과보다 오르면 사라진다(끈 상태 보존)', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    expect(undoToast('우선순위')).not.toBeNull()
    const zone = q('[data-drop-zone="col:st:core-doing"]'); const handle = q('[data-tasks-board] [data-issue-card="CORE-2"]')
    if (zone === null || handle === null) throw new Error('끌기 대상 없음')
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(zone)
    const mouse = (target: EventTarget, name: string, x = 10, y = 10): void => { act(() => { target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
    mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle(16)
    console.log('R5-X-board', { undo: undoToast('우선순위') !== null, status: server.statusKey, priority: server.priority })
    expect(server.statusKey).toBe('core-doing'); expect(undoToast('우선순위')).toBeNull(); expect(server.priority).toBe('high')
  })
  it('X-ok 대조 — 그 사이 아무 변화가 없으면 되돌리기는 그 판으로 복원', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    const button = undoToast('우선순위'); if (button === null) throw new Error('토스트 없음')
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await settle(16)
    console.log('R5-X-ok', { priority: server.priority, banner: banner() })
    expect(server.priority).toBe('medium'); expect(banner()).toBeNull()
  })
  it('X-relation 대조 — 연결 떼기 뒤 재조회가 끝나도(그 쓰기의 결과 판) 되돌리기는 남고 연결을 되살린다', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-link-remove="l-demo-1"]'); await settle(16)
    expect(r.state.links.some((link) => link.id === 'l-demo-1')).toBe(false)
    const button = undoToast('연결 뗌'); if (button === null) throw new Error('토스트 없음')
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await settle(16)
    const restored = r.state.links.filter((link) => link.from === 'm-2' && link.to === 'm-7' && link.kind === 'blocks')
    console.log('R5-X-relation', { restored: restored.length, banner: banner() })
    expect(restored).toHaveLength(1); expect(banner()).toBeNull()
  })
  it('X-external 연결 떼기 뒤 외부 변경 → 재조회(코멘트) — 판이 올라 연결 되돌리기도 사라진다', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-link-remove="l-demo-1"]'); await settle(16)
    server.title = 'EXTERNAL'; server.version++
    await sendComment('TRIGGER SYNC')
    console.log('R5-X-external', { undo: undoToast('연결 뗌') !== null })
    expect(undoToast('연결 뗌')).toBeNull(); expect(server.title).toBe('EXTERNAL')
  })
})

describe('r5 같은 작업 쓰기 직렬화', () => {
  it('Q-sync 코멘트 뒤 재조회 중에는 우선순위를 저장할 수 없고(요청 0 · 화면 값 그대로), 끝난 뒤에는 저장된다', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    const held = holdWhere((call) => call.op === 'getItem')
    await sendComment('TRIGGER SYNC')
    const disabled = el('[data-field="priority"]').hasAttribute('disabled')
    click('[data-field="priority"]'); const row = q('[data-priority-row="high"]'); if (row !== null) click('[data-priority-row="high"]'); await settle()
    const during = { disabled, writes: writes(r.calls).filter((call) => call.op === 'updateItem').length, shown: el('[data-field="priority"]').textContent }
    await held.release()
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    console.log('R5-Q-sync', { during, priority: server.priority, banner: banner() })
    expect(during.disabled).toBe(true); expect(during.writes).toBe(0); expect(during.shown).not.toContain('높음')
    expect(server.priority).toBe('high'); expect(banner()).toBeNull()
  })
  it('Q-write 쓰기 확인 중에는 본문 저장이 보내지지 않고 초안·편집기가 남는다(화면에만 남는 저장 없음)', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2'); const before = server.body
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'DRAFT WHILE LOCKED')
    const held = holdWhere((call) => call.op === 'updateItem' && call.fields.priority !== undefined)
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle()
    click('[data-md-save]'); await settle()
    const during = { bodyWrites: writes(r.calls).filter((call) => call.op === 'updateItem' && call.fields.body !== undefined).length, editor: q('[data-md-editor]') !== null }
    await held.release()
    console.log('R5-Q-write', { during, body: server.body, priority: server.priority, draft: input('[data-md-editor] textarea').value })
    expect(during.bodyWrites).toBe(0); expect(during.editor).toBe(true)
    expect(server.body).toBe(before); expect(server.priority).toBe('high'); expect(input('[data-md-editor] textarea').value).toBe('DRAFT WHILE LOCKED')
  })
})

describe('r5 자기 충돌로 보이는 배너(재시도 제거 비용) — 배너의 두 버튼', () => {
  async function selfConflict(r: Rig): Promise<void> {
    const release = hold('updateItem')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'GEN V1'); click('[data-md-save]')
    await changeGeneration(r); await release()
    setValue(input('[data-md-editor] textarea'), 'GEN V2'); click('[data-md-save]'); await settle(16)
  }
  it('K-banner 세대 변경 사이 닿은 내 앞 저장 뒤 다시 저장 — 자동 재시도 없이 배너(다시 저장의 요청 1회)', async () => {
    const r = await rig(); await openCard('CORE-2'); const before = writes(r.calls).length
    await selfConflict(r)
    console.log('R5-K-banner', { body: serverItem(r, 'm-2').body, fields: conflictFieldsShown(), writes: writes(r.calls).length - before })
    expect(serverItem(r, 'm-2').body).toBe('GEN V1'); expect(conflictFieldsShown()).toContain('body')
    expect(writes(r.calls).length - before).toBe(2)
  })
  it('K-override 「내 값으로 덮기」 → 서버 = GEN V2 · 배너 닫힘 · 편집기 닫힘', async () => {
    const r = await rig(); await openCard('CORE-2'); await selfConflict(r)
    click('[data-conflict-override]'); await settle(16)
    console.log('R5-K-override', { body: serverItem(r, 'm-2').body, banner: banner(), editor: q('[data-md-editor]') !== null })
    expect(serverItem(r, 'm-2').body).toBe('GEN V2'); expect(banner()).toBeNull(); expect(q('[data-md-editor]')).toBeNull()
  })
  it('K-reload 「새로 불러오기」 → 서버 = GEN V1 그대로 · 화면 = 서버 · 배너 닫힘', async () => {
    const r = await rig(); await openCard('CORE-2'); await selfConflict(r)
    click('[data-conflict-reload]'); await settle(16)
    console.log('R5-K-reload', { body: serverItem(r, 'm-2').body, shown: el('[data-issue-body]').textContent, banner: banner() })
    expect(serverItem(r, 'm-2').body).toBe('GEN V1'); expect(el('[data-issue-body]').textContent).toContain('GEN V1'); expect(banner()).toBeNull()
  })
})
