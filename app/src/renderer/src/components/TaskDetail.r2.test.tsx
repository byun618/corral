// @vitest-environment happy-dom
// LIFE-602 수정 2 — Codex 리뷰 r2 재현(`raw/review/codex-r2-raw/review.test.tsx` V09 A–J)을 가져와 회귀 시험으로 둔다. 기대값은 리뷰 그대로.
// 규칙·경로 전수 표: specs/LIFE-602-task-detail/raw/claude/detail-async-rules.md (시험 이름이 그 표의 「시험」 칸).
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


describe('r2 independent edge reproductions', () => {
 it('A reopen same item: prior comment does not erase new draft', async () => {
  const r=await rig(); await openCard('CORE-2'); const release=hold('addComment')
  setValue(input('[data-comment-composer] textarea'),'OLD COMMENT')
  key(input('[data-comment-composer] textarea'),{key:'Enter',metaKey:true})
  await openCard('CORE-4'); await openCard('CORE-2')
  setValue(input('[data-comment-composer] textarea'),'NEW DRAFT AFTER REOPEN')
  await release()
  console.log('R2-A', {draft:input('[data-comment-composer] textarea').value, activity:el('[data-issue-activity]').textContent})
  expect(input('[data-comment-composer] textarea').value).toBe('NEW DRAFT AFTER REOPEN')
  expect(r.state.comments['m-2']?.filter(c=>c.body==='OLD COMMENT')).toHaveLength(1) // 수정 3 시험 감사: 앞 회차 코멘트는 서버에 한 번만
 })
 it('B body input during pending save must not silently disappear', async () => {
  const r=await rig(); await openCard('CORE-2'); const release=hold('updateItem')
  click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'),'SUBMITTED V1'); click('[data-md-save]')
  setValue(input('[data-md-editor] textarea'),'UNSAVED V2'); await release()
  console.log('R2-B',{editor:q('[data-md-editor]')!==null,body:r.state.items.find(i=>i.id==='m-2')?.body})
  expect(q('[data-md-editor]')).not.toBeNull()
  expect(input('[data-md-editor] textarea').value).toBe('UNSAVED V2')
 })
 it('C changed connection generation releases same-detail saving state', async () => {
  const r=await rig(); await openCard('CORE-2'); const release=hold('updateItem')
  click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'),'DRAFT GEN'); click('[data-md-save]')
  await act(async()=>{await r.service.addConnection({sourceId:'mock-jira',token:'mock_l602_new_generation',replaceId:r.connectionId})})
  await settle(); await release()
  console.log('R2-C',{disabled:input('[data-md-editor] textarea').disabled,save:el('[data-md-save]').outerHTML,busy:q('[data-issue-busy]')!==null,error:el('[data-md-editor]').textContent})
  expect(el('[data-md-save]')).toHaveProperty('disabled',false)
  // 수정 5(기준 변경 — 충돌 자동 재시도 제거): 풀린 저장 칸으로 다시 저장하면, 세대 사이 닿은 앞 저장 때문에 판이 달라 배너가 뜬다(자기 충돌로 보이는 배너 — 알려진 비용).
  // 원 기대(재시도로 배너 없이 닫힘)는 test-audit.md. 배너의 「내 값으로 덮기」 로 끝나는지까지 본다 — 최종 서버 값·화면.
  click('[data-md-save]'); await settle(16)
  expect(r.state.items.find(i=>i.id==='m-2')?.body).toBe('DRAFT GEN')
  expect(q('[data-issue-conflict]')).not.toBeNull()
  click('[data-conflict-override]'); await settle(16)
  expect(r.state.items.find(i=>i.id==='m-2')?.body).toBe('DRAFT GEN')
  expect(q('[data-md-editor]')).toBeNull()
  expect(q('[data-issue-conflict]')).toBeNull()
 })
 it('D child success before parent refresh: immediate next save must not self conflict', async () => {
  const r=await rig(); await openCard('CORE-1'); const release=hold('getItem')
  click('[data-child-add]'); setValue(input('[data-child-title]'),'CHILD'); key(input('[data-child-title]'),{key:'Enter'}); await settle()
  // 수정 5(기준 변경 — 같은 작업 쓰기 직렬화): 부모 재조회 중에는 우선순위 칸이 막혀 쓰기가 나가지 않는다(원 기대: 대기 뒤 저장 — test-audit.md).
  const during={disabled:el('[data-field="priority"]').hasAttribute('disabled'),updates:writes(r.calls).filter(c=>c.op==='updateItem').length}
  console.log('R2-D',{during,conflict:q('[data-issue-conflict]')?.textContent,writes:writes(r.calls)})
  await release(); await settle(16)
  expect(during).toEqual({disabled:true,updates:0})
  // 재조회가 끝난 뒤 바로 누른 저장은 자기 충돌 없이 저장된다 — 마지막 서버 값·화면.
  click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
  expect(r.state.items.find(i=>i.id==='m-1')?.priority).toBe('high')
  expect(q('[data-issue-conflict]')).toBeNull()
 })
 it('E delayed refresh snapshot cannot overwrite subsequent successful write', async () => {
  const r=await rig(); await openCard('CORE-2')
  const orig=window.corral.workRequest; let release!:()=>void; const pending=new Promise<void>(resolve=>release=resolve)
  let snapshots=0
  window.corral.workRequest=async request=>{const result=await orig(request); if(request.call.op==='getItem'&&request.call.itemId==='m-2'){snapshots++; await pending} return result}
  setValue(input('[data-comment-composer] textarea'),'comment then priority')
  key(input('[data-comment-composer] textarea'),{key:'Enter',metaKey:true}); await settle()
  // 수정 5(기준 변경 — 직렬화): 재조회 중에는 우선순위 칸이 막힌다(원 기대: 그 사이 저장이 나가고 낡은 재조회가 덮지 않음 — test-audit.md).
  // 낡은 재조회가 확정을 덮지 않는 규칙(R-stamp)은 보드 끌기 경로 T-stale-refresh-board 가 지킨다.
  const disabled=el('[data-field="priority"]').hasAttribute('disabled')
  console.log('R2-E before release',{snapshots,disabled,priority:el('[data-field="priority"]').textContent,conflict:q('[data-issue-conflict]')?.textContent})
  release(); await settle(16)
  expect(disabled).toBe(true)
  click('[data-field="priority"]'); click('[data-priority-row="high"]'); await settle(16)
  console.log('R2-E after release',{server:r.state.items.find(i=>i.id==='m-2')?.priority,priority:el('[data-field="priority"]').textContent})
  expect(el('[data-field="priority"]').textContent).toContain('높음')
  expect(r.state.items.find(i=>i.id==='m-2')?.priority).toBe('high')
 })
 it('F single late comment success appears and acknowledges sent draft', async () => {
  const r=await rig(); await openCard('CORE-2'); const release=hold('addComment')
  setValue(input('[data-comment-composer] textarea'),'LATE COMMENT')
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']})
  key(input('[data-comment-composer] textarea'),{key:'Enter',metaKey:true})
  await act(async()=>{await vi.advanceTimersByTimeAsync(30001)}); vi.useRealTimers(); await release()
  console.log('R2-F',{server:r.state.comments,activity:el('[data-issue-activity]').textContent,draft:input('[data-comment-composer] textarea').value})
  expect([...document.querySelectorAll('[data-activity-row="comment"]')].some(e=>e.textContent?.includes('LATE COMMENT'))).toBe(true)
 })
 it('G single late child success appears in children', async () => {
  const r=await rig(); await openCard('CORE-1'); const release=hold('createItem')
  click('[data-child-add]'); setValue(input('[data-child-title]'),'LATE CHILD')
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']})
  key(input('[data-child-title]'),{key:'Enter'})
  await act(async()=>{await vi.advanceTimersByTimeAsync(30001)}); vi.useRealTimers(); await release()
  console.log('R2-G',{server:r.state.items.filter(i=>i.title==='LATE CHILD'),children:el('[data-issue-children]').textContent})
  expect([...document.querySelectorAll('[data-child-row]')].some(e=>e.textContent?.includes('LATE CHILD'))).toBe(true)
 })
 it('H single late conflict must have conflict banner', async () => {
  const r=await rig(); await openCard('CORE-2'); const item=r.state.items.find(i=>i.id==='m-2')!; item.title='REMOTE CHANGE'; item.version+=1
  const release=hold('updateItem')
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']})
  click('[data-field="priority"]'); click('[data-priority-row="high"]')
  await act(async()=>{await vi.advanceTimersByTimeAsync(30001)}); vi.useRealTimers(); await release()
  console.log('R2-H',{banner:q('[data-issue-conflict]')?.textContent,toast:q('[data-toast="failed"]')?.textContent})
  expect(q('[data-issue-conflict]')).not.toBeNull()
  // 수정 3 시험 감사: 늦은 충돌은 서버를 바꾸지 않았다(다른 곳의 제목 보존 · 우선순위 그대로).
  expect(item.title).toBe('REMOTE CHANGE')
  expect(item.priority).toBe('medium')
 })
})

describe('r2 connection/read boundaries', () => {
 it('I initial detail read discarded on generation change must restart', async () => {
  const r=await rig(); const release=hold('getItem'); await openCard('CORE-2')
  await act(async()=>{await r.service.addConnection({sourceId:'mock-jira',token:'mock_l602_new_generation',replaceId:r.connectionId})})
  await settle(); await release()
  console.log('R2-I',{body:el('[data-issue-body]').textContent,edit:el('[data-issue-body-edit]').outerHTML,getItems:r.calls.filter(c=>c.op==='getItem')})
  expect(el('[data-issue-body-edit]')).toHaveProperty('disabled',false)
 })
 it('J older activity result cannot erase later accepted record', async () => {
  const r=await rig(); await openCard('CORE-2')
  const original=window.corral.workActivity; let release!:()=>void; const pending=new Promise<void>(resolve=>release=resolve); let n=0
  window.corral.workActivity=async query=>{ const result=await original(query); n++; if(n===1) await pending; return result }
  click('[data-field="priority"]');click('[data-priority-row="high"]');await settle()
  click('[data-field="priority"]');click('[data-priority-row="low"]');await settle()
  console.log('R2-J before',{records:r.activity.records.length,shown:[...document.querySelectorAll('[data-activity-origin="corral"]')].map(e=>e.textContent)})
  release();await settle()
  const shown=[...document.querySelectorAll('[data-activity-origin="corral"]')].map(e=>e.textContent)
  console.log('R2-J after',{records:r.activity.records.length,shown})
  expect(shown).toHaveLength(2)
  expect(r.activity.records).toHaveLength(2) // 수정 3 시험 감사: 저장소에도 두 줄
 })
})

// 경로 전수 표(detail-async-rules.md)에서 리뷰가 재현하지 않은 같은 모양 — 표의 규칙대로 하나씩.
describe('표 경로 — 같은 규칙의 다른 시작점', () => {
  const late = async (op: WorkCall['op'], act0: () => void): Promise<() => Promise<void>> => {
    const release = hold(op)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    act0()
    await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
    vi.useRealTimers()
    return release
  }
  it('T-body-late-ok: 본문 저장이 30초 뒤 성공 — 보낸 그대로면 편집기가 닫힌다', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'LATE OK BODY')
    const release = await late('updateItem', () => click('[data-md-save]'))
    expect(q('[data-md-editor]')).not.toBeNull()
    await release()
    expect(q('[data-md-editor]')).toBeNull()
    expect(r.state.items.find((entry) => entry.id === 'm-2')?.body).toBe('LATE OK BODY')
  })
  it('T-body-late-typed: 30초 뒤 성공했지만 그 사이 더 고친 본문은 남는다', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-issue-body-edit]'); setValue(input('[data-md-editor] textarea'), 'SENT')
    const release = await late('updateItem', () => click('[data-md-save]'))
    setValue(input('[data-md-editor] textarea'), 'SENT + MORE')
    await release()
    expect(input('[data-md-editor] textarea').value).toBe('SENT + MORE')
    expect(el('[data-md-editor]').textContent).toContain('그 뒤 고친 내용은 아직 저장하지 않았습니다')
    expect(r.state.items.find((entry) => entry.id === 'm-2')?.body).toBe('SENT') // 수정 3 시험 감사: 서버에는 보낸 값
  })
  it('T-link-late: 연결 추가가 30초 뒤 성공 — 연결 행이 생기고 키 칸이 비고 닫힌다', async () => {
    const r = await rig(); await openCard('CORE-2')
    click('[data-link-add]'); setValue(input('[data-link-key]'), 'CORE-3')
    const release = await late('addRelation', () => click('[data-link-submit]'))
    await settle(16)
    await release()
    expect(r.state.links.some((link) => (link.from === 'm-2' && link.to === 'm-3') || (link.from === 'm-3' && link.to === 'm-2'))).toBe(true)
    expect(q('[data-link-row="CORE-3"]')).not.toBeNull()
    expect(q('[data-link-form]')).toBeNull()
  })
  it('T-title-typing: 제목 저장 중 다시 고친 제목은 앞 저장 성공이 덮지 않는다', async () => {
    const r = await rig(); await openCard('CORE-2')
    const title = input('[data-issue-title]')
    const release = hold('updateItem')
    act(() => title.focus()); setValue(title, 'T1'); act(() => title.blur()); await settle()
    act(() => title.focus()); setValue(title, 'T2 TYPING')
    // 수정 5(기준 변경 — 직렬화): 앞 저장 확인 중에는 제목 입력이 잠긴다(readOnly + 입력 무시). 원 기대(T2 TYPING 이 남음)는 test-audit.md.
    const during = { readOnly: input('[data-issue-title]').readOnly, shown: input('[data-issue-title]').value }
    await release()
    expect(during).toEqual({ readOnly: true, shown: 'T1' })
    expect(input('[data-issue-title]').value).toBe('T1')
    expect(r.state.items.find((entry) => entry.id === 'm-2')?.title).toBe('T1')
  })
  it('T-comment-typing: 코멘트 보내는 중 더 쓴 초안은 성공이 지우지 않는다', async () => {
    const r = await rig(); await openCard('CORE-2')
    const release = hold('addComment')
    setValue(input('[data-comment-composer] textarea'), 'FIRST')
    key(input('[data-comment-composer] textarea'), { key: 'Enter', metaKey: true })
    setValue(input('[data-comment-composer] textarea'), 'SECOND DRAFT')
    await release()
    expect(input('[data-comment-composer] textarea').value).toBe('SECOND DRAFT')
    expect((r.state.comments['m-2'] ?? []).map((comment) => comment.body)).toEqual(['FIRST'])
    expect([...document.querySelectorAll('[data-activity-row="comment"]')].some((row) => row.textContent?.includes('FIRST'))).toBe(true)
  })
  it('T-child-typing: 자식 만드는 중 더 쓴 제목은 성공이 지우지 않는다', async () => {
    const r = await rig(); await openCard('CORE-1')
    const release = hold('createItem')
    click('[data-child-add]'); setValue(input('[data-child-title]'), 'CHILD ONE'); key(input('[data-child-title]'), { key: 'Enter' })
    setValue(input('[data-child-title]'), 'CHILD TWO DRAFT')
    await release()
    expect(input('[data-child-title]').value).toBe('CHILD TWO DRAFT')
    expect(r.state.items.filter((entry) => entry.parentId === 'm-1' && entry.title === 'CHILD ONE')).toHaveLength(1) // 수정 3 시험 감사: 서버에 자식 하나
    expect([...document.querySelectorAll('[data-child-row]')].some((row) => row.textContent?.includes('CHILD ONE'))).toBe(true)
  })
  it('T-comment-generation: 코멘트 보내는 중 세대가 바뀌면 보내는 중이 풀리고 초안은 남는다(앞 회차 결과는 입력을 바꾸지 않음)', async () => {
    const r = await rig(); await openCard('CORE-2')
    const release = hold('addComment')
    setValue(input('[data-comment-composer] textarea'), 'GEN DRAFT')
    key(input('[data-comment-composer] textarea'), { key: 'Enter', metaKey: true })
    await act(async () => { await r.service.addConnection({ sourceId: 'mock-jira', token: 'mock_l602_new_generation', replaceId: r.connectionId }) })
    await settle(); await release()
    expect(input('[data-comment-composer] textarea').value).toBe('GEN DRAFT')
    // 보내는 중이 풀렸다 — 같은 초안을 다시 보낼 수 있다(새 세대).
    key(input('[data-comment-composer] textarea'), { key: 'Enter', metaKey: true }); await settle(16)
    expect(r.calls.filter((call) => call.op === 'addComment')).toHaveLength(2)
  })
  it('T-stale-refresh-board: 보드 끌기 확인 중에 연 상세의 첫 읽기를 보류한 사이 끌기가 확정되면, 낡은 읽기가 상태를 되돌리지 않는다(수정 6: 재조회 중 끌기는 막혀 순서를 바꿨다)', async () => {
    const r = await rig()
    const orig = window.corral.workRequest
    let releaseWrite!: () => void; const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve })
    let releaseRead!: () => void; const readHeld = new Promise<void>((resolve) => { releaseRead = resolve })
    window.corral.workRequest = async (request: WorkRequest) => {
      if (request.call.op === 'changeStatus') await writeHeld
      // 읽기는 보내는 때의 서버 값(끌기 전)을 들고 보류된다 — 끌기 확정 뒤에 도착하는 낡은 응답.
      const result = await orig(request)
      if (request.call.op === 'getItem' && request.call.itemId === 'm-2') await readHeld
      return result
    }
    const zone = q('[data-drop-zone="col:st:core-doing"]'); const handle = q('[data-tasks-board] [data-issue-card="CORE-2"]')
    if (zone === null || handle === null) throw new Error('끌기 대상 없음')
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(zone)
    const mouse = (target: EventTarget, name: string, x = 10, y = 10): void => { act(() => { target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
    mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle()
    click('[data-tasks-board] [data-issue-card="CORE-2"]'); await settle()
    expect(q('[data-issue-detail="CORE-2"]')).not.toBeNull()
    releaseWrite(); await settle(16)
    expect(r.state.items.find((entry) => entry.id === 'm-2')?.statusKey).toBe('core-doing')
    releaseRead(); await settle(16)
    expect(el('[data-issue-status]').dataset.issueStatus).toBe('core-doing')
    expect(r.state.items.find((entry) => entry.id === 'm-2')?.statusKey).toBe('core-doing') // 수정 3 시험 감사: 해제 뒤 서버 값
  })
})
