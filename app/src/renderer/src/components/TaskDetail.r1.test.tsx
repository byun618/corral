// @vitest-environment happy-dom
// LIFE-602 수정 1 — Codex 리뷰 r1 재현(`raw/review/codex-r1-raw/review.test.tsx`)을 가져와 회귀 시험으로 둔다. 기대값은 리뷰의 것 그대로이고,
// 동작을 바꾸기로 한 두 곳(L: 상세를 받기 전 편집 진입을 막음 · Q: 복원할 수 없는 완료 갈래는 되돌리기를 막음)만 그 결정에 맞춰 고쳤다.
// 지적별 시험: R1-A = A·B·G · R1-B = L · R1-C = H·H2·H3 · R1-D = C·D · R1-E = I · R1-G = Q·Q2 · R1-H = E·K · R1-I = J(+편집기) · O = 잠금 중 되돌리기(지적 아님).
// R1-F(⌘B·⌘K) 는 `useKeybindings.editor.test.tsx` 와 격리 Electron(`scripts/l602/q-keys.mjs`).
// 실제 WorkService(모의 출처 · 메모리 활동 저장소) 또는 LaSource + 루프백 LA 모의 MCP 를 preload 자리에 잇는다. mixed 검사(tsconfig.mixed.json).
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
import { FAKE_LA_TOKEN, FakeCipher, MemoryStore, workHarness } from '../../../main/work/test-kit.js'
import { FIXTURE_STATUS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../../main/work/la-source.js'
import http from 'node:http'
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
function undoLast(label: string): void {
 const undo=[...document.querySelectorAll('[data-toast="moved"]')].find((e)=>e.textContent?.includes(label))?.querySelector('[data-toast-undo]')
 expect(undo).toBeTruthy()
 act(()=>undo?.dispatchEvent(new MouseEvent('click',{bubbles:true})))
}

describe('독립 재현 - 기대 결과는 기준 문구',()=>{
 it('A: 앞 상세 댓글 응답이 새 상세에 나타나지 않고 새 초안을 지킨다', async()=>{
  const r=await rig(); await openCard('CORE-2')
  const release=hold('addComment')
  setValue(input('[data-comment-composer] textarea'),'CORE-2 ONLY COMMENT')
  key(input('[data-comment-composer] textarea'),{key:'Enter',metaKey:true})
  await openCard('CORE-4')
  setValue(input('[data-comment-composer] textarea'),'CORE-4 UNSAVED DRAFT')
  await release()
  console.log('A', {detail:el('[data-issue-detail]').dataset.issueDetail, draft:input('[data-comment-composer] textarea').value,comments:[...document.querySelectorAll('[data-activity-row="comment"]')].map(e=>e.textContent),server:r.state.comments})
  expect(input('[data-comment-composer] textarea').value).toBe('CORE-4 UNSAVED DRAFT')
  expect(el('[data-issue-activity]').textContent).not.toContain('CORE-2 ONLY COMMENT')
 })
 it('B: 앞 상세 본문 저장 응답이 새 상세 편집기를 닫지 않는다',async()=>{
  await rig(); await openCard('CORE-2')
  const release=hold('updateItem')
  click('[data-issue-body-edit]');setValue(input('[data-md-editor] textarea'),'CORE-2 SAVED BODY')
  click('[data-md-save]')
  await openCard('CORE-4')
  click('[data-issue-body-edit]');setValue(input('[data-md-editor] textarea'),'CORE-4 UNSAVED BODY')
  await release()
  console.log('B',{detail:el('[data-issue-detail]').dataset.issueDetail,editor:q('[data-md-editor]')!==null})
  expect(q('[data-md-editor]')).not.toBeNull()
  expect(input('[data-md-editor] textarea').value).toBe('CORE-4 UNSAVED BODY')
 })
 it('C: 연결 떼기 되돌리기는 서버와 열린 상세를 함께 복원한다',async()=>{
  const r=await rig();await openCard('CORE-2')
  click('[data-link-add]');setValue(input('[data-link-key]'),'CORE-3');click('[data-link-submit]');await settle()
  click('[data-link-row="CORE-3"] [data-link-remove]');await settle()
  undoLast('연결 뗌');await settle(16)
  console.log('C',{visible:q('[data-link-row="CORE-3"]')!==null,server:r.state.links.filter(e=>e.from==='m-2'||e.to==='m-2'),activity:el('[data-issue-activity]').textContent})
  expect(q('[data-link-row="CORE-3"]')).not.toBeNull()
 })
 it('D: 새 연결 추가가 활동에 즉시 보인다',async()=>{
  const r=await rig();await openCard('CORE-2')
  click('[data-link-add]');setValue(input('[data-link-key]'),'CORE-3');click('[data-link-submit]');await settle(16)
  console.log('D',{records:r.activity.records,visible:el('[data-issue-activity]').textContent})
  expect(el('[data-issue-activity]').textContent).toContain('연결 추가')
 })
 it('E: 없는 키는 쓰기 요청 0이다',async()=>{
  const r=await rig();await openCard('CORE-2')
  click('[data-link-add]');setValue(input('[data-link-key]'),'CORE-999999');click('[data-link-submit]');await settle()
  console.log('E',{writes:writes(r.calls),error:q('[data-link-error]')?.textContent})
  expect(writes(r.calls)).toHaveLength(0)
 })
 it('F: 서명 없는 목록 체킹 행의 바이트 보존과 저장 중 두번째 클릭 차단',async()=>{
  const r=await rig();const source='a\r\n- [ ] same\r\n\t- [ ] nested\r\n> - [ ] quoted\r\n\r\n```\r\n- [ ] code\r\n```\r\n- [ ] same\r\n'
  const item=r.state.items.find(e=>e.id==='m-1')!;item.body=source
  await openCard('CORE-1');const release=hold('updateItem')
  const boxes=[...document.querySelectorAll('[data-issue-body] input[type=checkbox]')]
  expect(boxes).toHaveLength(4)
  console.log('F lines',boxes.map(b=>b.getAttribute('data-md-check')))
  act(()=>boxes[3]?.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  await settle();expect(el('[data-issue-body] input[type=checkbox]')).toHaveProperty('disabled',true)
  await release();expect(item.body).toBe(source.slice(0,source.lastIndexOf('[ ]'))+'[x]'+source.slice(source.lastIndexOf('[ ]')+3))
 })
})

describe('독립 재현 - 응답 귀속과 지연',()=>{
 it('G: 앞 상세 연결 추가 응답이 새 상세 자체를 앞 작업으로 되돌리지 않는다',async()=>{
  await rig();await openCard('CORE-2');const release=hold('addRelation')
  click('[data-link-add]');setValue(input('[data-link-key]'),'CORE-3');click('[data-link-submit]')
  await openCard('CORE-4');await release()
  console.log('G',{detail:el('[data-issue-detail]').dataset.issueDetail,selected:[...document.querySelectorAll('[data-issue-card].is-selected')].map(e=>e.getAttribute('data-issue-card'))})
  expect(el('[data-issue-detail]').dataset.issueDetail).toBe('CORE-4')
 })
 it('H: 단일 30초 지연 뒤 실패는 상세 우선순위도 서버 값으로 되돌린다',async()=>{
  const r=await rig({token:'mock_l602_reject-writes'});await openCard('CORE-2')
  const release=hold('updateItem')
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']})
  click('[data-field="priority"]');click('[data-priority-row="high"]')
  await act(async()=>{await vi.advanceTimersByTimeAsync(30001)})
  vi.useRealTimers()
  await release()
  console.log('H',{server:r.state.items.find(e=>e.id==='m-2')?.priority,detail:el('[data-field="priority"]').textContent,toast:q('[data-toast="failed"]')?.textContent,calls:r.calls.map(c=>c.op)})
  expect(el('[data-field="priority"]').textContent).toContain('보통')
 })
 it('H2: 본문 저장이 30초 확인 지연 뒤 거절되면 편집기와 초안이 남고 오류를 보인다(R1-C)', async () => {
  const r = await rig({ token: 'mock_l602_reject-writes' }); await openCard('CORE-2')
  click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'CORE-2 LATE DRAFT')
  const release = hold('updateItem')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-md-save]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers()
  expect(q('[data-md-editor]')).not.toBeNull()
  await release()
  expect(q('[data-md-editor]')).not.toBeNull()
  expect(input('[data-md-editor] textarea').value).toBe('CORE-2 LATE DRAFT')
  expect(el('[data-md-editor]').textContent).toContain('저장하지 못했습니다')
  expect(r.state.items.find((entry) => entry.id === 'm-2')?.body).toBe('카드 저장 본문')
 })
 it('H3: 30초 확인 지연 뒤 성공하면 상세가 서버 판을 받아 다음 저장이 자기 충돌하지 않는다(R1-C)', async () => {
  const r = await rig(); await openCard('CORE-2')
  const release = hold('updateItem')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]'); click('[data-priority-row="high"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers()
  await release(); await settle(16)
  expect(el('[data-field="priority"]').textContent).toContain('높음')
  click('[data-field="priority"]'); click('[data-priority-row="low"]'); await settle(16)
  expect(q('[data-issue-conflict]')).toBeNull()
  expect(r.state.items.find((entry) => entry.id === 'm-2')?.priority).toBe('low')
 })
 it('I: 자식 생성 뒤 새 부모 판으로 다음 필드 저장을 보낸다',async()=>{
  const r=await rig();await openCard('CORE-1')
  click('[data-child-add]');setValue(input('[data-child-title]'),'new child');key(input('[data-child-title]'),{key:'Enter'});await settle(16)
  click('[data-field="priority"]');click('[data-priority-row="high"]');await settle(16)
  console.log('I',{conflict:q('[data-issue-conflict]')?.textContent,writes:writes(r.calls)})
  expect(q('[data-issue-conflict]')).toBeNull()
 })
 it('J: Esc 는 열린 상세 메뉴부터 닫고 제목 입력을 유지한다',async()=>{
  await rig();await openCard('CORE-2');click('[data-issue-status]');await settle()
  const title=input('[data-issue-title]');act(()=>title.focus());key(title,{key:'Escape'});await settle()
  console.log('J',{menu:q('[data-tasks-menu="status"]')!==null,focus:document.activeElement?.getAttribute('data-issue-title')})
  expect(q('[data-tasks-menu="status"]')).toBeNull()
 })
 it('J2: 본문 편집기에 포커스가 있어도 열린 우선순위 메뉴가 먼저 닫히고 편집기·초안은 남는다(R1-I)', async () => {
  const r = await rig(); await openCard('CORE-2')
  click('[data-issue-body-edit]'); const area = input('[data-md-editor] textarea'); setValue(area, 'KEEP')
  click('[data-field="priority"]'); expect(q('[data-tasks-menu="priority-field"]')).not.toBeNull()
  act(() => area.focus()); key(area, { key: 'Escape' }); await settle()
  expect(q('[data-tasks-menu="priority-field"]')).toBeNull()
  expect(q('[data-md-editor]')).not.toBeNull(); expect(input('[data-md-editor] textarea').value).toBe('KEEP')
  key(area, { key: 'Escape' }); await settle()
  expect(q('[data-md-editor]')).toBeNull(); expect(writes(r.calls)).toHaveLength(0)
 })
})

/** LaSource + 루프백 LA 모의 MCP(실제 LA 무접촉, 가짜 토큰) — happy-dom 의 fetch 대신 node:http 로 루프백에 닿는다. */
async function laRig(): Promise<{ fixture: LaMcpFixture; calls: WorkCall[]; stop: () => Promise<void> }> {
  const fixture = new LaMcpFixture()
  fixture.tokens.set(FAKE_LA_TOKEN, 'write')
  const url = await fixture.start()
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value })
    const target = input instanceof Request ? input.url : String(input)
    const req = http.request(target, { method: init?.method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        const out = new Headers()
        for (const [name, value] of Object.entries(res.headers)) if (typeof value === 'string') out.set(name, value)
        resolve(new Response(text.length > 0 ? text : null, { status: res.statusCode, headers: out }))
      })
    })
    req.on('error', reject)
    req.end(typeof init?.body === 'string' ? init.body : undefined)
  })
  const h = workHarness({ entries: [laSourceEntry({ url, clientVersion: 'test', fetchImpl })] })
  const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('LA 모의 연결 실패')
  const calls: WorkCall[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => h.service.settings(), onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => { calls.push(request.call); return h.service.request(request) },
    workActivity: async (query: unknown) => h.service.activity(query),
  })
  act(() => root.render(createElement('div', null, createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
  await settle(30)
  return { fixture, calls, stop: () => fixture.stop() }
}

describe('LA 모의 MCP 화면 (R1-H · R1-G)', () => {
  it('K: 충돌 검사 꺼진 LA — 나중 저장이 이기고 배너 0 · 없는 키 연결은 issue_link_create 0회(R1-H)', async () => {
    const la = await laRig()
    try {
      await openCard('LIFE-600'); await settle(20)
      const issue = la.fixture.issues.find((entry) => entry.sequentialId === 600)
      if (issue === undefined) throw new Error('LIFE-600 없음')
      issue.priority = 'low'; issue.updatedAt = '2026-10-14T12:00:00Z'
      click('[data-field="priority"]'); click('[data-priority-row="highest"]'); await settle(30)
      expect(issue.priority).toBe('highest'); expect(q('[data-issue-conflict]')).toBeNull()
      expect(writes(la.calls)).toContainEqual(expect.objectContaining({ op: 'updateItem', ifVersion: null }))
      const before = writes(la.calls).length
      click('[data-link-add]'); setValue(input('[data-link-key]'), 'LIFE-99999'); click('[data-link-submit]'); await settle(30)
      const linkTools = la.fixture.requests.filter((entry) => entry.tool === 'issue_link_create')
      console.log('K-missing', JSON.stringify({ linkTools: linkTools.length, error: q('[data-link-error]')?.textContent, writes: writes(la.calls).length - before }))
      expect(linkTools).toHaveLength(0)
      expect(writes(la.calls)).toHaveLength(before)
      expect(q('[data-link-error]')?.textContent).toContain('없는 작업')
      // 양성 대조: 있는 키(LIFE-601)면 같은 경로가 issue_link_create 를 1회 보낸다.
      setValue(input('[data-link-key]'), 'LIFE-601'); click('[data-link-submit]'); await settle(30)
      expect(la.fixture.requests.filter((entry) => entry.tool === 'issue_link_create')).toHaveLength(1)
    } finally { await la.stop() }
  })
})

describe('독립 재현 - 편집 준비와 IME',()=>{
 it('L: 상세 본문을 받기 전에는 편집에 들어갈 수 없고, 받은 뒤 연 편집기는 서버 본문으로 시작한다(R1-B)', async () => {
  const r = await rig(); const old = r.state.items.find((entry) => entry.id === 'm-1')?.body
  const release = hold('getItem'); await openCard('CORE-1')
  expect(el('[data-issue-body-edit]')).toHaveProperty('disabled', true)
  click('[data-issue-body-edit]')
  act(() => { el('[data-issue-body] .issue-body-view').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(q('[data-md-editor]')).toBeNull()
  await release()
  click('[data-issue-body-edit]')
  expect(input('[data-md-editor] textarea').value).toBe(old)
  click('[data-md-save]'); await settle()
  expect(r.state.items.find((entry) => entry.id === 'm-1')?.body).toBe(old)
 })
 it('M: 제목 조합 중 Enter 와 Esc 는 쓰기와 blur를 일으키지 않는다',async()=>{
  const r=await rig();await openCard('CORE-2');const title=input('[data-issue-title]');act(()=>title.focus());setValue(title,'한글')
  key(title,{key:'Enter',isComposing:true,keyCode:229});key(title,{key:'Escape',isComposing:true,keyCode:229});await settle()
  expect(writes(r.calls)).toHaveLength(0);expect(document.activeElement).toBe(title)
  key(title,{key:'Escape'});await wait(25);expect(writes(r.calls)).toHaveLength(0)
 })
 it('N: 본문 조합 중 단축키와 Esc 는 내용을 바꾸거나 편집기를 닫지 않는다',async()=>{
  const r=await rig();await openCard('CORE-2');click('[data-issue-body-edit]');const area=input('[data-md-editor] textarea');setValue(area,'- 한글')
  act(()=>area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})))
  for(const k of [{key:'Enter'},{key:'Enter',metaKey:true},{key:'b',metaKey:true},{key:'Escape'}])key(area,{...k,isComposing:true,keyCode:229})
  expect(q('[data-md-editor]')).not.toBeNull();expect(area.value).toBe('- 한글');expect(writes(r.calls)).toHaveLength(0)
  act(()=>area.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})))
 })
})

describe('독립 재현 - 되돌리기 잠금',()=>{
 it('O: 새 저장 중 이전 토스트의 되돌리기를 누르면 토스트를 유지한다',async()=>{
  const r=await rig();await openCard('CORE-2')
  click('[data-field="priority"]');click('[data-priority-row="high"]');await settle()
  const release=hold('setPlacement');click('[data-placement="backlog"]');await settle()
  undoLast('우선순위');await wait(600)
  const undoStill=[...document.querySelectorAll('[data-toast="moved"]')].some(e=>e.textContent?.includes('우선순위'))
  console.log('O',{undoStill,writes:writes(r.calls),errors:[...document.querySelectorAll('[data-toast="failed"]')].map(e=>e.textContent)})
  await release()
  expect(undoStill).toBe(true)
 })
})

describe('독립 재현 - hostile markdown',()=>{
 it('P: raw HTML·엔티티·scheme 혼합을 렌더하고 클릭한다',async()=>{
  const {MarkdownView}=await import('./MarkdownView.js')
  const hostile='<img src=x onerror="window.__review=1"><script>window.__review=2</script><iframe src=x></iframe><svg onload="window.__review=3"></svg>\n\n&lt;img src=x onerror=alert(1)&gt;\n\n'
  const hrefs=['javascript:alert(1)','JaVaScRiPt:alert(1)','javascript&#58;alert(1)','data:text/html,foo','file:///tmp/x','//host/x','/relative','../relative','java\tscript:alert(1)','java&#x09;script:alert(1)','corral:foo','HTTP://example.com/a','https://example.com/b']
  const opened:string[]=[];const blocked:string[]=[]
  vi.spyOn(window,'open').mockImplementation((url?: string | URL)=>{opened.push(String(url));return null})
  act(()=>root.render(createElement(MarkdownView,{source:hostile+hrefs.map((u,i)=>`[link${i}](<${u}>)`).join(' '),keyPattern:'X-\\d+',onOpenKey:()=>{},onBlockedLink:r=>blocked.push(r)})))
  const dom=el('[data-md-rendered]')
  expect(dom.querySelectorAll('img,script,iframe,svg')).toHaveLength(0);expect(Reflect.get(window,'__review')).toBeUndefined()
  for(const a of dom.querySelectorAll('a'))act(()=>a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})))
  console.log('P',{hrefs:[...dom.querySelectorAll('a')].map(a=>a.getAttribute('href')),opened,blocked:blocked.length})
  expect(opened).toEqual(['http://example.com/a','https://example.com/b'])
 })
})

describe('LA 원래 완료 갈래 (R1-G)', () => {
  it('Q: archived 완료 작업을 내렸을 때 — 되돌리기 버튼 없이 사실을 알리고, completed 로 바꿔 끼우는 쓰기를 보내지 않는다', async () => {
    const la = await laRig()
    try {
      const issue = la.fixture.issues.find((entry) => entry.sequentialId === 600)
      if (issue === undefined) throw new Error('LIFE-600 없음')
      issue.statusId = FIXTURE_STATUS.done; issue.resolution = 'archived'
      await openCard('LIFE-600'); await settle(20)
      click('[data-issue-status]'); await settle(); click(`[data-status-row="${FIXTURE_STATUS.dev}"]`); click('[data-confirm-ok]'); await settle(30)
      const toasts = [...document.querySelectorAll('[data-toast]')].filter((entry) => entry.textContent?.includes('LIFE-600'))
      console.log('Q', JSON.stringify({ toasts: toasts.map((entry) => [entry.getAttribute('data-toast'), entry.textContent]), resolution: issue.resolution, writes: writes(la.calls) }))
      expect(toasts.map((entry) => entry.getAttribute('data-toast'))).toEqual(['final'])
      expect(toasts[0]?.textContent).toContain('복원할 수 없어')
      expect(document.querySelector('[data-toast-undo]')).toBeNull()
      expect(writes(la.calls).filter((call) => call.op === 'changeStatus')).toHaveLength(1)
      expect(issue.resolution).not.toBe('completed')
    } finally { await la.stop() }
  })

  it('Q2: 취소함 작업을 보드에서 끌어 내린 뒤 되돌리면 취소함으로 돌아간다(완료함 아님, 모의)', async () => {
    const r = await rig()
    await openCard('CORE-4')
    click('[data-issue-status]'); await settle()
    click('[data-status-row="core-done"][data-status-resolution="cancelled"]'); await settle()
    click('[data-issue-close]'); await settle()
    const zone = q('[data-drop-zone="col:st:core-review"]')
    const handle = q('[data-tasks-board] [data-issue-card="CORE-4"]')
    if (zone === null || handle === null) throw new Error('끌기 대상 없음')
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(zone)
    const mouse = (target: EventTarget, name: string, x = 10, y = 10): void => { act(() => { target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
    mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle(16)
    expect(r.state.items.find((entry) => entry.id === 'm-4')?.statusKey).toBe('core-review')
    undoLast('CORE-4'); await settle(16)
    const back = r.state.items.find((entry) => entry.id === 'm-4')
    expect(back?.statusKey).toBe('core-done')
    expect(back?.resolution).toBe('cancelled')
    expect(writes(r.calls).at(-1)).toEqual(expect.objectContaining({ op: 'changeStatus', statusKey: 'core-done', resolution: 'cancelled' }))
  })
})
