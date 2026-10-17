// @vitest-environment happy-dom
// LIFE-632 — **켜진 LA**(조건부 수정, fixture `checksVersion = true`)에서 상세 판 선택 규칙을 본다.
// C2 ④ — 쓰기가 닿은 뒤 정본 읽기가 실패하면(R5-B) 상세는 미확인 → 재조회 → 정본(외부 비우기)을 받고, 새 편집기 저장이 옛 본문을 되살리지 않는다.
//   출발점: LIFE-623 리뷰 r5 `codex-r5-raw/probes/TaskDetail.x5la.test.tsx`(LA 꺼짐 시절 작성 — 켜짐 fixture 로 옮기고, 원 장면(꺼짐)도 대조로 둔다).
// C5 — 자기 충돌 배너(LIFE-622 인계). 내 변경뿐이면 배너 없이 저장 · 외부 변경이 끼면 지금처럼 배너(양성 대조 ⓐⓑⓒ).
//   출발점: `TaskDetail.board-late.test.tsx` 장면 · LIFE-622 리뷰 r2 `codex-r2-raw/detail-self.log`(late=true).
// 실제 경로 React `TasksPage` → hook → `WorkService` → `LaSource` + `LaMcpFixture`(가짜 fetch · 가짜 토큰). 렌더러와 main 을 함께 import 하므로 mixed 검사에 둔다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function renderPage(): void {
  act(() => root.render(createElement('div', null, createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
}

/** 실제 `LaSource` + `LaMcpFixture`(기본 = 충돌 검사 켜짐). `checks` false = 조건부 수정 이전 서버(원 재현 대조). */
async function laRig({ checks = true }: { checks?: boolean } = {}): Promise<{ fixture: LaMcpFixture; calls: WorkCall[]; responses: WorkResponse[] }> {
  const fixture = new LaMcpFixture()
  fixture.checksVersion = checks
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
  const spy = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  const mouse = (at: EventTarget, name: string, x = 10, y = 10): void => { act(() => { at.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }
  mouse(handle, 'mousedown'); mouse(document, 'mousemove', 50, 500); await settle(); mouse(document, 'mousemove', 52, 502); mouse(document, 'mouseup', 52, 502); await settle(16)
  spy.mockRestore()
}
/** A(우선순위 highest)를 실제로 실행해 성공 응답을 만든 뒤 배달만 붙든다 — 30초 지나 늦음(잠금 풀림). 푸는 함수를 돌려준다. */
async function captureLateA(): Promise<() => Promise<void>> {
  const original = window.corral.workRequest
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  let captured = false
  window.corral.workRequest = async (request: WorkRequest) => {
    const response = await original(request)
    if (request.call.op === 'updateItem' && request.call.fields.priority === 'highest' && !captured) { captured = true; await pending }
    return response
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  click('[data-field="priority"]')
  click('[data-priority-row="highest"]')
  await act(async () => { await vi.advanceTimersByTimeAsync(30001) })
  vi.useRealTimers()
  await settle(20)
  expect(captured).toBe(true)
  return async () => { await act(async () => { release() }); await settle(30) }
}
const bodyEditDisabled = (): boolean => { const button = el('[data-issue-body-edit]'); return button instanceof HTMLButtonElement && button.disabled }
const banner = (): Element | null => q('[data-issue-conflict]')
function task600(fixture: LaMcpFixture) {
  const issue = fixture.issues.find((entry) => entry.id === FIXTURE_IDS.task600)
  if (issue === undefined) throw new Error('fixture')
  return issue
}

describe('LIFE-632 C2 ④ LA 쓰기 뒤 정본 읽기 실패 — 미확인 → 재조회 → 빈 본문, 저장이 옛 본문을 되살리지 않는다', () => {
  // on-detail = 켜짐 · 상세 우선순위 쓰기(판 실음) / on-board = 켜짐 · 보드 끌기(판 없음, Q7) / off-detail = 원 재현(조건부 수정 이전 서버).
  const scenes = (['on-detail', 'on-board', 'off-detail'] as const).flatMap((scene) => (['partial', 'malformed'] as const).map((mode) => ({ scene, mode })))
  it.each(scenes)('$scene · 정본 읽기 $mode', async ({ scene, mode }) => {
    const la = await laRig({ checks: scene !== 'off-detail' })
    const issue = task600(la.fixture)
    issue.description = 'OLD LA BODY'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    // 외부 비우기(판은 그대로 — 이 장면은 판이 아니라 「쓰기 뒤 정본」 을 본다. 판을 올리면 켜짐에서는 쓰기가 충돌로 끝난다).
    issue.description = null
    la.fixture.afterWrite = { mode, times: 1 }
    const before = la.calls.length
    if (scene === 'on-board') await dragTo({ card: `LIFE-${issue.sequentialId}`, zone: `col:st:${FIXTURE_STATUS.analysis}` })
    else { click('[data-field="priority"]'); click('[data-priority-row="highest"]') }
    await settle(30)
    const written = la.responses.find((response, index) => index >= before && (response.ok ? response.result.op !== 'getItem' && response.result.op !== 'listItems' && response.result.op !== 'listStatuses' : true))
    expect(written !== undefined && !written.ok && written.error.maybeApplied === true).toBe(true)
    // 미확인 → 단건 재조회 1회(정본).
    expect(la.calls.slice(before).filter((call) => call.op === 'getItem')).toHaveLength(1)
    expect(bodyEditDisabled()).toBe(false)
    click('[data-issue-body-edit]')
    expect(input('[data-md-editor] textarea').value).toBe('')
    click('[data-md-save]')
    await settle(30)
    expect(issue.description ?? '').toBe('')
    expect(banner()).toBeNull()
  })
})

describe('LIFE-632 C5 ① 본문 편집기를 연 채 같은 카드 보드 끌기(즉시) → 본문 저장', () => {
  it.each(['mine', 'external-body', 'external-priority'] as const)('%s', async (scene) => {
    const la = await laRig()
    const issue = task600(la.fixture)
    issue.description = 'BEFORE'
    issue.priority = 'medium'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), '내 글')
    // 양성 대조 ⓐ 외부가 본문을 바꿈 · ⓑ 외부가 보드가 안 건드린 칸(우선순위)을 바꿈 — 판도 오른다.
    if (scene === 'external-body') { issue.description = 'EXTERNAL'; issue.version += 1 }
    if (scene === 'external-priority') { issue.priority = 'lowest'; issue.version += 1 }
    await dragTo({ card: `LIFE-${issue.sequentialId}`, zone: `col:st:${FIXTURE_STATUS.analysis}` })
    await settle(20)
    expect(issue.statusId).toBe(FIXTURE_STATUS.analysis)
    click('[data-md-save]')
    await settle(30)
    if (scene === 'mine') {
      expect(banner()).toBeNull()
      expect(issue.description).toBe('내 글')
      expect(issue.statusId).toBe(FIXTURE_STATUS.analysis)
    } else {
      expect(banner()).not.toBeNull()
      expect(issue.description).toBe(scene === 'external-body' ? 'EXTERNAL' : 'BEFORE')
      expect(issue.priority).toBe(scene === 'external-priority' ? 'lowest' : 'medium')
    }
  })
})

describe('LIFE-632 C5 ② 상세 쓰기 A 30초 늦음 → 같은 카드 상세 쓰기 B(본문)', () => {
  it.each(['mine', 'external-title', 'external-priority'] as const)('%s', async (scene) => {
    const la = await laRig()
    const issue = task600(la.fixture)
    issue.description = 'BEFORE'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    const releaseA = await captureLateA()
    // 서버에는 A 가 적용됐다(판 +1). 상세는 아직 모른다.
    expect(issue.priority).toBe('highest')
    // 양성 대조 ⓒ — 그 사이 외부 변경(A 가 안 건드린 칸 · A 가 건드린 칸을 다른 값으로).
    if (scene === 'external-title') { issue.title = 'EXTERNAL TITLE'; issue.version += 1 }
    if (scene === 'external-priority') { issue.priority = 'low'; issue.version += 1 }
    expect(bodyEditDisabled()).toBe(false)
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), 'B 본문')
    click('[data-md-save]')
    await settle(30)
    if (scene === 'mine') {
      expect(banner()).toBeNull()
      expect(issue.description).toBe('B 본문')
      expect(issue.priority).toBe('highest')
    } else {
      expect(banner()).not.toBeNull()
      expect(issue.description).toBe('BEFORE')
    }
    await releaseA()
    if (scene === 'mine') {
      // A 확인 뒤에도 배너 없음 · 다음 저장도 자기 판과 충돌하지 않는다.
      expect(banner()).toBeNull()
      click('[data-issue-body-edit]')
      setValue(input('[data-md-editor] textarea'), 'C 본문')
      click('[data-md-save]')
      await settle(30)
      expect(banner()).toBeNull()
      expect(issue.description).toBe('C 본문')
      expect(issue.priority).toBe('highest')
    }
  })
})
