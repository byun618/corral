// @vitest-environment happy-dom
// LIFE-622 수정 1 R1-E — **켜진 LA**(조건부 수정, fixture `checksVersion = true`)에서 LIFE-623 확정 순서 가드를 본다. `TaskDetail.r7.test.tsx` 의 LA 시험은 판과 무관한
// 순서 가드를 격리하려고 조건부 이전 서버 모양(`checksVersion = false`)으로 돌므로 켜짐 검증이 아니다. 여기서는 판을 싣지 않는 **보드 쓰기 B** 가 늦은 상세 쓰기 A 를
// 앞질러 성공(역전)하고 늦은 A 결과 뒤 단건 재조회가 실패·지연하는 길을 켜진 LA 로 본다. 출발점: 리뷰 r1 임시 시험
// `specs/LIFE-622-reconcile-conflict/raw/review/codex-r1-raw/TaskDetail.codex-enabled.test.tsx`(이식).
// 실제 경로 React `TasksPage` → hook → `WorkService` → `LaSource` + `LaMcpFixture`(가짜 fetch). 렌더러와 main 을 함께 import 하므로 mixed 검사에 둔다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../../main/work/la-source.js'
import { WorkService } from '../../../main/work/service.js'
import { FAKE_LA_TOKEN, workHarness } from '../../../main/work/test-kit.js'
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



/** 실제 `LaSource` + `LaMcpFixture`(충돌 검사 꺼짐). 응답도 모아 쓰기 결과의 본문이 정본 그대로 오는지 본다(V17 상당). */
async function laRig(): Promise<{ fixture: LaMcpFixture; calls: WorkCall[]; responses: WorkResponse[]; service: WorkService; connectionId: string; emitSettings: () => void }> {
  const fixture = new LaMcpFixture()
  // LIFE-622 — LA 충돌 검사가 켜졌다. 이 파일의 시험은 판과 무관한 **확정 순서 가드**(623 `sent`·미확인 막힘)를 본다 — 켜진 LA 에서는 같은 장면의 B 가
  // 앞 쓰기 A 가 소비한 판 때문에 충돌 배너로 끝나 B 성공 역전 자체가 생기지 않는다(F8 — specs/LIFE-622-reconcile-conflict/raw/claude/design-notes.md §5).
  // 그래서 서버는 조건부 수정 이전 모양(판을 견주지 않음)으로 둔다. 켜진 LA 계약은 la-conflict.test.ts · 계약 묶음 · TaskDetail.board-late 가 본다.
  const fetchImpl = async (_url: unknown, options?: RequestInit): Promise<Response> => {
    const body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } = JSON.parse(String(options?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const reply: { isError: boolean; text: string } | null = body.method === 'initialize' ? null : Reflect.get(fixture, 'tool').call(fixture, { tool: body.params?.name, args: body.params?.arguments ?? {} })
    const result = reply === null ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  // 설정 변경(연결 세대 교체)은 `emitSettings` 로 화면 listener 에 직접 넘긴다 — 하네스 서비스의 onChange 는 기록만 한다.
  let listener: (value: WorkSettingsState) => void = () => {}
  const harness = workHarness({ entries: [laSourceEntry({ url: 'http://127.0.0.1:9/not-networked', clientVersion: 'test', fetchImpl })] })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('LA 모의 연결 실패')
  const calls: WorkCall[] = []
  const responses: WorkResponse[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => harness.service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: async (request: WorkRequest) => { calls.push(request.call); const response = await harness.service.request(request); responses.push(response); return response },
    workActivity: async (query: unknown) => harness.service.activity(query),
  })
  renderPage()
  await settle(30)
  return { fixture, calls, responses, service: harness.service, connectionId: added.connection.id, emitSettings: () => listener(harness.service.settings()) }
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
async function openCard(itemKey: string): Promise<void> {
  click(`[data-tasks-board] [data-issue-card="${itemKey}"]`)
  await settle()
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
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

/** 실제 끌기 경로 — 손잡이 mousedown → 문턱 넘는 move(놓을 영역은 elementFromPoint) → mouseup. */
async function dragTo({ card, zone }: { card: string; zone: string }): Promise<void> {
  const target = q(`[data-drop-zone="${zone}"]`); const handle = el(`[data-tasks-board] [data-issue-card="${card}"]`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  const mouse = (at: EventTarget, name: string, x = 10, y = 10): void => { act(() => { at.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
  mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle(16)
}

// ① V22 — 충돌 검사 켜짐: 본문 초안을 연 채 외부가 본문을 비우고 판을 올림 → 같은 열 재정렬 → 일반 저장 = 저장 안 됨 + 본문 충돌 배너.
async function captureLateA(): Promise<() => void> {
  const original = window.corral.workRequest
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  let captured = false
  window.corral.workRequest = async (request: WorkRequest) => {
    const response = await original(request)
    if (request.call.op === 'updateItem' && !captured) { captured = true; await pending }
    return response
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]')
  click('[data-priority-row="highest"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers()
  expect(captured).toBe(true)
  return release
}
type LaTool = (value: { tool: string; args: Record<string, unknown> }) => { isError: boolean; text: string }
function wrapTool(fixture: LaMcpFixture, wrap: (inner: LaTool) => LaTool): () => void {
  const inner: LaTool = Reflect.get(fixture, 'tool').bind(fixture)
  Reflect.set(fixture, 'tool', wrap(inner))
  return () => { Reflect.set(fixture, 'tool', inner) }
}
const refused = (message: string): { isError: boolean; text: string } => ({ isError: true, text: JSON.stringify({ code: 'BAD_REQUEST', message }) })
const bodyEditDisabled = (): boolean => { const button = el('[data-issue-body-edit]'); return button instanceof HTMLButtonElement && button.disabled }

it('R3-A B 성공 역전 + 재조회 실패 — 상세 미확인(쓰기 막힘·다시 시도), 다시 받으면 풀리고 빈 본문', async () => {
  const la = await laRig()
  const issue = la.fixture.issues.find((entry) => entry.id === FIXTURE_IDS.task600)
  if (issue === undefined) throw new Error('fixture')
  issue.description = 'OLD CAPTURED BODY'
  await openCard(`LIFE-${issue.sequentialId}`)
  await settle(20)
  const release = await captureLateA()
  issue.description = null; issue.version += 1
  await dragTo({ card: `LIFE-${issue.sequentialId}`, zone: `col:st:${FIXTURE_STATUS.analysis}` })
  await settle(30)
  expect(issue.priority).toBe('highest')
  let failReads = true
  const restore = wrapTool(la.fixture, (inner) => (value) => (failReads && value.tool === 'issue_get' && value.args.id === issue.id ? refused('fixture reread refused') : inner(value)))
  await act(async () => { release() })
  await settle(35)
  // 미확인 — 옛 본문을 정본처럼 보이지 않고, 본문·필드 쓰기를 막는다.
  expect(bodyEditDisabled()).toBe(true)
  const priorityButton = el('[data-field="priority"]')
  expect(priorityButton instanceof HTMLButtonElement && priorityButton.disabled).toBe(true)
  expect(q('[data-issue-load-error]')).not.toBeNull()
  // 다시 시도 — 이번엔 받는다.
  failReads = false
  restore()
  click('[data-issue-retry]')
  await settle(35)
  expect(bodyEditDisabled()).toBe(false)
  expect(q('[data-issue-load-error]')).toBeNull()
  click('[data-issue-body-edit]')
  expect(input('[data-md-editor] textarea').value).toBe('')
  click('[data-md-save]')
  await settle(30)
  expect(issue.description ?? '').toBe('')
  expect(issue.priority).toBe('highest')
})

// B 성공 역전 + 재조회 지연 — 재조회가 끝날 때까지 상세 쓰기는 막혀 있고, 끝나면 정본(빈 본문)으로 풀린다.
it('R3-A B 성공 역전 + 재조회 지연 — 받는 동안 막힘, 받은 뒤 빈 본문', async () => {
  const la = await laRig()
  const issue = la.fixture.issues.find((entry) => entry.id === FIXTURE_IDS.task600)
  if (issue === undefined) throw new Error('fixture')
  issue.description = 'OLD CAPTURED BODY'
  await openCard(`LIFE-${issue.sequentialId}`)
  await settle(20)
  const releaseA = await captureLateA()
  issue.description = null; issue.version += 1
  await dragTo({ card: `LIFE-${issue.sequentialId}`, zone: `col:st:${FIXTURE_STATUS.analysis}` })
  await settle(30)
  const releaseRead = hold('getItem')
  await act(async () => { releaseA() })
  await settle(20)
  expect(bodyEditDisabled()).toBe(true)
  await releaseRead()
  await settle(30)
  expect(bodyEditDisabled()).toBe(false)
  click('[data-issue-body-edit]')
  expect(input('[data-md-editor] textarea').value).toBe('')
})

