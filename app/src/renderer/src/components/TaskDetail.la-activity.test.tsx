// @vitest-environment happy-dom
// LIFE-638 C6 — **켜진 LA**(이력·코멘트)의 상세 활동. 실제 경로 React `TasksPage` → hook → `WorkService` → `LaSource` + `LaMcpFixture`(가짜 fetch · 가짜 토큰).
// LA 이력 중 corral 활동 기록과 쓰기 id 가 같은 줄은 한 번만 · 쓰기 id 없는 다른 곳 변경(macbook·웹·모바일)은 `author · LA` · 「변경」·「코멘트」 갈래 · 코멘트 입력(⌘↵).
// 렌더러는 출처 이름으로 가르지 않는다 — 소스 훑기(양성 대조 포함)도 여기서 본다. 렌더러와 main 을 함께 import 하므로 mixed 검사에 둔다.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkSettingsState } from '../../../shared/work.js'
import { FIXTURE_IDS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
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

async function laRig({ pageSize }: { pageSize?: number } = {}): Promise<{ fixture: LaMcpFixture; calls: WorkCall[] }> {
  const fixture = new LaMcpFixture()
  const fetchImpl = async (_url: unknown, options?: RequestInit): Promise<Response> => {
    const body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } = JSON.parse(String(options?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    // fixture 입력 검증(-32602) 없음 — 도구 처리기를 직접 부른다. 입력 형식 판정은 HTTP 경로 시험(`la-activity.test.ts` 등)이 맡는다(LIFE-638 S1-5).
    const reply: { isError: boolean; text: string } | null = body.method === 'initialize' ? null : Reflect.get(fixture, 'tool').call(fixture, { tool: body.params?.name, args: body.params?.arguments ?? {} })
    const result = reply === null ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  let listener: (value: WorkSettingsState) => void = () => {}
  const harness = workHarness({ entries: [laSourceEntry({ url: 'http://127.0.0.1:9/not-networked', clientVersion: 'test', fetchImpl, pageSize })] })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('LA 모의 연결 실패')
  const calls: WorkCall[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => harness.service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: async (request: WorkRequest) => { calls.push(request.call); return harness.service.request(request) },
    workActivity: async (query: unknown) => harness.service.activity(query),
  })
  void listener
  act(() => root.render(createElement('div', null, createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
  await settle(30)
  return { fixture, calls }
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
function setValue(target: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function openCard(itemKey: string): Promise<void> {
  click(`[data-tasks-board] [data-issue-card="${itemKey}"]`)
  await settle()
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
}
async function reopen(itemKey: string): Promise<void> {
  click('[data-issue-close]')
  await settle()
  await openCard(itemKey)
  await settle()
}
const rows = (kind: 'change' | 'comment'): Element[] => [...document.querySelectorAll(`[data-activity-row="${kind}"]`)]

describe('C6 LA 활동 합치기', () => {
  it('corral 쓰기와 같은 쓰기 id 의 LA 이력 줄은 한 번만 · 쓰기 id 없는 다른 곳 변경은 `author · LA` · 「변경」·「코멘트」 갈래에 LA 행 · 코멘트 입력', async () => {
    const r = await laRig()
    await openCard('LIFE-600')
    click('[data-field="priority"]')
    click('[data-priority-row="low"]')
    await settle()
    // LA 에 corral 의 쓰기가 쓰기 id 와 함께 남았다(fixture 이력 = 쓰기와 같은 트랜잭션).
    expect(r.fixture.history.filter((row) => row.issueId === FIXTURE_IDS.task600 && row.field === 'priority' && row.writeId !== null)).toHaveLength(1)
    r.fixture.plantHistory({ issueId: FIXTURE_IDS.task600, author: 'macbook', field: 'status', from: '할 일', to: '개발 중', writeId: null, origin: 'mcp' })
    r.fixture.plantHistory({ issueId: FIXTURE_IDS.task600, author: '웹', field: 'title', from: '작업 계약·연결·LA provider', to: '웹에서 바꾼 제목', writeId: null, origin: 'web' })
    r.fixture.plantComment({ issueId: FIXTURE_IDS.task600, author: '모바일', body: '폰에서 남긴 **코멘트**', origin: 'mobile' })
    await reopen('LIFE-600')
    const changes = rows('change')
    const priority = changes.filter((row) => row.textContent?.includes('우선순위'))
    expect(priority.map((row) => row.getAttribute('data-activity-origin'))).toEqual(['corral'])
    const macbook = changes.find((row) => row.textContent?.includes('macbook · LA'))
    expect(macbook?.getAttribute('data-activity-origin')).toBe('source')
    expect(changes.some((row) => row.getAttribute('data-activity-origin') === 'source' && row.textContent?.includes('웹 · LA') && row.textContent.includes('웹에서 바꾼 제목'))).toBe(true)
    const comment = rows('comment').find((row) => row.textContent?.includes('모바일 · LA'))
    expect(comment?.querySelector('strong')?.textContent).toBe('코멘트')
    // 「변경」 갈래 = 변경 줄만(LA 줄 포함) · 「코멘트」 갈래 = LA 코멘트.
    click('[data-activity-filter="change"]')
    expect(rows('comment')).toHaveLength(0)
    expect(rows('change').some((row) => row.textContent?.includes('macbook · LA'))).toBe(true)
    click('[data-activity-filter="comment"]')
    expect(rows('change')).toHaveLength(0)
    expect(rows('comment').some((row) => row.textContent?.includes('모바일 · LA'))).toBe(true)
    // 코멘트 입력(능력 on) — ⌘↵ 로 LA 에 남고 활동에 보인다.
    const area = el('[data-comment-composer] textarea')
    if (!(area instanceof HTMLTextAreaElement)) throw new Error('입력창 없음')
    setValue(area, 'corral 에서 남김')
    act(() => { area.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', metaKey: true })) })
    await settle()
    expect(r.fixture.comments.filter((row) => row.issueId === FIXTURE_IDS.task600).map((row) => row.body)).toContain('corral 에서 남김')
    expect(rows('comment').some((row) => row.textContent?.includes('corral 에서 남김'))).toBe(true)
    expect(q('[data-comment-off]')).toBeNull()
  })

  it('양성 대조 — LA 이력의 쓰기 id 를 지우면 같은 변경이 두 줄(corral · LA)이 된다(합침이 쓰기 id 로 돈다는 근거)', async () => {
    const r = await laRig()
    await openCard('LIFE-600')
    click('[data-field="priority"]')
    click('[data-priority-row="low"]')
    await settle()
    for (const row of r.fixture.history) row.writeId = null
    await reopen('LIFE-600')
    const priority = rows('change').filter((row) => row.textContent?.includes('우선순위'))
    expect(priority.map((row) => row.getAttribute('data-activity-origin')).sort()).toEqual(['corral', 'source'])
  })
})

describe('K6 LA 다쪽 「더 불러오기」 (r2 S2-7)', () => {
  it('작은 쪽 크기 — 누를 때마다 다음 쪽(받은 커서 그대로)이 붙어 카드가 늘고, 끝 쪽에서 버튼이 사라진다', async () => {
    const r = await laRig({ pageSize: 3 })
    const cards = (): Set<string> => new Set([...document.querySelectorAll('[data-issue-card]')].map((node) => node.getAttribute('data-issue-card') ?? ''))
    const firstPage = r.calls.filter((call) => call.op === 'listItems')
    expect(firstPage.length).toBeGreaterThan(0)
    expect(firstPage.every((call) => call.op === 'listItems' && call.cursor === null)).toBe(true)
    let seen = cards()
    let clicks = 0
    while (q('[data-tasks-more-button]') !== null && clicks < 20) {
      click('[data-tasks-more-button]')
      await settle()
      clicks += 1
      const now = cards()
      expect([...seen].every((key) => now.has(key))).toBe(true)
      seen = now
    }
    expect(clicks).toBeGreaterThan(1)
    expect(q('[data-tasks-more-button]')).toBeNull()
    // 누른 수만큼 커서 쪽을 받았고, 각 커서는 fixture 가 내준 글자 그대로였다(엄격 커서 — 고친 커서면 거절됐다).
    expect(r.calls.filter((call) => call.op === 'listItems' && call.cursor !== null)).toHaveLength(clicks)
    // 끝까지 받은 카드에 첫 쪽 뒤에 오는 작업(seq 가 낮은 LIFE-372)이 있다.
    expect(seen.has('LIFE-372')).toBe(true)
  })
})

describe('C6 렌더러는 출처 이름으로 가르지 않는다', () => {
  // 출처 id 글자·상수 + 표시 이름 글자(descriptor `name`·`mono` — 'LA'·'Jira Cloud'·'Mock Jira'·'MJ')와 그 칸을 글자와 견주는 꼴(r2 S2-6).
  const SOURCE_NAME = /(['"`])(la|jira|mock-jira|LA|Jira|Jira Cloud|Mock Jira|MJ)\1|LA_SOURCE_ID|JIRA_SOURCE_ID|MOCK_SOURCE_ID|\.(name|mono|sourceId)\s*[!=]==?\s*['"`]|['"`]\s*[!=]==?\s*[\w?.]*\.(name|mono|sourceId)\b/
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })

  it('renderer/src 제품 파일에 출처 id·표시 이름 글자와 그 비교가 없다 · 양성 대조: 같은 검사가 심은 분기를 잡는다', () => {
    const root = join(process.cwd(), 'src/renderer/src')
    const scanned = files(root)
    expect(scanned.length).toBeGreaterThan(20)
    const hits = scanned.filter((path) => SOURCE_NAME.test(readFileSync(path, 'utf8')))
    expect(hits).toEqual([])
    // 양성 대조 — 심은 분기(가짜 소스 줄)는 모두 잡힌다.
    const planted = [
      "if (connection.sourceId === 'la') return null",
      'const off = sourceId === JIRA_SOURCE_ID',
      "if (source.name === 'LA') return <Hint />",
      "const jira = descriptor.name === 'Jira Cloud'",
      "if (source.mono !== 'MJ') return",
      "const mock = 'Mock Jira' === connection.name",
      'const label = sourceId === `jira` ? 1 : 2',
    ]
    expect(planted.filter((line) => !SOURCE_NAME.test(line))).toEqual([])
    // 음성 대조 — 출처와 무관한 이름 비교·글자는 잡지 않는다(검사가 아무 줄이나 잡아 녹색을 잃지 않게).
    expect(["if (name === 'worktree') return", "if (shown.id === 'shortcuts') return", "const label = '나 · corral'"].filter((line) => SOURCE_NAME.test(line))).toEqual([])
  })
})
