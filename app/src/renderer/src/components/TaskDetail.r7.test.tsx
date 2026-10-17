// @vitest-environment happy-dom
// LIFE-623 — Codex 리뷰 r7 R7-A 재현(`specs/LIFE-602-task-detail/raw/review/codex-r7-raw/probes/null-reorder.test.tsx` V22 · `async-extra.test.tsx` V08 ·
// `null-la.test.tsx` V11 · `electron-null.mts` V17)을 제품 시험으로 옮긴다. 외부에서 본문을 null 로 비운 뒤 보드 쓰기 결과가 오면 상세가 옛 본문을 보충하지 않는다.
// 각 시나리오에 빈 글 `''` 대조(기존 보호)를 함께 둔다. 실제 경로 React `TasksPage` → hook → `WorkService` → 출처(모의 · 실제 `LaSource` + `LaMcpFixture`).
// 렌더러와 main 을 함께 import 하므로 web 타입 검사에서 빼고 mixed 검사(tsconfig.mixed.json)에 둔다. LA 는 네트워크 없이 가짜 fetch 가 fixture 도구 처리기를 부른다(TasksPage.r4la 와 같은 방식).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { FIXTURE_IDS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../../main/work/la-source.js'
import { mockSourceEntry, seedMockDemoState, type MockState } from '../../../main/work/mock-source.js'
import type { WorkSourceEntry } from '../../../main/work/source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FAKE_LA_TOKEN, FakeCipher, MemoryStore, workHarness } from '../../../main/work/test-kit.js'
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

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function renderPage(): void {
  act(() => root.render(createElement('div', null, createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
}

type Rig = { state: MockState; calls: WorkCall[]; responses: WorkResponse[] }

/** 모의 출처(충돌 검사 켜짐) — 외부 편집은 서버 fixture 에 직접 가한다. */
async function rig({ entry }: { entry?: (state: MockState) => WorkSourceEntry } = {}): Promise<Rig> {
  const state = seedMockDemoState()
  let seq = 0
  let listener: (value: WorkSettingsState) => void = () => {}
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([entry === undefined ? mockSourceEntry({ state }) : entry(state)]), activity: new MemoryActivity(),
    repos: () => [], onChange: (value) => listener(value), now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token: 'mock_l623_fixture', replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const result: Rig = { state, calls: [], responses: [] }
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: async (request: WorkRequest) => { result.calls.push(request.call); const response = await service.request(request); result.responses.push(response); return response },
    workActivity: async (query: unknown) => service.activity(query),
  })
  renderPage()
  await settle()
  return result
}

/** 실제 `LaSource` + `LaMcpFixture`(충돌 검사 꺼짐). 응답도 모아 쓰기 결과의 본문이 정본 그대로 오는지 본다(V17 상당). */
async function laRig(): Promise<{ fixture: LaMcpFixture; calls: WorkCall[]; responses: WorkResponse[] }> {
  const fixture = new LaMcpFixture()
  const fetchImpl = async (_url: unknown, options?: RequestInit): Promise<Response> => {
    const body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } = JSON.parse(String(options?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const reply: { isError: boolean; text: string } | null = body.method === 'initialize' ? null : Reflect.get(fixture, 'tool').call(fixture, { tool: body.params?.name, args: body.params?.arguments ?? {} })
    const result = reply === null ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  const harness = workHarness({ entries: [laSourceEntry({ url: 'http://127.0.0.1:9/not-networked', clientVersion: 'test', fetchImpl })] })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('LA 모의 연결 실패')
  const calls: WorkCall[] = []
  const responses: WorkResponse[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => harness.service.settings(), onWorkSettings: () => () => {},
    workRequest: async (request: WorkRequest) => { calls.push(request.call); const response = await harness.service.request(request); responses.push(response); return response },
    workActivity: async (query: unknown) => harness.service.activity(query),
  })
  renderPage()
  await settle(30)
  return { fixture, calls, responses }
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
async function openCard(itemKey: string): Promise<void> {
  click(`[data-tasks-board] [data-issue-card="${itemKey}"]`)
  await settle()
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
}
function serverItem(r: Rig, id: string): MockState['items'][number] {
  const found = r.state.items.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`서버에 없음: ${id}`)
  return found
}
/** 그 연산을 풀 때까지 붙든다(렌더러 → main 요청 자리). */
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
const conflictFieldsShown = (): string[] => [...document.querySelectorAll('[data-conflict-field]')].map((entry) => entry.getAttribute('data-conflict-field') ?? '')

/** 실제 끌기 경로 — 손잡이 mousedown → 문턱 넘는 move(놓을 영역은 elementFromPoint) → mouseup. */
async function dragTo({ card, zone }: { card: string; zone: string }): Promise<void> {
  const target = q(`[data-drop-zone="${zone}"]`); const handle = el(`[data-tasks-board] [data-issue-card="${card}"]`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  const mouse = (at: EventTarget, name: string, x = 10, y = 10): void => { act(() => { at.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
  mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle(16)
}

// ① V22 — 충돌 검사 켜짐: 본문 초안을 연 채 외부가 본문을 비우고 판을 올림 → 같은 열 재정렬 → 일반 저장 = 저장 안 됨 + 본문 충돌 배너.
it.each([null, ''])('V22 열린 본문 초안 + 외부 비우기 %j → 같은 열 재정렬 → 일반 저장은 배너, 서버 빈 본문 유지', async (empty) => {
  const r = await rig()
  const server = serverItem(r, 'm-2')
  server.body = 'OLD'
  await openCard('CORE-2')
  click('[data-issue-body-edit]')
  setValue(input('[data-md-editor] textarea'), 'MY DRAFT')
  server.body = empty
  server.version += 1
  const before = r.calls.length
  await dragTo({ card: 'CORE-2', zone: 'col:st:core-todo' })
  expect(r.calls.slice(before).filter((call) => call.op === 'reorder')).toHaveLength(1)
  click('[data-md-save]')
  await settle(16)
  expect(server.body).toBe(empty)
  expect(conflictFieldsShown()).toContain('body')
  // 초안은 버리지 않는다.
  expect(input('[data-md-editor] textarea').value).toBe('MY DRAFT')
})

// ② V08 — 외부 비우기 → 보드 상태 변경 → 본문 편집기를 새로 열어 저장해도 옛 본문이 화면·편집기·서버 어디에도 되살아나지 않는다.
it.each([null, ''])('V08 외부 비우기 %j → 보드 상태 변경 → 새로 연 편집기·저장에 옛 본문이 없다', async (empty) => {
  const r = await rig()
  const server = serverItem(r, 'm-2')
  server.body = 'OLD NONEMPTY'
  await openCard('CORE-2')
  expect(el('[data-issue-body]').textContent).toContain('OLD NONEMPTY')
  server.body = empty
  server.version += 1
  await dragTo({ card: 'CORE-2', zone: 'col:st:core-doing' })
  expect(server.statusKey).toBe('core-doing')
  expect(el('[data-issue-body]').textContent).not.toContain('OLD NONEMPTY')
  click('[data-issue-body-edit]')
  expect(input('[data-md-editor] textarea').value).toBe('')
  click('[data-md-save]')
  await settle(16)
  expect(server.body ?? '').toBe('')
  expect(document.body.textContent).not.toContain('OLD NONEMPTY')
})

// ③ V11 · ④ V17 상당 — 실제 LaSource + LaMcpFixture(`description:null`) → 우선순위 변경. 쓰기 결과 본문이 정본(null) 그대로 상세까지 오고,
// 상세는 빈 본문을 보이며 옛 본문을 저장으로 되살리지 않는다. LA 는 충돌 검사가 꺼져 있다 — 배너 0(T3 C8 그대로).
it.each([null, ''])('V11·V17 LA 외부 description %j → 우선순위 변경 → 쓰기 결과 본문 = 정본, 상세 빈 본문, 저장이 옛 본문을 되살리지 않는다', async (empty) => {
  const la = await laRig()
  const issue = la.fixture.issues.find((entry) => entry.id === FIXTURE_IDS.task600)
  if (issue === undefined) throw new Error('fixture')
  issue.description = 'OLD LA BODY'
  await openCard(`LIFE-${issue.sequentialId}`)
  await settle(25)
  expect(el('[data-issue-body]').textContent).toContain('OLD LA BODY')
  issue.description = empty
  issue.updatedAt = '2026-10-14T14:05:00Z'
  const before = la.responses.length
  click('[data-field="priority"]')
  click('[data-priority-row="highest"]')
  await settle(35)
  // ④ 쓰기 결과(updateItem)의 본문이 정본 그대로 — null 이면 null. 출처(LaSource)의 사실 확인이지 보충 제거의 판별 단언이 아니다 —
  // 수정 전(e01)에도 통과했다. 판별은 아래 화면·편집기 단언(옛 식이면 'OLD LA BODY' 가 남는다)이다(R1-E).
  const written = la.responses.slice(before).find((response) => response.ok && response.result.op === 'updateItem')
  expect(written?.ok === true && written.result.op === 'updateItem' ? written.result.item.body : 'none').toBe(empty)
  expect(issue.priority).toBe('highest')
  expect(el('[data-issue-body]').textContent).not.toContain('OLD LA BODY')
  click('[data-issue-body-edit]')
  expect(input('[data-md-editor] textarea').value).toBe('')
  click('[data-md-save]')
  await settle(30)
  expect(issue.description ?? '').toBe('')
  expect(q('[data-issue-conflict]')).toBeNull()
})

// R1-D — 늦은 성공(`useTasksPage.ts` 늦은 결과 → `setSettledWrite`) 길: 상세 우선순위 쓰기가 30초 넘게 붙들린 사이 외부가 본문을 비움 →
// 늦게 성공한 결과(본문 = 정본 null)가 상세로 온다 → 그 뒤 화면·연 편집기·저장에 옛 본문이 없다. `''` 대조 함께.
// LA(충돌 검사 꺼짐)로 돈다 — 모의(켜짐)는 외부 판 올림 뒤 쓰기가 충돌로 거절돼 성공 결과가 오지 않는다.
it.each([null, ''])('R1-D 늦은 성공 — 외부 description %j 뒤 30초 넘어 성공한 우선순위 결과가 옛 본문을 되살리지 않는다', async (empty) => {
  const la = await laRig()
  const issue = la.fixture.issues.find((entry) => entry.id === FIXTURE_IDS.task600)
  if (issue === undefined) throw new Error('fixture')
  issue.description = 'OLD LATE BODY'
  await openCard(`LIFE-${issue.sequentialId}`)
  await settle(25)
  expect(el('[data-issue-body]').textContent).toContain('OLD LATE BODY')
  const release = hold('updateItem')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]')
  click('[data-priority-row="highest"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers()
  issue.description = empty
  issue.updatedAt = '2026-10-14T14:05:00Z'
  const before = la.responses.length
  await release()
  await settle(35)
  // 늦게 온 성공 결과 = 정본(본문 null 이면 null).
  const written = la.responses.slice(before).find((response) => response.ok && response.result.op === 'updateItem')
  expect(written?.ok === true && written.result.op === 'updateItem' ? written.result.item.body : 'none').toBe(empty)
  expect(issue.priority).toBe('highest')
  expect(el('[data-issue-body]').textContent).not.toContain('OLD LATE BODY')
  click('[data-issue-body-edit]')
  expect(input('[data-md-editor] textarea').value).toBe('')
  click('[data-md-save]')
  await settle(30)
  expect(issue.description ?? '').toBe('')
  expect(document.body.textContent).not.toContain('OLD LATE BODY')
})

/** 목록 모양 결과를 돌려주는 출처 사본(R1-A·R1-E 양성 대조) — 보드 쓰기(`changeStatus`·`reorder`) 결과의 본문·연결을 「안 실음」 null 로 바꾼다. 서버 값은 바뀐다(쓰기는 적용). */
function listShaped(state: MockState): WorkSourceEntry {
  const base = mockSourceEntry({ state })
  return {
    ...base,
    create: (credentials) => {
      const inner = base.create(credentials)
      return {
        capabilities: () => inner.capabilities(),
        close: () => inner.close(),
        call: async (call, meta) => {
          const outcome = await inner.call(call, meta)
          if (!outcome.ok || (outcome.result.op !== 'changeStatus' && outcome.result.op !== 'reorder')) return outcome
          return { ok: true, result: { ...outcome.result, item: { ...outcome.result.item, body: null, relations: null } } }
        },
      }
    },
  }
}

// R1-A — 출처가 쓰기 결과를 목록 모양으로 주면 main 이 `invalid_response` + 「적용됐을 수 있음」 으로 거른다. 상세 base·편집 기준은 그 null 로 바뀌지 않는다:
// 화면 본문·새로 연 편집기 = 서버 본문 그대로. R1-E — 「relations === null 일 때만 옛 값 보충」 같은 화면 쪽 분기는 이 거절 때문에 도달하지 않는다
// (목록 모양 결과는 `settledWrite` 로 오지 않는다 — 아래 `responses` 단언). 그 변이를 넣은 사본의 실행은 executions.md 참고.
it('R1-A 목록 모양 쓰기 결과는 main 이 거른다 — maybeApplied, 상세 본문·편집기 = 서버 본문', async () => {
  const r = await rig({ entry: listShaped })
  const server = serverItem(r, 'm-2')
  server.body = 'LIVE SERVER BODY'
  await openCard('CORE-2')
  const before = r.responses.length
  await dragTo({ card: 'CORE-2', zone: 'col:st:core-doing' })
  const moved = r.responses.slice(before).find((response) => !response.ok && response.error.kind === 'invalid_response')
  expect(moved?.ok === false ? { kind: moved.error.kind, maybeApplied: moved.error.maybeApplied } : null).toEqual({ kind: 'invalid_response', maybeApplied: true })
  expect(r.responses.slice(before).some((response) => response.ok && 'item' in response.result && response.result.item !== null && response.result.item.relations === null)).toBe(false)
  // 쓰기는 출처에 적용됐다(그래서 「적용됐을 수 있음」).
  expect(server.statusKey).toBe('core-doing')
  await settle(16)
  expect(el('[data-issue-body]').textContent).toContain('LIVE SERVER BODY')
  click('[data-issue-body-edit]')
  expect(input('[data-md-editor] textarea').value).toBe('LIVE SERVER BODY')
  expect(server.body).toBe('LIVE SERVER BODY')
})
