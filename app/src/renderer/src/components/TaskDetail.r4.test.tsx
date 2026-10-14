// @vitest-environment happy-dom
// LIFE-602 수정 4 — Codex 리뷰 r4 재현(`raw/review/codex-r4-raw/probes/new.test.tsx` U·S·G 와 대조 4개)을 가져오고, 같은 책임(쓰기 증거·기준 판 수명)의
// 다른 순서(모든 토스트 되돌리기·sync 대기 중 되돌리기·다른 칸 쓰기·결과를 받지 못한 상태 쓰기의 갈래·덮기 뒤 기준)를 더한다. 모든 판정은 **지연을 푼 뒤 마지막 서버 값·마지막 화면**으로 한다.
// 규칙·경로 전수 표: specs/LIFE-602-task-detail/raw/claude/detail-async-rules.md.
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

function undo(label: string): void {
  const row = [...document.querySelectorAll('[data-toast="moved"]')].find((entry) => entry.textContent?.includes(label))
  const button = row?.querySelector('[data-toast-undo]')
  if (button === null || button === undefined) throw new Error(`되돌리기 없음: ${label}`)
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const banner = (): string | null => q('[data-issue-conflict]')?.textContent ?? null
async function changeGeneration(r: Rig): Promise<void> {
  await act(async () => { await r.service.addConnection({ sourceId: 'mock-jira', token: 'mock_l602_new_generation', replaceId: r.connectionId }) })
  await settle()
}

// --- 리뷰 r4 재현(기대값 그대로 — probes/new.test.tsx) ---
describe('r4 unexplored continuations', () => {
  it('U undo checkbox after foreign body refresh must not erase new remote text', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = '- [ ] ORIGINAL\n'; await openCard('CORE-2')
    click('[data-md-check]'); await settle(16); expect(server.body).toBe('- [x] ORIGINAL\n')
    server.body = '- [x] ORIGINAL\nREMOTE NEW PARAGRAPH'; server.version++
    await sendComment('TRIGGER SYNC'); expect(el('[data-issue-body]').textContent).toContain('REMOTE NEW PARAGRAPH')
    undo('체크 칸'); await settle(16)
    console.log('R4-U', { body: server.body, banner: banner(), writes: writes(r.calls).length })
    expect(server.body).toContain('REMOTE NEW PARAGRAPH')
    expect(q('[data-issue-conflict]')).not.toBeNull()
  })
  it('S concurrent completed must not be silently overwritten by cancelled with self retry', async () => {
    const r = await rig(); const server = serverItem(r, 'm-4'); await openCard('CORE-4')
    click('[data-issue-status]'); await settle()
    server.statusKey = 'core-done'; server.resolution = 'completed'; server.version++
    click('[data-status-resolution="cancelled"]'); await settle(16)
    console.log('R4-S', { status: server.statusKey, resolution: server.resolution, banner: banner(), writes: writes(r.calls) })
    expect(server.resolution).toBe('completed'); expect(writes(r.calls)).toHaveLength(1)
    expect(q('[data-issue-conflict]')).not.toBeNull()
  })
  it('G pending refresh that consumes lost-write evidence must not make next save self-conflict', async () => {
    const r = await rig(); await openCard('CORE-2'); const releaseWrite = hold('updateItem')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'GEN V1'); click('[data-md-save]')
    await changeGeneration(r)
    await releaseWrite()
    expect(serverItem(r, 'm-2').body).toBe('GEN V1')
    const releaseRead = hold('getItem')
    await sendComment('TRIGGER SYNC'); setValue(input('[data-md-editor] textarea'), 'GEN V2'); click('[data-md-save]'); await settle()
    await releaseRead(); await settle(16)
    const server = serverItem(r, 'm-2')
    console.log('R4-G', { body: server.body, banner: banner(), writes: writes(r.calls).length })
    expect(server.body).toBe('GEN V2'); expect(q('[data-issue-conflict]')).toBeNull()
  })
})
describe('r4 controls', () => {
  it('U no refresh keeps original version and detects body conflict', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = '- [ ] ORIGINAL\n'; await openCard('CORE-2')
    click('[data-md-check]'); await settle(16); server.body = '- [x] ORIGINAL\nREMOTE NEW PARAGRAPH'; server.version++
    undo('체크 칸'); await settle(16)
    expect(server.body).toContain('REMOTE NEW PARAGRAPH'); expect(q('[data-issue-conflict]')).not.toBeNull()
  })
  it('U without remote edits undo restores checkbox', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = '- [ ] ORIGINAL\n'; await openCard('CORE-2')
    click('[data-md-check]'); await settle(16); await sendComment('TRIGGER SYNC'); undo('체크 칸'); await settle(16)
    expect(server.body).toBe('- [ ] ORIGINAL\n'); expect(q('[data-issue-conflict]')).toBeNull()
  })
  it('S without concurrent completion cancelled is valid', async () => {
    const r = await rig(); await openCard('CORE-4'); click('[data-issue-status]'); await settle(); click('[data-status-resolution="cancelled"]'); await settle(16)
    expect(serverItem(r, 'm-4').resolution).toBe('cancelled'); expect(writes(r.calls)).toHaveLength(1); expect(q('[data-issue-conflict]')).toBeNull()
  })
  it('G saving after completed refresh uses advanced basis successfully', async () => {
    const r = await rig(); await openCard('CORE-2'); const release = hold('updateItem'); click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'GEN V1'); click('[data-md-save]')
    await changeGeneration(r); await release()
    await sendComment('TRIGGER SYNC'); setValue(input('[data-md-editor] textarea'), 'GEN V2'); click('[data-md-save]'); await settle(16)
    expect(serverItem(r, 'm-2').body).toBe('GEN V2'); expect(q('[data-issue-conflict]')).toBeNull()
  })
})

// --- 같은 책임의 다른 순서 (수정 4 워커 추가) ---
describe('r4 같은 모양 — 되돌리기의 기준(R4-A): 되돌릴 성공의 값·판에 고정', () => {
  it('U-priority 우선순위 → 외부 우선순위 변경 → 재조회 → 되돌리기: 배너(우선순위) · 외부 값 보존', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16); expect(server.priority).toBe('high')
    server.priority = 'low'; server.version++
    await sendComment('TRIGGER SYNC')
    undo('우선순위'); await settle(16)
    console.log('R4-U-priority', { priority: server.priority, fields: conflictFieldsShown() })
    expect(server.priority).toBe('low'); expect(conflictFieldsShown()).toContain('priority')
  })
  it('U-status 완료함 → 외부가 갈래를 취소함으로 → 재조회 → 되돌리기: 배너(상태) · 외부 갈래 보존', async () => {
    const r = await rig(); await openCard('CORE-4'); const server = serverItem(r, 'm-4')
    click('[data-issue-status]'); await settle(); click('[data-status-resolution="completed"]'); await settle(16)
    expect(server.statusKey).toBe('core-done'); expect(server.resolution).toBe('completed')
    server.resolution = 'cancelled'; server.version++
    await sendComment('TRIGGER SYNC')
    undo('CORE-4 →'); await settle(16)
    console.log('R4-U-status', { status: server.statusKey, resolution: server.resolution, fields: conflictFieldsShown(), failed: q('[data-toast="failed"]')?.textContent ?? null })
    expect(server.statusKey).toBe('core-done'); expect(server.resolution).toBe('cancelled'); expect(conflictFieldsShown()).toContain('status')
  })
  it('U-title 제목 저장 → 외부 제목 변경 → 재조회 → 되돌리기: 배너(제목) · 외부 제목 보존', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    const title = input('[data-issue-title]'); act(() => title.focus()); setValue(title, 'MY TITLE'); act(() => title.blur()); await settle(16)
    expect(server.title).toBe('MY TITLE')
    server.title = 'EXTERNAL TITLE'; server.version++
    await sendComment('TRIGGER SYNC')
    undo('제목을 바꿨습니다'); await settle(16)
    console.log('R4-U-title', { title: server.title, fields: conflictFieldsShown() })
    expect(server.title).toBe('EXTERNAL TITLE'); expect(conflictFieldsShown()).toContain('title')
  })
  it('U-placement 배치 → 외부 다른 칸 변경 → 재조회 → 되돌리기: 배너 · 배치는 그대로(되돌릴 성공 뒤 다른 곳의 변경)', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-placement="backlog"]'); await settle(16); expect(server.placement).toBe('backlog')
    server.title = 'EXTERNAL TITLE'; server.version++
    await sendComment('TRIGGER SYNC')
    undo('백로그'); await settle(16)
    console.log('R4-U-placement', { placement: server.placement, title: server.title, fields: conflictFieldsShown() })
    expect(server.placement).toBe('backlog'); expect(server.title).toBe('EXTERNAL TITLE'); expect(conflictFieldsShown()).toContain('title')
  })
  it('U-own 대조 — 되돌릴 성공 뒤의 변경이 전부 내 쓰기면 되돌리기는 성공한다(배너 없음)', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    click('[data-placement="backlog"]'); await settle(16)
    await sendComment('TRIGGER SYNC')
    undo('우선순위'); await settle(16)
    console.log('R4-U-own', { priority: server.priority, placement: server.placement, banner: banner() })
    expect(server.priority).toBe('medium'); expect(server.placement).toBe('backlog'); expect(banner()).toBeNull()
  })
  it('U-relation 대조 — 연결 떼기 되돌리기는 정확한 역연산(판 없음): 외부 본문 변경 뒤에도 연결만 되살리고 본문 보존', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-link-remove="l-demo-1"]'); await settle(16)
    expect(r.state.links.some((link) => link.id === 'l-demo-1')).toBe(false)
    server.body = 'EXTERNAL BODY'; server.version++
    await sendComment('TRIGGER SYNC')
    undo('연결 뗌'); await settle(16)
    const restored = r.state.links.filter((link) => link.from === 'm-2' && link.to === 'm-7' && link.kind === 'blocks')
    console.log('R4-U-relation', { restored: restored.length, body: server.body, banner: banner() })
    expect(restored).toHaveLength(1); expect(server.body).toBe('EXTERNAL BODY'); expect(banner()).toBeNull()
  })
  it('U-sync 재조회 대기 중 누른 되돌리기 — 다른 곳의 변경이 없으면 복원(배너 없음)', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = '- [ ] ORIGINAL\n'; await openCard('CORE-2')
    click('[data-md-check]'); await settle(16)
    const held = holdWhere((call) => call.op === 'getItem')
    await sendComment('TRIGGER SYNC')
    undo('체크 칸'); await settle()
    await held.release()
    console.log('R4-U-sync', { body: server.body, banner: banner(), held: held.held() })
    expect(held.held()).toBeGreaterThan(0)
    expect(server.body).toBe('- [ ] ORIGINAL\n'); expect(banner()).toBeNull()
  })
  it('U-sync-foreign 재조회 대기 중 누른 되돌리기 — 재조회가 다른 곳의 본문을 실어 오면 배너 · 외부 문단 보존', async () => {
    const r = await rig(); const server = serverItem(r, 'm-2'); server.body = '- [ ] ORIGINAL\n'; await openCard('CORE-2')
    click('[data-md-check]'); await settle(16)
    server.body = '- [x] ORIGINAL\nREMOTE NEW PARAGRAPH'; server.version++
    const held = holdWhere((call) => call.op === 'getItem')
    await sendComment('TRIGGER SYNC')
    undo('체크 칸'); await settle()
    await held.release()
    console.log('R4-U-sync-foreign', { body: server.body, fields: conflictFieldsShown() })
    expect(server.body).toContain('REMOTE NEW PARAGRAPH'); expect(conflictFieldsShown()).toContain('body')
  })
})

describe('r4 같은 모양 — 자기 쓰기 판별(R4-B): 거절된 현재 요청은 후보가 아니다 · 보낸 의미 전체로 비교', () => {
  it('S-same 외부가 같은 값으로 바꾼 뒤의 내 우선순위 쓰기 — 거절된 내 요청을 자기 증거로 쓰지 않는다: 배너 · 요청 1회', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    server.priority = 'high'; server.version++
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    console.log('R4-S-same', { writes: writes(r.calls).length, fields: conflictFieldsShown() })
    expect(writes(r.calls)).toHaveLength(1); expect(conflictFieldsShown()).toContain('priority')
  })
  it('S-unconfirmed 결과를 받지 못한 취소함 뒤 외부가 완료함으로 — 상태 갈래가 다르면 내 변경이 아니다: 다음 본문 저장은 배너 · 완료함 보존', async () => {
    const r = await rig(); await openCard('CORE-4'); const server = serverItem(r, 'm-4')
    const releaseStatus = hold('changeStatus')
    click('[data-issue-status]'); await settle(); click('[data-status-resolution="cancelled"]'); await settle()
    await changeGeneration(r)
    await releaseStatus()
    expect(server.resolution).toBe('cancelled')
    server.resolution = 'completed'; server.version++
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'BODY AFTER'); click('[data-md-save]'); await settle(16)
    console.log('R4-S-unconfirmed', { resolution: server.resolution, body: server.body, fields: conflictFieldsShown() })
    expect(server.resolution).toBe('completed'); expect(server.body).not.toBe('BODY AFTER'); expect(conflictFieldsShown()).toContain('status')
  })
  it('S-gen 대조 — 결과를 받지 못한 취소함이 그대로 닿았으면 다음 본문 저장은 자기 충돌 없이 성공', async () => {
    const r = await rig(); await openCard('CORE-4'); const server = serverItem(r, 'm-4')
    const releaseStatus = hold('changeStatus')
    click('[data-issue-status]'); await settle(); click('[data-status-resolution="cancelled"]'); await settle()
    await changeGeneration(r)
    await releaseStatus()
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'BODY AFTER'); click('[data-md-save]'); await settle(16)
    console.log('R4-S-gen', { resolution: server.resolution, body: server.body, banner: banner() })
    expect(server.resolution).toBe('cancelled'); expect(server.body).toBe('BODY AFTER'); expect(banner()).toBeNull()
  })
})

describe('r4 같은 모양 — 기준과 증거를 함께 옮김(R4-C)', () => {
  it('G-field 증거를 소비하는 재조회 대기 중 누른 우선순위(초안 칸 없는 쓰기) — 자기 충돌 없이 저장', async () => {
    const r = await rig(); await openCard('CORE-2'); const releaseWrite = hold('updateItem')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'GEN V1'); click('[data-md-save]')
    await changeGeneration(r)
    await releaseWrite()
    const held = holdWhere((call) => call.op === 'getItem')
    await sendComment('TRIGGER SYNC')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle()
    await held.release()
    const server = serverItem(r, 'm-2')
    console.log('R4-G-field', { body: server.body, priority: server.priority, banner: banner() })
    expect(server.body).toBe('GEN V1'); expect(server.priority).toBe('high'); expect(banner()).toBeNull()
  })
  it('G-foreign 대조 — 같은 순서에 다른 곳의 본문 변경이 섞이면 저장 안 됨 · 배너 · 외부 본문 보존', async () => {
    const r = await rig(); await openCard('CORE-2'); const releaseWrite = hold('updateItem')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'GEN V1'); click('[data-md-save]')
    await changeGeneration(r)
    await releaseWrite()
    const server = serverItem(r, 'm-2'); server.body = 'FOREIGN AFTER GEN V1'; server.version++
    const held = holdWhere((call) => call.op === 'getItem')
    await sendComment('TRIGGER SYNC'); setValue(input('[data-md-editor] textarea'), 'GEN V2'); click('[data-md-save]'); await settle()
    await held.release()
    console.log('R4-G-foreign', { body: server.body, fields: conflictFieldsShown() })
    expect(server.body).toBe('FOREIGN AFTER GEN V1'); expect(conflictFieldsShown()).toContain('body')
  })
})

describe('r4 같은 모양 — 덮기 뒤 기준(F)', () => {
  it('F-override 다른 칸(우선순위) 충돌을 덮은 뒤 같은 편집기에서 다시 저장 — 덮은 칸의 기준은 덮은 결과로 옮겨 같은 충돌을 다시 내지 않는다', async () => {
    const r = await rig(); await openCard('CORE-2'); const server = serverItem(r, 'm-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MINE 1')
    server.priority = 'low'; server.version++
    click('[data-md-save]'); await settle(16)
    expect(conflictFieldsShown()).toContain('priority')
    setValue(input('[data-md-editor] textarea'), 'MINE 2')
    click('[data-conflict-override]'); await settle(16)
    expect(server.body).toBe('MINE 1')
    click('[data-md-save]'); await settle(16)
    console.log('R4-F-override', { body: server.body, priority: server.priority, banner: banner() })
    expect(server.body).toBe('MINE 2'); expect(server.priority).toBe('low'); expect(banner()).toBeNull()
  })
})
