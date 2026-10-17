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
import type { WorkCall, WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../../main/work/la-source.js'
import type { WorkService } from '../../../main/work/service.js'
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
async function laRig({ checks = true }: { checks?: boolean } = {}): Promise<{ fixture: LaMcpFixture; calls: WorkCall[]; responses: WorkResponse[]; service: WorkService; connectionId: string; emitSettings: () => void }> {
  const fixture = new LaMcpFixture()
  fixture.checksVersion = checks
  const fetchImpl = async (_url: unknown, options?: RequestInit): Promise<Response> => {
    const body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } = JSON.parse(String(options?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const reply: { isError: boolean; text: string } | null = body.method === 'initialize' ? null : Reflect.get(fixture, 'tool').call(fixture, { tool: body.params?.name, args: body.params?.arguments ?? {} })
    const result = reply === null ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
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
/**
 * 쓰기 하나를 출처에서 실제로 처리한 뒤(정본 결과) 배달만 붙든다 — 렌더러 30초 한도 타이머만 손으로 터뜨려 「늦음」(잠금 풀림)으로. 푸는 함수를 돌려준다.
 * `refuse` = 출처가 그 쓰기를 거절한 답(저장 0)을 늦게 배달한다.
 */
async function holdLate({ match, trigger, refuse = false }: { match: (call: WorkCall) => boolean; trigger: () => Promise<void> | void; refuse?: boolean }): Promise<() => Promise<void>> {
  const original = window.corral.workRequest
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  let captured = false
  window.corral.workRequest = async (request: WorkRequest) => {
    const hit = !captured && match(request.call)
    const response: WorkResponse = hit && refuse ? { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'rejected', message: 'fixture refused', status: 400 } } : await original(request)
    if (hit) { captured = true; await pending }
    return response
  }
  let timeout: (() => void) | null = null
  const native = globalThis.setTimeout
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, ms, ...args) => {
    if (ms === 30000 && typeof handler === 'function') { timeout = () => handler(); return native(() => {}, 120000) }
    return native(handler, ms, ...args)
  })
  await trigger()
  await settle(10)
  expect(captured).toBe(true)
  await act(async () => { timeout?.() })
  timer.mockRestore()
  await settle(20)
  return async () => { await act(async () => { release() }); await settle(30) }
}
const lateA = ({ refuse = false }: { refuse?: boolean } = {}) => holdLate({
  match: (call) => call.op === 'updateItem' && call.fields.priority === 'highest', refuse,
  trigger: () => { click('[data-field="priority"]'); click('[data-priority-row="highest"]') },
})
const disabled = (selector: string): boolean => { const button = el(selector); return button instanceof HTMLButtonElement && button.disabled }
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

describe('LIFE-632 C5 ① 양성 대조 — 보드 쓰기 뒤 결과 읽기 앞 외부가 같은 칸을 다른 값으로(리뷰 r1 X1-2)', () => {
  it('배너 — 내 쓰기가 보낸 값과 결과 값이 달라 설명되지 않는다', async () => {
    const la = await laRig()
    const issue = task600(la.fixture)
    issue.description = 'BEFORE'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), '내 글')
    const tool = Reflect.get(la.fixture, 'tool').bind(la.fixture)
    let injected = false
    Reflect.set(la.fixture, 'tool', (value: { tool: string; args: Record<string, unknown> }) => {
      const result = tool(value)
      if (!injected && (value.tool === 'issue_transition' || value.tool === 'issue_update') && value.args.id === issue.id) {
        injected = true
        // 외부 쓰기 — 보드 쓰기가 저장된 뒤, 결과 issue_get 앞(서로 다른 세 상태: 원래 · 보드가 보낸 analysis · 외부 done).
        issue.statusId = FIXTURE_STATUS.done; issue.resolution = 'completed'; issue.version += 1
      }
      return result
    })
    await dragTo({ card: `LIFE-${issue.sequentialId}`, zone: `col:st:${FIXTURE_STATUS.analysis}` })
    expect(injected).toBe(true)
    click('[data-md-save]')
    await settle(30)
    expect(banner()).not.toBeNull()
    expect(issue.description).toBe('BEFORE')
    expect(issue.statusId).toBe(FIXTURE_STATUS.done)
  })
})

describe('LIFE-632 C5 ② 같은 카드에 답이 안 온 내 쓰기(30초 늦음) → 상세 쓰기는 기다린다(배너 아님)', () => {
  it('622 r2 원장면 — 같은 칸 연속 저장(우선순위 highest 늦음 → lowest): 기다렸다가 저장, 배너 없음, 서버 = lowest', async () => {
    const la = await laRig()
    const issue = task600(la.fixture)
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    const releaseA = await lateA()
    expect(issue.priority).toBe('highest')
    // 기다림 — 칸이 막히고(배너 아님) B 는 나가지 않는다.
    expect(disabled('[data-field="priority"]')).toBe(true)
    expect(bodyEditDisabled()).toBe(true)
    expect(banner()).toBeNull()
    await releaseA()
    expect(disabled('[data-field="priority"]')).toBe(false)
    const before = la.calls.length
    click('[data-field="priority"]'); click('[data-priority-row="lowest"]')
    await settle(30)
    expect(banner()).toBeNull()
    expect(issue.priority).toBe('lowest')
    const sent = la.calls.slice(before).find((call) => call.op === 'updateItem')
    expect(sent !== undefined && sent.op === 'updateItem' ? sent.ifVersion : null).toBe(String(issue.version - 1))
  })

  it('다른 칸 — 우선순위 늦음 → 본문: 기다렸다가 저장, 배너 없음, 서버 = 두 변경', async () => {
    const la = await laRig()
    const issue = task600(la.fixture)
    issue.description = 'BEFORE'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    const releaseA = await lateA()
    expect(bodyEditDisabled()).toBe(true)
    await releaseA()
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), 'B 본문')
    click('[data-md-save]')
    await settle(30)
    expect(banner()).toBeNull()
    expect(issue.description).toBe('B 본문')
    expect(issue.priority).toBe('highest')
  })

  it('622 인계 — 늦은 보드 쓰기(판 없음) 뒤 같은 카드 상세 저장: 기다렸다가 저장, 배너 없음, 서버 = 보드 상태 + 본문', async () => {
    const la = await laRig()
    const issue = task600(la.fixture)
    issue.description = 'BEFORE'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    const release = await holdLate({ match: (call) => call.op === 'changeStatus', trigger: () => dragTo({ card: `LIFE-${issue.sequentialId}`, zone: `col:st:${FIXTURE_STATUS.analysis}` }) })
    expect(issue.statusId).toBe(FIXTURE_STATUS.analysis)
    expect(bodyEditDisabled()).toBe(true)
    expect(banner()).toBeNull()
    await release()
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), 'B 본문')
    click('[data-md-save]')
    await settle(30)
    expect(banner()).toBeNull()
    expect(issue.description).toBe('B 본문')
    expect(issue.statusId).toBe(FIXTURE_STATUS.analysis)
  })

  // 양성 대조 — 기다리는 동안 외부 변경이 끼면 지금처럼 배너(외부 값 보존).
  it.each(['external-title', 'external-priority', 'version-only'] as const)('외부 변경 %s → 배너', async (scene) => {
    const la = await laRig()
    const issue = task600(la.fixture)
    issue.description = 'BEFORE'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    const releaseA = await lateA()
    if (scene === 'external-title') { issue.title = 'EXTERNAL TITLE'; issue.version += 1 }
    if (scene === 'external-priority') { issue.priority = 'low'; issue.version += 1 }
    if (scene === 'version-only') issue.version += 1
    await releaseA()
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), 'B 본문')
    click('[data-md-save]')
    await settle(30)
    expect(banner()).not.toBeNull()
    expect(issue.description).toBe('BEFORE')
    if (scene === 'external-priority') expect(issue.priority).toBe('low')
  })

  it('외부 완료 갈래 변경(리뷰 r1 X1-3) — 상태 A(완료함) 늦음 → 외부가 취소함으로 → 본문 저장 = 배너', async () => {
    const la = await laRig()
    const issue = task600(la.fixture)
    issue.description = 'BEFORE'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    const releaseA = await holdLate({ match: (call) => call.op === 'changeStatus', trigger: () => { click('[data-issue-status]'); click(`[data-status-row="${FIXTURE_STATUS.done}"][data-status-resolution="completed"]`) } })
    expect(issue.resolution).toBe('completed')
    issue.resolution = 'cancelled'; issue.version += 1
    expect(bodyEditDisabled()).toBe(true)
    await releaseA()
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), 'B 본문')
    click('[data-md-save]')
    await settle(30)
    expect(banner()).not.toBeNull()
    expect(issue.description).toBe('BEFORE')
    expect(issue.resolution).toBe('cancelled')
  })

  it('연결 세대 교체(리뷰 r1 X1-4) — 옛 세대 A(거절) 답 전 교체 → 새 세대 외부 변경 → 본문 저장 = 배너', async () => {
    const la = await laRig()
    const issue = task600(la.fixture)
    issue.description = 'BEFORE'
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    const releaseA = await lateA({ refuse: true })
    await act(async () => { await la.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: la.connectionId }); la.emitSettings() })
    await settle(30)
    // 새 세대는 옛 세대의 답을 기다리지 않는다(영구 막힘 없음).
    expect(bodyEditDisabled()).toBe(false)
    issue.priority = 'highest'; issue.version += 1
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), 'B 본문')
    click('[data-md-save]')
    await settle(30)
    expect(banner()).not.toBeNull()
    expect(issue.description).toBe('BEFORE')
    await releaseA()
  })

  it('앞 쓰기가 실제로 거절됐는데 외부가 그 값을 넣음(리뷰 r1 m15) — 기다리는 동안 같은 칸 B 는 나가지 않고, 답 뒤 상세는 서버 값(외부)을 받는다', async () => {
    const la = await laRig()
    const issue = task600(la.fixture)
    await openCard(`LIFE-${issue.sequentialId}`)
    await settle(20)
    const releaseA = await lateA({ refuse: true })
    expect(issue.priority).not.toBe('highest')
    issue.priority = 'highest'; issue.version += 1
    const before = la.calls.length
    expect(disabled('[data-field="priority"]')).toBe(true)
    expect(la.calls.slice(before).filter((call) => call.op === 'updateItem')).toHaveLength(0)
    await releaseA()
    // 늦은 거절 → 단건 재조회 — 상세 base = 서버(외부 highest, 새 판). 그 뒤의 쓰기는 본 값 위의 새 편집이고 판도 맞다.
    expect(la.calls.slice(before).filter((call) => call.op === 'getItem').length).toBeGreaterThanOrEqual(1)
    click('[data-issue-body-edit]')
    setValue(input('[data-md-editor] textarea'), 'B 본문')
    click('[data-md-save]')
    await settle(30)
    expect(banner()).toBeNull()
    expect(issue.priority).toBe('highest')
    expect(issue.description).toBe('B 본문')
  })
})
