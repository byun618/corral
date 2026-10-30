// @vitest-environment happy-dom
// LIFE-602 수정 3 — Codex 리뷰 r3 재현(`raw/review/codex-r3-raw/review.test.tsx` A·A2·B·B2·C·D·E)을 가져오고, 같은 모양의 다른 칸·다른 await 지점과
// 양성 대조(자기 충돌 없음)를 더한다. 모든 판정은 **지연을 푼 뒤 마지막 서버 값·마지막 화면**으로 한다(시험 감사 raw/claude/test-audit.md).
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

// --- 리뷰 r3 재현(기대값 그대로) ---
describe('r3 independent boundaries', () => {
  it('A sync must not silently rebase a pending body write over remote edits', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MY OLD BASE DRAFT')
    const release = hold('getItem')
    setValue(input('[data-comment-composer] textarea'), 'TRIGGER SYNC')
    key(input('[data-comment-composer] textarea'), { key: 'Enter', metaKey: true }); await settle()
    const server = serverItem(r, 'm-2')
    server.body = 'EXTERNAL BODY MUST SURVIVE'; server.version += 1
    click('[data-md-save]'); await settle()
    expect(writes(r.calls).filter((c) => c.op === 'updateItem')).toHaveLength(0)
    await release()
    // 수정 5(기준 변경 — 직렬화): 재조회 중 저장은 기다렸다 나가지 않고 막힌다(원 기대: 대기 뒤 그 판으로 나가 배너 — test-audit.md). 끝난 뒤 다시 저장하면 편집 기준 판으로 가 배너.
    expect(writes(r.calls).filter((c) => c.op === 'updateItem')).toHaveLength(0)
    click('[data-md-save]'); await settle(16)
    console.log('R3-A', { serverBody: server.body, banner: q('[data-issue-conflict]')?.textContent, writes: writes(r.calls) })
    expect(server.body).toBe('EXTERNAL BODY MUST SURVIVE')
    expect(q('[data-issue-conflict]')).not.toBeNull()
  })
  it('B body override must retain draft edited after the conflicting submission', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'CONFLICTED BODY V1')
    const server = serverItem(r, 'm-2'); server.body = 'REMOTE'; server.version += 1
    click('[data-md-save]'); await settle()
    expect(q('[data-issue-conflict]')).not.toBeNull()
    const release = hold('updateItem')
    click('[data-conflict-override]')
    setValue(input('[data-md-editor] textarea'), 'NEW UNSAVED BODY V2')
    await release()
    console.log('R3-B', { editor: !!q('[data-md-editor]'), serverBody: server.body })
    expect(q('[data-md-editor]')).not.toBeNull()
    expect(input('[data-md-editor] textarea').value).toBe('NEW UNSAVED BODY V2')
  })
  it('B2 overriding a field conflict must not discard unrelated body draft', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'UNSAVED BODY DURING FIELD CHANGE')
    const server = serverItem(r, 'm-2'); server.title = 'REMOTE TITLE'; server.version += 1
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle()
    expect(q('[data-issue-conflict]')).not.toBeNull()
    click('[data-conflict-override]'); await settle()
    console.log('R3-B2', { editor: !!q('[data-md-editor]'), serverBody: server.body, priority: server.priority })
    expect(q('[data-md-editor]')).not.toBeNull()
  })
  it('C stale status continuation must not start old-item child/comment reads in new session', async () => {
    const r = await rig(); await openCard('CORE-1')
    r.state.comments['m-5'] = [{ id: 'web-comment', author: 'WEB AUTHOR', body: 'WEB ONLY COMMENT', createdAt: new Date().toISOString() }]
    const orig = window.corral.workRequest; let release!: () => void; const pending = new Promise<void>((res) => { release = res }); let blocked = 0
    window.corral.workRequest = async (req) => {
      if (req.call.op === 'listStatuses' && req.call.spaceKey === 'WEB') { blocked++; await pending }
      return orig(req)
    }
    click('[data-link-row="WEB-1"] .issue-link-open'); await settle()
    expect(blocked).toBe(1)
    expect(q('[data-issue-detail="WEB-1"]')).not.toBeNull()
    await openCard('CORE-1')
    expect(el('[data-issue-activity]').textContent).not.toContain('WEB ONLY COMMENT')
    release(); await settle(20)
    console.log('R3-C', { current: q('[data-issue-detail]')?.getAttribute('data-issue-detail'), activity: el('[data-issue-activity]').textContent, children: el('[data-issue-children]').textContent })
    expect(el('[data-issue-activity]').textContent).not.toContain('WEB ONLY COMMENT')
    expect(q('[data-child-row="CORE-2"]')).not.toBeNull()
  })
})
describe('r3 follow-through', () => {
  it('A2 sync completion must not rebase an existing editor draft over unseen external changes', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MY OLD BASE DRAFT')
    const server = serverItem(r, 'm-2'); server.body = 'EXTERNAL BODY MUST SURVIVE'; server.version += 1
    setValue(input('[data-comment-composer] textarea'), 'TRIGGER SYNC')
    key(input('[data-comment-composer] textarea'), { key: 'Enter', metaKey: true }); await settle(16)
    expect(input('[data-md-editor] textarea').value).toBe('MY OLD BASE DRAFT')
    click('[data-md-save]'); await settle(16)
    console.log('R3-A2', { serverBody: server.body, banner: q('[data-issue-conflict]')?.textContent, writes: writes(r.calls) })
    expect(server.body).toBe('EXTERNAL BODY MUST SURVIVE')
    expect(q('[data-issue-conflict]')).not.toBeNull()
  })
  it('D after awaited parent refresh the queued write must actually succeed without self conflict', async () => {
    const r = await rig(); await openCard('CORE-1'); const release = hold('getItem')
    click('[data-child-add]'); setValue(input('[data-child-title]'), 'CHILD'); key(input('[data-child-title]'), { key: 'Enter' }); await settle()
    // 막힌 칸이라 메뉴가 열리지 않는다 — 열렸다면 그대로 눌러 본다(쓰기 0 이어야 한다).
    click('[data-field="priority"]'); if (q('[data-priority-row="high"]') !== null) click('[data-priority-row="high"]'); await settle()
    expect(writes(r.calls).filter((c) => c.op === 'updateItem')).toHaveLength(0)
    expect(el('[data-field="priority"]').hasAttribute('disabled')).toBe(true)
    await release(); await settle(16)
    // 수정 5(기준 변경 — 직렬화): 부모 재조회 중의 우선순위는 막히고(원 기대: 예약 뒤 저장 — test-audit.md), 끝난 뒤 누른 저장은 자기 충돌 없이 저장된다.
    expect(writes(r.calls).filter((c) => c.op === 'updateItem')).toHaveLength(0)
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    const server = serverItem(r, 'm-1')
    console.log('R3-D', { priority: server.priority, version: server.version, banner: q('[data-issue-conflict]')?.textContent, writes: writes(r.calls) })
    expect(server.priority).toBe('high')
    expect(q('[data-issue-conflict]')).toBeNull()
  })
  it('E initial detail load must not offer a title save that silently vanishes', async () => {
    const r = await rig(); const release = hold('getItem'); await openCard('CORE-2')
    const title = input('[data-issue-title]'); act(() => title.focus()); setValue(title, 'TYPED WHILE LOADING'); act(() => title.blur()); await settle()
    const before = { readOnly: title.readOnly, writes: writes(r.calls), shown: title.value }
    await release()
    const server = serverItem(r, 'm-2')
    console.log('R3-E', { before, after: input('[data-issue-title]').value, serverTitle: server.title, error: q('[data-toast="failed"]')?.textContent })
    expect(before.readOnly || server.title === 'TYPED WHILE LOADING' || !!q('[data-toast="failed"]')).toBe(true)
  })
})

// --- 같은 모양의 다른 칸·다른 await 지점 · 양성 대조 (수정 3 워커 추가) ---
describe('r3 같은 모양 — 편집 기준(R3-A)', () => {
  it('A-title 제목 편집 중 외부 제목 변경 → 부수 재조회 완료 → 저장: 저장 안 됨 · 배너(제목) · 외부 제목 보존', async () => {
    const r = await rig(); await openCard('CORE-2')
    const title = input('[data-issue-title]'); act(() => title.focus()); setValue(title, 'MY TITLE DRAFT')
    const server = serverItem(r, 'm-2'); server.title = 'EXTERNAL TITLE MUST SURVIVE'; server.version += 1
    await sendComment('TRIGGER SYNC')
    expect(input('[data-issue-title]').value).toBe('MY TITLE DRAFT')
    act(() => title.blur()); await settle(16)
    console.log('R3-A-title', { serverTitle: server.title, fields: conflictFieldsShown() })
    expect(server.title).toBe('EXTERNAL TITLE MUST SURVIVE')
    expect(conflictFieldsShown()).toContain('title')
  })
  it('A-field 재조회 중 누른 즉시 저장 — 막혀 나가지 않고(수정 5 직렬화), 재조회가 실어 온 다른 곳의 변경은 화면에 보인 뒤 보존', async () => {
    const r = await rig(); await openCard('CORE-2')
    const held = holdWhere((call) => call.op === 'getItem')
    await sendComment('TRIGGER SYNC')
    const server = serverItem(r, 'm-2'); server.title = 'EXTERNAL TITLE'; server.version += 1
    click('[data-field="priority"]'); if (q('[data-priority-row="high"]') !== null) click('[data-priority-row="high"]'); await settle()
    const during = writes(r.calls).filter((c) => c.op === 'updateItem').length
    await held.release()
    console.log('R3-A-field', { during, priority: server.priority, title: server.title, fields: conflictFieldsShown() })
    // 원 기대(대기 뒤 기준 판으로 나가 배너 · 우선순위 medium)는 test-audit.md 「기준 변경으로 기대 수정」 — 이제 그 저장은 아예 나가지 않는다.
    expect(during).toBe(0)
    expect(server.priority).toBe('medium')
    expect(server.title).toBe('EXTERNAL TITLE')
    expect(input('[data-issue-title]').value).toBe('EXTERNAL TITLE')
  })
  it('A-seen 대조 — 재조회로 화면에 보인 뒤 누른 즉시 저장은 지금 화면의 판으로 간다(배너 없음)', async () => {
    const r = await rig(); await openCard('CORE-2')
    const server = serverItem(r, 'm-2'); server.title = 'EXTERNAL TITLE'; server.version += 1
    await sendComment('TRIGGER SYNC')
    expect(input('[data-issue-title]').value).toBe('EXTERNAL TITLE')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    expect(server.priority).toBe('high')
    expect(server.title).toBe('EXTERNAL TITLE')
    expect(q('[data-issue-conflict]')).toBeNull()
  })
  it('A-own 대조 — 본문 편집 중 내 우선순위 저장 성공 뒤 본문 저장은 자기 충돌하지 않는다', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'BODY AFTER MY PRIORITY')
    click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
    expect(serverItem(r, 'm-2').priority).toBe('high')
    click('[data-md-save]'); await settle(16)
    const server = serverItem(r, 'm-2')
    expect(server.body).toBe('BODY AFTER MY PRIORITY')
    expect(server.priority).toBe('high')
    expect(q('[data-issue-conflict]')).toBeNull()
    expect(q('[data-md-editor]')).toBeNull()
  })
  it('A-child 대조 — 본문 편집 중 자식 생성(부모 판 오름) 뒤 본문 저장은 자기 충돌하지 않는다', async () => {
    const r = await rig(); await openCard('CORE-1')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'BODY AFTER CHILD')
    const version0 = serverItem(r, 'm-1').version
    click('[data-child-add]'); setValue(input('[data-child-title]'), 'CHILD'); key(input('[data-child-title]'), { key: 'Enter' }); await settle(16)
    expect(serverItem(r, 'm-1').version).not.toBe(version0)
    click('[data-md-save]'); await settle(16)
    expect(serverItem(r, 'm-1').body).toBe('BODY AFTER CHILD')
    expect(q('[data-issue-conflict]')).toBeNull()
    expect(q('[data-md-editor]')).toBeNull()
  })
  it('A-child-sync 본문 편집 중 자식 생성 → 재조회 지연 중 본문 저장 → 해제: 저장되고 배너 없음', async () => {
    const r = await rig(); await openCard('CORE-1')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'BODY DURING CHILD SYNC')
    const held = holdWhere((call) => call.op === 'getItem')
    click('[data-child-add]'); setValue(input('[data-child-title]'), 'CHILD'); key(input('[data-child-title]'), { key: 'Enter' }); await settle()
    click('[data-md-save]'); await settle()
    const during = writes(r.calls).filter((c) => c.op === 'updateItem').length
    await held.release()
    // 수정 5(기준 변경 — 직렬화): 자식 재조회 중 저장은 막히고 초안·편집기가 남는다(원 기대: 대기 뒤 저장 — test-audit.md). 끝난 뒤 다시 저장하면 배너 없이 저장.
    expect(during).toBe(0)
    expect(input('[data-md-editor] textarea').value).toBe('BODY DURING CHILD SYNC')
    click('[data-md-save]'); await settle(16)
    expect(serverItem(r, 'm-1').body).toBe('BODY DURING CHILD SYNC')
    expect(q('[data-issue-conflict]')).toBeNull()
    expect(q('[data-md-editor]')).toBeNull()
  })
})

describe('r3 같은 모양 — 결과를 받지 못한 내 쓰기(감사에서 찾은 자기 충돌)', () => {
  it('A-gen 세대가 바뀌는 사이 앞 본문 저장이 닿았으면 다시 저장은 배너(자기 충돌로 보임 — 수정 5 재시도 제거 비용) · 덮기로 끝난다', async () => {
    const r = await rig(); await openCard('CORE-2'); const held = holdWhere((call) => call.op === 'updateItem')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'DRAFT GEN'); click('[data-md-save]')
    await act(async () => { await r.service.addConnection({ sourceId: 'mock-jira', token: 'mock_l602_new_generation', replaceId: r.connectionId }) })
    await settle(); await held.release()
    click('[data-md-save]'); await settle(16)
    // 원 기대(자동 재시도로 배너 없이 저장)는 test-audit.md 「기준 변경으로 기대 수정」.
    expect(serverItem(r, 'm-2').body).toBe('DRAFT GEN')
    expect(q('[data-issue-conflict]')).not.toBeNull()
    click('[data-conflict-override]'); await settle(16)
    expect(serverItem(r, 'm-2').body).toBe('DRAFT GEN')
    expect(q('[data-issue-conflict]')).toBeNull()
    expect(q('[data-md-editor]')).toBeNull()
  })
  it('A-gen-mixed 같은 경우라도 다른 곳의 변경(제목)이 섞였으면 다시 보내지 않고 배너(제목) — 외부 제목 보존', async () => {
    const r = await rig(); await openCard('CORE-2'); const held = holdWhere((call) => call.op === 'updateItem')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'DRAFT GEN'); click('[data-md-save]')
    await act(async () => { await r.service.addConnection({ sourceId: 'mock-jira', token: 'mock_l602_new_generation', replaceId: r.connectionId }) })
    await settle(); await held.release()
    const server = serverItem(r, 'm-2'); server.title = 'EXTERNAL TITLE'; server.version += 1
    setValue(input('[data-md-editor] textarea'), 'DRAFT GEN 2')
    const sent = writes(r.calls).length
    click('[data-md-save]'); await settle(16)
    expect(writes(r.calls).length).toBe(sent + 1)
    expect(server.body).toBe('DRAFT GEN')
    expect(server.title).toBe('EXTERNAL TITLE')
    expect(conflictFieldsShown()).toContain('title')
    expect(input('[data-md-editor] textarea').value).toBe('DRAFT GEN 2')
  })
})

describe('r3 같은 모양 — 덮기 후처리(R3-B)', () => {
  it('B3 대조 — 본문 덮기 중 더 고치지 않았으면 성공 뒤 편집기를 닫는다', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'MINE OVER REMOTE')
    const server = serverItem(r, 'm-2'); server.body = 'REMOTE'; server.version += 1
    click('[data-md-save]'); await settle()
    expect(q('[data-issue-conflict]')).not.toBeNull()
    click('[data-conflict-override]'); await settle(16)
    expect(server.body).toBe('MINE OVER REMOTE')
    expect(q('[data-md-editor]')).toBeNull()
    expect(q('[data-issue-conflict]')).toBeNull()
  })
  it('B4 본문 덮기 중 더 고친 초안은 다음 저장에서 자기 충돌 없이 저장된다', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'V1')
    const server = serverItem(r, 'm-2'); server.body = 'REMOTE'; server.version += 1
    click('[data-md-save]'); await settle()
    const held = holdWhere((call) => call.op === 'updateItem')
    click('[data-conflict-override]')
    setValue(input('[data-md-editor] textarea'), 'V2')
    await held.release()
    expect(server.body).toBe('V1')
    click('[data-md-save]'); await settle(16)
    expect(server.body).toBe('V2')
    expect(q('[data-issue-conflict]')).toBeNull()
    expect(q('[data-md-editor]')).toBeNull()
  })
})

describe('r3 같은 모양 — 체인 origin(R3-C)', () => {
  const seedWeb = (r: Rig): void => {
    r.state.comments['m-5'] = [{ id: 'web-comment', author: 'WEB AUTHOR', body: 'WEB ONLY COMMENT', createdAt: new Date().toISOString() }]
  }
  for (const [label, match] of [
    ['listComments', (call: WorkCall) => call.op === 'listComments' && call.itemId === 'm-5'],
    ['listHistory', (call: WorkCall) => call.op === 'listHistory' && call.itemId === 'm-5'],
    ['listChildren', (call: WorkCall) => call.op === 'listChildren' && call.itemId === 'm-5'],
    ['첫 getItem', (call: WorkCall) => call.op === 'getItem' && call.itemId === 'm-5'],
  ] as const) {
    it(`C-${label} 이전 상세(WEB-1)의 ${label} 지연 → CORE-1 로 돌아옴 → 해제: CORE-1 의 활동·자식이 그대로`, async () => {
      const r = await rig(); await openCard('CORE-1'); seedWeb(r)
      const held = holdWhere(match)
      click('[data-link-row="WEB-1"] .issue-link-open'); await settle()
      expect(held.held()).toBe(1)
      await openCard('CORE-1')
      await held.release()
      expect(q('[data-issue-detail="CORE-1"]')).not.toBeNull()
      expect(el('[data-issue-activity]').textContent).not.toContain('WEB ONLY COMMENT')
      expect(q('[data-child-row="CORE-2"]')).not.toBeNull()
    })
  }
  it('C-write 이전 상세의 코멘트 쓰기 지연 → 다른 작업으로 → 해제: 새 상세의 코멘트·활동·초안 그대로', async () => {
    const r = await rig(); await openCard('CORE-2')
    const held = holdWhere((call) => call.op === 'addComment')
    await sendComment('OLD ITEM COMMENT')
    await openCard('CORE-1')
    setValue(input('[data-comment-composer] textarea'), 'NEW DRAFT')
    await held.release()
    expect(r.state.comments['m-2']?.some((entry) => entry.body === 'OLD ITEM COMMENT')).toBe(true)
    expect(el('[data-issue-activity]').textContent).not.toContain('OLD ITEM COMMENT')
    expect(input('[data-comment-composer] textarea').value).toBe('NEW DRAFT')
    expect(q('[data-child-row="CORE-2"]')).not.toBeNull()
  })
})

describe('r3 같은 모양 — 준비 경계(R3-E)', () => {
  it('E2 상세를 받기 전에는 우선순위·마감·연결·자식 칸이 막혀 있고, 받은 뒤 풀린다', async () => {
    await rig(); const held = holdWhere((call) => call.op === 'getItem'); await openCard('CORE-1')
    const before = {
      title: input('[data-issue-title]').readOnly,
      priority: el('[data-field="priority"]').hasAttribute('disabled'),
      due: el('[data-field="due"]').hasAttribute('disabled'),
      link: el('[data-link-add]').hasAttribute('disabled'),
      child: el('[data-child-add]').hasAttribute('disabled'),
    }
    await held.release()
    const after = {
      title: input('[data-issue-title]').readOnly,
      priority: el('[data-field="priority"]').hasAttribute('disabled'),
      due: el('[data-field="due"]').hasAttribute('disabled'),
      link: el('[data-link-add]').hasAttribute('disabled'),
      child: el('[data-child-add]').hasAttribute('disabled'),
    }
    expect(before).toEqual({ title: true, priority: true, due: true, link: true, child: true })
    expect(after).toEqual({ title: false, priority: false, due: false, link: false, child: false })
  })
  it('E3 상세를 받기 전 코멘트 ⌘↵ — 보내지 않고 그 자리에 이유를 보인다(초안 유지)', async () => {
    const r = await rig(); const held = holdWhere((call) => call.op === 'getItem'); await openCard('CORE-2')
    await sendComment('BEFORE LOAD')
    const shown = { error: q('[data-comment-error]')?.textContent ?? null, draft: input('[data-comment-composer] textarea').value }
    await held.release()
    expect(writes(r.calls).filter((call) => call.op === 'addComment')).toHaveLength(0)
    expect(shown.error).not.toBeNull()
    expect(input('[data-comment-composer] textarea').value).toBe('BEFORE LOAD')
  })
})
