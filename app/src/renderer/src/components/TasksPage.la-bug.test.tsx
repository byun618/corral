// @vitest-environment happy-dom
// LIFE-665 C3 — LA Bug 배치 화면 끝까지: 모달 → hook → `WorkService` → `LaSource` → `LaMcpFixture`(가짜 fetch · 가짜 토큰).
// LA 는 LIFE-293 이후 bug 의 onBoard 를 task 와 같게 받는다(`specs/LIFE-665-bug-placement/raw/coord/c11-la-source-contrast.txt`) —
// Bug 를 골라도 배치 칩은 켜져 있고(「받지 않습니다」 이유 없음) 고른 배치가 LA onBoard 로 간다 · 만든 뒤 상세 배치 칸이 같은 값.
// 진입점(리뷰 r1 S1-6): 머리 「만들기」 · 백로그 보기 섹션 「추가」(백로그·보드) · 「하나 더」. 보드 칸 인라인 「+ 추가」 는 기본 종류(Task)만 만들어 Bug 진입이 아니다.
// 렌더러와 main 을 함께 import 하므로 mixed 검사에 둔다. 픽스처 배선은 `TaskDetail.la-on.test.tsx` 의 laRig 와 같다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkRequest } from '../../../shared/work.js'
import { LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../../main/work/la-source.js'
import { FAKE_LA_TOKEN, workHarness } from '../../../main/work/test-kit.js'
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
  vi.useRealTimers()
})

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function laRig({ prefs = {} }: { prefs?: Record<string, unknown> } = {}): Promise<{ fixture: LaMcpFixture }> {
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
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => prefs, setUiPrefs: () => {}, getWorkSettings: async () => harness.service.settings(),
    onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => harness.service.request(request),
    workActivity: async (query: unknown) => harness.service.activity(query),
  })
  act(() => root.render(createElement('div', null, createElement(TasksPageInPanel, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
  await settle(30)
  return { fixture }
}

const q = (selector: string): Element | null => document.querySelector(selector)
function el(selector: string): HTMLElement {
  const found = q(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`없음: ${selector}`)
  return found
}
const click = (selector: string): void => { act(() => { el(selector).click() }) }
function setTitle(value: string): void {
  const input = el('[data-quick-create-title]')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = (): void => { act(() => { el('[data-quick-create-title]').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', metaKey: true })) }) }

/** 모달을 열고 Bug 를 고른다 — 배치 칩 둘이 켜져 있고 「받지 않습니다」 이유가 없다(옛 R2-H 흐림이 아니다). */
async function openBugModal(): Promise<void> {
  click('[data-tasks-create]')
  await settle()
  click('[data-quick-create-kind="bug"]')
  await settle(12)
  expect(el('[data-quick-create-kind="bug"]').getAttribute('aria-checked')).toBe('true')
  for (const entry of ['board', 'backlog']) expect(el(`[data-quick-create-placement="${entry}"]`).hasAttribute('disabled')).toBe(false)
  expect(el('.qc-place').getAttribute('title')).toBeNull()
  expect(el('[data-quick-create]').textContent ?? '').not.toContain('받지 않습니다')
}

/** 만들기 끝 → 모달 닫힘 · 상세가 그 작업으로 열린다. LA 가 받은 인자와 만든 작업의 키를 돌려준다. */
async function createAndOpen({ fixture, title }: { fixture: LaMcpFixture; title: string }): Promise<{ key: string; args: Record<string, unknown> | undefined }> {
  setTitle(title)
  submit()
  await settle(24)
  expect(q('[data-quick-create]')).toBeNull()
  const made = fixture.issues.find((issue) => issue.title === title)
  if (made === undefined) throw new Error(`LA 에 없음: ${title}`)
  const key = `LIFE-${made.sequentialId}`
  expect(q(`[data-issue-detail="${key}"]`)).not.toBeNull()
  return { key, args: fixture.createArgs.at(-1) }
}

const detailPlacement = (): string | null => q('[data-field="placement"] [data-placement].is-on')?.getAttribute('data-placement') ?? null

it('Bug + 백로그 → LA onBoard false · 상세 배치 칸 = 백로그(켜짐) · 보드 보기에 없음', async () => {
  const { fixture } = await laRig()
  await openBugModal()
  click('[data-quick-create-placement="backlog"]')
  expect(el('[data-quick-create-placement="backlog"]').getAttribute('aria-checked')).toBe('true')
  const { key, args } = await createAndOpen({ fixture, title: 'C3 백로그 버그' })
  expect(args).toMatchObject({ kind: 'bug', title: 'C3 백로그 버그', onBoard: false })
  expect(fixture.issues.find((issue) => issue.title === 'C3 백로그 버그')?.onBoard).toBe(false)
  expect(detailPlacement()).toBe('backlog')
  expect(el('[data-field="placement"]').classList.contains('is-disabled')).toBe(false)
  expect(q(`[data-tasks-board] [data-issue-card="${key}"]`)).toBeNull()
})

it('Bug + 보드(배치 board 진입 = 모달 기본) → LA onBoard true · 상세 배치 칸 = 보드 · 보드 보기에 카드', async () => {
  const { fixture } = await laRig()
  await openBugModal()
  expect(el('[data-quick-create-placement="board"]').getAttribute('aria-checked')).toBe('true')
  const { key, args } = await createAndOpen({ fixture, title: 'C3 보드 버그' })
  expect(args).toMatchObject({ kind: 'bug', title: 'C3 보드 버그', onBoard: true })
  expect(fixture.issues.find((issue) => issue.title === 'C3 보드 버그')?.onBoard).toBe(true)
  expect(detailPlacement()).toBe('board')
  expect(q(`[data-tasks-board] [data-issue-card="${key}"]`)).not.toBeNull()
})

// 리뷰 r1 S1-6 — 리뷰어 탐침(`raw/review/sonnet-r1-raw/probe-sections.test.tsx.txt`)을 회귀 시험으로. 섹션 「추가」 는 그 배치로 모달을 연다 — Bug 로 바꿔도 배치 유지.
const backlogView = { tasksPage: { view: 'backlog' } }
for (const section of ['backlog', 'board'] as const) {
  it(`백로그 보기 섹션 「추가」(${section}) → Bug 로 바꿔 만들기 → LA onBoard ${String(section === 'board')} · 상세 ${section} · 그 섹션에 행 · 보드 보기 카드는 board 만`, async () => {
    const { fixture } = await laRig({ prefs: backlogView })
    click(`[data-section-add="${section}"]`)
    await settle()
    expect(el(`[data-quick-create-placement="${section}"]`).getAttribute('aria-checked')).toBe('true')
    click('[data-quick-create-kind="bug"]')
    await settle(12)
    expect(el(`[data-quick-create-placement="${section}"]`).getAttribute('aria-checked')).toBe('true')
    for (const entry of ['board', 'backlog']) expect(el(`[data-quick-create-placement="${entry}"]`).hasAttribute('disabled')).toBe(false)
    const { key, args } = await createAndOpen({ fixture, title: `C3 섹션 ${section} 버그` })
    expect(args).toMatchObject({ kind: 'bug', onBoard: section === 'board' })
    expect(fixture.issues.find((issue) => issue.title === `C3 섹션 ${section} 버그`)?.onBoard).toBe(section === 'board')
    expect(detailPlacement()).toBe(section)
    expect(q(`[data-backlog-section="${section}"] [data-issue-row="${key}"]`)).not.toBeNull()
    expect(q(`[data-backlog-section="${section === 'board' ? 'backlog' : 'board'}"] [data-issue-row="${key}"]`)).toBeNull()
    // 보드 보기로 바꾸면 보드 섹션으로 만든 Bug 만 보인다.
    click('[data-tasks-view-tab="board"]')
    await settle()
    expect(q(`[data-tasks-board] [data-issue-card="${key}"]`) !== null).toBe(section === 'board')
  })
}

it('백로그 섹션 「추가」 → Bug · 「하나 더」 2건 — 둘 다 LA onBoard false', async () => {
  const { fixture } = await laRig({ prefs: backlogView })
  click('[data-section-add="backlog"]')
  await settle()
  click('[data-quick-create-kind="bug"]')
  await settle(12)
  click('[data-quick-create-another]')
  for (const title of ['C3 하나 더 1', 'C3 하나 더 2']) {
    setTitle(title)
    submit()
    await settle(24)
    expect(q('[data-quick-create]')).not.toBeNull()
    const made = fixture.issues.find((issue) => issue.title === title)
    expect(made).toMatchObject({ kind: 'bug', onBoard: false })
    expect(fixture.createArgs.at(-1)).toMatchObject({ kind: 'bug', title, onBoard: false })
  }
  expect(fixture.createArgs.filter((args) => args.kind === 'bug')).toHaveLength(2)
})
