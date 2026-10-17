// @vitest-environment happy-dom
// LIFE-622 C6 — LIFE-623 리뷰 r4 X4-2(R4-B) 재현을 제품 시험으로 옮긴다. 출발점: `specs/LIFE-623-null-body/raw/review/codex-r4-raw/probes/TaskDetail.x4board.test.tsx`.
// 상세를 연 채 외부가 본문을 비우고(null·'') 보드 끌기가 30초를 넘겨 성공 → 상세가 정본(빈 본문)을 받고, 새로 연 편집기 저장이 옛 본문을 되살리지 않는다.
// 실제 경로 React `TasksPage` → hook → `WorkService` → `LaSource` + `LaMcpFixture`(LIFE-622 부터 **충돌 검사 켜짐**). 즉시 성공 대조를 함께 둔다.
// 대조: 늦은 성공 전에 상세 쓰기가 이미 확정됐으면 늦은 옛 결과가 더 새 base(판)를 되감지 않는다 — 되감으면 다음 저장이 자기 판과 충돌한다.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사에서 빼고 mixed 검사(tsconfig.mixed.json)에 둔다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkResponse } from '../../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../../main/work/la-source.js'
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

/** 실제 `LaSource` + `LaMcpFixture`(LIFE-622 — 충돌 검사 켜짐). 응답도 모아 쓰기 결과의 본문이 정본 그대로 오는지 본다. */
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
/** 실제 끌기 경로 — 손잡이 mousedown → 문턱 넘는 move(놓을 영역은 elementFromPoint) → mouseup. */
async function dragTo({ card, zone }: { card: string; zone: string }): Promise<void> {
  const target = q(`[data-drop-zone="${zone}"]`); const handle = el(`[data-tasks-board] [data-issue-card="${card}"]`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  const mouse = (at: EventTarget, name: string, x = 10, y = 10): void => { act(() => { at.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
  mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle(16)
}


/** 렌더러의 30초 한도 타이머를 붙들어 손으로 터뜨린다 — 원래 응답은 계속 기다린다. */
function captureTimeout(): { fire: () => Promise<void>; caught: () => boolean } {
  let timeout: (() => void) | null = null
  const originalTimer = globalThis.setTimeout
  // 렌더러 30초 한도만 손에 쥐고 나머지 타이머는 그대로 둔다(타입 단언 없이 — 인자를 그대로 넘긴다).
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, ms, ...args) => {
    if (ms === 30000 && typeof handler === 'function') { timeout = () => handler(); return originalTimer(() => {}, 120000) }
    return originalTimer(handler, ms, ...args)
  })
  return { caught: () => timeout !== null, fire: async () => { await act(async () => { timeout?.() }); await settle(15) } }
}
/** 그 연산은 출처에서 끝낸 뒤(정본 결과) 배달만 붙든다. */
function holdDelivery(op: WorkCall['op']): { release: () => Promise<void>; captured: () => boolean } {
  const request = window.corral.workRequest
  let captured = false
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  window.corral.workRequest = async (req: WorkRequest) => {
    const out = await request(req)
    if (req.call.op === op) { captured = true; await pending }
    return out
  }
  return { captured: () => captured, release: async () => { await act(async () => { release() }); await settle(35) } }
}

it.each([false, true].flatMap((late) => [null, ''].map((empty) => ({ late, empty }))))('보드 끌기 성공(늦음=$late) 뒤 외부 비우기($empty)를 상세가 받는다 — 새 편집기 저장이 옛 본문을 되살리지 않는다', async ({ late, empty }) => {
  const la = await laRig()
  const issue = la.fixture.issues.find((entry) => entry.id === FIXTURE_IDS.task600)
  if (issue === undefined) throw new Error('fixture')
  issue.description = 'OLD BOARD BODY'
  await openCard(`LIFE-${issue.sequentialId}`)
  await settle(20)
  issue.description = empty
  const timer = captureTimeout()
  const held = holdDelivery('changeStatus')
  await dragTo({ card: `LIFE-${issue.sequentialId}`, zone: `col:st:${FIXTURE_STATUS.analysis}` })
  expect(held.captured()).toBe(true)
  if (late) { expect(timer.caught()).toBe(true); await timer.fire() }
  await held.release()
  const written = la.responses.findLast((response) => response.ok && response.result.op === 'changeStatus')
  expect(written?.ok === true && written.result.op === 'changeStatus' ? written.result.item.body : 'missing').toBe(empty)
  expect(issue.statusId).toBe(FIXTURE_STATUS.analysis)
  click('[data-issue-body-edit]')
  const editor = input('[data-md-editor] textarea').value
  click('[data-md-save]')
  await settle(30)
  expect(editor).toBe('')
  expect(issue.description ?? '').toBe('')
  // 충돌 검사 켜짐 — 판이 맞게 미끄러졌으면 배너 없이 저장된다.
  expect(q('[data-issue-conflict]')).toBeNull()
})

// LIFE-632 C5 — 기대 변경. 원래 「대조」 는 늦은 보드 쓰기 뒤 상세 우선순위 쓰기 = 자기 충돌 배너 → 「내 값으로 덮기」 로 상세를 먼저 확정한 뒤, 늦은 옛 보드 결과가
// base(판)를 되감지 않는지 봤다. 이제 충돌 검사 켜짐에서는 같은 카드에 답이 안 온 쓰기가 있으면 상세 쓰기는 기다린다 — 그 배너(622 인계 ②)가 없어지고,
// 「늦은 보드 결과보다 먼저 확정되는 상세 쓰기」 장면도 켜짐에서는 생기지 않는다. 늦은 옛 결과의 순서 가드는 B = 보드 쓰기로 `TaskDetail.r7on.test.tsx`,
// 꺼짐 연결로 `TaskDetail.r7.test.tsx` 가 계속 본다. 여기서는 기다림 → 풀림 → 상세 쓰기·다음 저장이 자기 판과 충돌하지 않음을 본다.
it('대조 — 늦은 보드 쓰기의 답 전에는 같은 카드 상세 쓰기가 기다린다(배너 없음), 답 뒤 상세 쓰기·다음 저장은 자기 판과 충돌하지 않는다', async () => {
  const la = await laRig()
  const issue = la.fixture.issues.find((entry) => entry.id === FIXTURE_IDS.task600)
  if (issue === undefined) throw new Error('fixture')
  await openCard(`LIFE-${issue.sequentialId}`)
  await settle(20)
  const timer = captureTimeout()
  const held = holdDelivery('changeStatus')
  await dragTo({ card: `LIFE-${issue.sequentialId}`, zone: `col:st:${FIXTURE_STATUS.analysis}` })
  expect(held.captured()).toBe(true)
  await timer.fire()
  vi.restoreAllMocks()
  // 늦음으로 보드 잠금은 풀렸지만 답이 안 왔다 — 상세 쓰기 칸은 막힌다(배너가 아니다). 서버에는 보드 쓰기가 이미 적용돼 판이 올랐다.
  const priority = el('[data-field="priority"]')
  expect(priority instanceof HTMLButtonElement && priority.disabled).toBe(true)
  expect(q('[data-issue-conflict]')).toBeNull()
  expect(la.calls.filter((call) => call.op === 'updateItem')).toHaveLength(0)
  await held.release()
  click('[data-field="priority"]')
  click('[data-priority-row="lowest"]')
  await settle(30)
  expect(q('[data-issue-conflict]')).toBeNull()
  expect(issue.priority).toBe('lowest')
  expect(issue.statusId).toBe(FIXTURE_STATUS.analysis)
  click('[data-issue-body-edit]')
  setValue(input('[data-md-editor] textarea'), '새 본문')
  click('[data-md-save]')
  await settle(30)
  expect(q('[data-issue-conflict]')).toBeNull()
  expect(issue.description).toBe('새 본문')
  expect(issue.priority).toBe('lowest')
})
