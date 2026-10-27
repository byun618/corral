// @vitest-environment happy-dom
// LIFE-623 최종 관문 C4 — T3 C8 의 G4(LIFE-602 격리 관문 `g-gate.mjs` 의 g4 · g4drift · g4la)를 격리 Electron 창 없이 같은 단계로 돈다.
// 경로: React `TasksPage` → hooks → 실제 `WorkService` → 출처(모의 `mock-jira` 충돌 검사 켜짐 · 실제 `LaSource` + `LaMcpFixture`). window.corral 은 시험 bridge(IPC 아님).
// 외부 변경은 g-gate 와 같이 같은 서비스에 `updateItem`(ifVersion null) 으로 넣는다 — 다른 클라이언트의 저장. 대응표 `specs/LIFE-623-null-body/raw/claude/final/g4-map.md`.
// 렌더러와 main 을 함께 import 하므로 web 타입 검사에서 빼고 mixed 검사(tsconfig.mixed.json)에 둔다 — 선례 scripts/tasks-windowless/jira.test.tsx.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkFieldPatch, WorkItem, WorkRequest, WorkResponse } from '../../src/shared/work.js'
import { MemoryActivity } from '../../src/main/work/activity-store.js'
import { FIXTURE_IDS, LaMcpFixture } from '../../src/main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../src/main/work/la-source.js'
import { mockSourceEntry, seedMockDemoState } from '../../src/main/work/mock-source.js'
import { WorkService } from '../../src/main/work/service.js'
import { WorkSourceRegistry } from '../../src/main/work/source.js'
import { CredentialVault } from '../../src/main/work/vault.js'
import { FAKE_LA_TOKEN, FAKE_MOCK_TOKEN, FakeCipher, MemoryStore, workHarness } from '../../src/main/work/test-kit.js'
import { TasksPage } from '../../src/renderer/src/components/TasksPage.js'

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

const settle = async (rounds = 12): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
function renderPage(): void {
  act(() => root.render(createElement('div', null, createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
}
function bridge({ service }: { service: WorkService }): void {
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => service.settings(),
    onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => service.request(request),
    workActivity: async (query: unknown) => service.activity(query),
  })
}

type Gate = { service: WorkService; connectionId: string }
/** g4 · g4drift — 모의 출처(충돌 검사 켜짐). drift 는 토큰에 `drift`(g-gate 의 `mock_l602_g4_drift` 와 같은 행동). */
async function mockGate({ drift }: { drift: boolean }): Promise<Gate> {
  const state = seedMockDemoState()
  let seq = 0
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]), activity: new MemoryActivity(),
    repos: () => [], onChange: () => {}, now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  // 양성 대조(`L623_G4_CONTROL=conflict-off`): 같은 시험을 충돌 검사 꺼진 모의로 — 배너 단언이 실패해야 이 대응이 충돌 검사를 본다는 근거가 된다.
  const control = process.env.L623_G4_CONTROL === 'conflict-off' ? '_cap-conflictCheck-off' : ''
  const added = await service.addConnection({ sourceId: 'mock-jira', token: `${FAKE_MOCK_TOKEN}${drift ? '_drift' : ''}${control}`, replaceId: null })
  if (!added.ok) throw new Error('모의 연결 실패')
  bridge({ service })
  renderPage()
  await settle()
  return { service, connectionId: added.connection.id }
}
/** g4la — 실제 `LaSource` + `LaMcpFixture`(충돌 검사 꺼짐). 네트워크 없이 가짜 fetch 가 fixture 도구 처리기를 부른다(r7 과 같은 방식). */
async function laGate(): Promise<Gate & { fixture: LaMcpFixture }> {
  const fixture = new LaMcpFixture()
  const fetchImpl = async (_url: unknown, options?: RequestInit): Promise<Response> => {
    const body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } = JSON.parse(String(options?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    // fixture 입력 검증(-32602) 없음 — 도구 처리기를 직접 부른다. 입력 형식 판정은 HTTP 경로 시험(`la-activity.test.ts` 등)이 맡는다(LIFE-638 S1-5).
    const reply: { isError: boolean; text: string } | null = body.method === 'initialize' ? null : Reflect.get(fixture, 'tool').call(fixture, { tool: body.params?.name, args: body.params?.arguments ?? {} })
    const result = reply === null ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  const harness = workHarness({ entries: [laSourceEntry({ url: 'http://127.0.0.1:9/not-networked', clientVersion: 'test', fetchImpl })] })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('LA 모의 연결 실패')
  bridge({ service: harness.service })
  renderPage()
  await settle(30)
  return { service: harness.service, connectionId: added.connection.id, fixture }
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
function setValue(selector: string, value: string): void {
  const target = el(selector)
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) throw new Error(selector)
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function blur(selector: string): void {
  const target = el(selector)
  act(() => { target.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); target.dispatchEvent(new FocusEvent('blur')) })
}
async function openCard(itemKey: string): Promise<void> {
  click(`[data-tasks-board] [data-issue-card="${itemKey}"]`)
  await settle(20)
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
}
/** g-gate `banner()` — 배너가 있으면 바뀐 칸 목록, 없으면 null. */
const banner = (): string[] | null => (q('[data-issue-conflict]') === null ? null : [...document.querySelectorAll('[data-conflict-field]')].map((node) => node.getAttribute('data-conflict-field') ?? ''))
async function external({ gate, itemId, fields }: { gate: Gate; itemId: string; fields: WorkFieldPatch }): Promise<WorkResponse> {
  return await gate.service.request({ requestId: `ext-${Math.random()}`, connectionId: gate.connectionId, call: { op: 'updateItem', itemId, fields, ifVersion: null } })
}
async function serverItem({ gate, itemId }: { gate: Gate; itemId: string }): Promise<WorkItem> {
  const got = await gate.service.request({ requestId: `get-${Math.random()}`, connectionId: gate.connectionId, call: { op: 'getItem', itemId } })
  if (!got.ok || got.result.op !== 'getItem') throw new Error('서버 단건')
  return got.result.item
}
const screen = (): { title: string | null; priority: string | null; body: string; banner: boolean } => {
  const title = q('[data-issue-title]')
  return { title: title instanceof HTMLInputElement || title instanceof HTMLTextAreaElement ? title.value : null, priority: q('[data-field="priority"]')?.textContent ?? null, body: q('[data-issue-body]')?.textContent ?? '', banner: q('[data-issue-conflict]') !== null }
}
async function editBody(value: string): Promise<void> {
  click('[data-issue-body-edit]')
  setValue('[data-md-editor] textarea', value)
  click('[data-md-save]')
  await settle(20)
}

// g4 — 한 상세(CORE-2)에서 네 시나리오를 차례로(g-gate 와 같은 순서·같은 값). 각 시나리오: 외부 변경 → 상세 저장 → 배너·칸 → 새로 불러오기 / 덮기 → 서버 값·화면.
it('G4 충돌 켜진 모의 — 제목(새로 불러오기) · 우선순위(덮기) · 본문(새로 불러오기) · 체크 칸(덮기)', async () => {
  const gate = await mockGate({ drift: false })
  const seed = await external({ gate, itemId: 'm-2', fields: { body: 'SEED BODY\n- [ ] A\n- [ ] B\n' } })
  expect(seed.ok).toBe(true)
  await openCard('CORE-2')
  const log: unknown[] = []

  // 제목
  expect(banner()).toBeNull()
  expect((await external({ gate, itemId: 'm-2', fields: { title: 'EXT TITLE' } })).ok).toBe(true)
  setValue('[data-issue-title]', 'MY TITLE')
  blur('[data-issue-title]')
  await settle(20)
  const titleShown = banner()
  const titleMid = await serverItem({ gate, itemId: 'm-2' })
  click('[data-conflict-reload]')
  await settle(20)
  const titleLast = await serverItem({ gate, itemId: 'm-2' })
  log.push({ step: '제목', titleShown, mid: titleMid.title, last: titleLast.title, screen: screen() })
  expect(titleShown).toContain('title')
  expect(titleMid.title).toBe('EXT TITLE')
  expect(titleLast.title).toBe('EXT TITLE')
  expect(screen()).toMatchObject({ title: 'EXT TITLE', banner: false })

  // 우선순위
  expect(banner()).toBeNull()
  expect((await external({ gate, itemId: 'm-2', fields: { priority: 'lowest' } })).ok).toBe(true)
  click('[data-field="priority"]')
  click('[data-priority-row="high"]')
  await settle(20)
  const priorityShown = banner()
  const priorityMid = await serverItem({ gate, itemId: 'm-2' })
  click('[data-conflict-override]')
  await settle(20)
  const priorityLast = await serverItem({ gate, itemId: 'm-2' })
  log.push({ step: '우선순위', priorityShown, mid: priorityMid.priority, last: priorityLast.priority, screen: screen() })
  expect(priorityShown).toContain('priority')
  expect(priorityMid.priority).toBe('lowest')
  expect(priorityLast.priority).toBe('high')
  expect(screen().banner).toBe(false)

  // 본문
  expect(banner()).toBeNull()
  expect((await external({ gate, itemId: 'm-2', fields: { body: 'EXT BODY\n- [ ] A\n- [ ] B\n' } })).ok).toBe(true)
  await editBody('MY BODY')
  const bodyShown = banner()
  const bodyMid = await serverItem({ gate, itemId: 'm-2' })
  click('[data-conflict-reload]')
  await settle(20)
  const bodyLast = await serverItem({ gate, itemId: 'm-2' })
  log.push({ step: '본문', bodyShown, mid: bodyMid.body, last: bodyLast.body, screen: screen() })
  expect(bodyShown).toContain('body')
  expect(bodyMid.body).toBe('EXT BODY\n- [ ] A\n- [ ] B\n')
  expect(bodyLast.body).toBe('EXT BODY\n- [ ] A\n- [ ] B\n')
  expect(screen().body).toContain('EXT BODY')
  expect(screen().banner).toBe(false)

  // 체크 칸
  expect(banner()).toBeNull()
  expect((await external({ gate, itemId: 'm-2', fields: { body: 'EXT BODY\n- [ ] A\n- [ ] B CHANGED\n' } })).ok).toBe(true)
  click('[data-issue-body] [data-md-check="2"]')
  await settle(20)
  const checkShown = banner()
  const checkMid = await serverItem({ gate, itemId: 'm-2' })
  click('[data-conflict-override]')
  await settle(20)
  const checkLast = await serverItem({ gate, itemId: 'm-2' })
  log.push({ step: '체크 칸', checkShown, mid: checkMid.body, last: checkLast.body, screen: screen() })
  console.log('G4 MOCK', JSON.stringify(log))
  expect(checkShown).toContain('body')
  expect(checkMid.body).toBe('EXT BODY\n- [ ] A\n- [ ] B CHANGED\n')
  expect(checkLast.body).toBe('EXT BODY\n- [x] A\n- [ ] B\n')
})

// g4drift — 코멘트(⌘↵) 뒤 단건 재조회(두 번째 읽기)에서 모의 웹이 우선순위를 바꿈 → 제목 저장 = 저장 안 됨 · 배너 칸 priority.
it('G4 drift — 다른 곳의 우선순위 변경 뒤 제목 저장 = 저장 안 됨 · 배너 칸 priority', async () => {
  const gate = await mockGate({ drift: true })
  await openCard('CORE-2')
  setValue('[data-comment-composer] textarea', 'G4 DRIFT')
  act(() => { el('[data-comment-composer] textarea').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', metaKey: true })) })
  await settle(30)
  // 모의 drift 는 두 번째 단건 읽기 50 ms 뒤에 바꾼다 — g-gate 의 sleep(800) 자리.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
  await settle(10)
  const drifted = await serverItem({ gate, itemId: 'm-2' })
  setValue('[data-issue-title]', 'DRIFT TITLE')
  blur('[data-issue-title]')
  await settle(20)
  const shown = banner()
  const last = await serverItem({ gate, itemId: 'm-2' })
  console.log('G4 DRIFT', JSON.stringify({ driftedPriority: drifted.priority, shown, lastTitle: last.title }))
  expect(shown).toContain('priority')
  expect(last.title).not.toBe('DRIFT TITLE')
})

// g4la — LA. LIFE-622 로 충돌 검사가 켜져 기대값을 바꿨다(전: 「꺼짐 — 배너 0 · 나중 저장이 이김」): 같은 외부 변경 뒤 저장 = 그 칸 충돌 배너 · 저장 0,
// 「내 값으로 덮기」 를 누르면 내 값이 이긴다. 제목 · 우선순위 · 본문.
it('G4 LA 모의 MCP — 제목·우선순위·본문 외부 변경 뒤 저장: 충돌 배너 · 저장 0 → 덮기로 내 값', async () => {
  const gate = await laGate()
  const issue = gate.fixture.issues.find((entry) => entry.id === FIXTURE_IDS.task600)
  if (issue === undefined) throw new Error('fixture')
  await openCard(`LIFE-${issue.sequentialId}`)
  const steps: { name: string; field: string; fields: WorkFieldPatch; save: () => Promise<void>; mine: (item: WorkItem) => boolean }[] = [
    { name: '제목', field: 'title', fields: { title: 'EXT LA TITLE' }, save: async () => { setValue('[data-issue-title]', 'MY LA TITLE'); blur('[data-issue-title]'); await settle(20) }, mine: (item) => item.title === 'MY LA TITLE' },
    { name: '우선순위', field: 'priority', fields: { priority: 'low' }, save: async () => { click('[data-field="priority"]'); click('[data-priority-row="highest"]'); await settle(20) }, mine: (item) => item.priority === 'highest' },
    { name: '본문', field: 'body', fields: { body: 'EXT LA BODY' }, save: async () => { await editBody('MY LA BODY') }, mine: (item) => item.body === 'MY LA BODY' },
  ]
  const log: unknown[] = []
  for (const step of steps) {
    expect((await external({ gate, itemId: issue.id, fields: step.fields })).ok).toBe(true)
    await step.save()
    const shown = banner()
    const last = await serverItem({ gate, itemId: issue.id })
    log.push({ step: step.name, shown, title: last.title, priority: last.priority, body: last.body })
    expect(shown).toContain(step.field)
    expect(step.mine(last)).toBe(false)
    click('[data-conflict-override]')
    await settle(20)
    expect(banner()).toBeNull()
    expect(step.mine(await serverItem({ gate, itemId: issue.id }))).toBe(true)
  }
  console.log('G4 LA', JSON.stringify(log))
})
