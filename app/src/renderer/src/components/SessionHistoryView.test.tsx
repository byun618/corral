// @vitest-environment happy-dom
// LIFE-808 C4·C5(화면)·C8·C9·C10·C11·C14·C17·C18·C19(화면) — 세션 보기: 상태별 글, 보일 때만 묻기·새로고침·늦은 응답, 열린 세션, 복사, 필터, 보기 등록.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HistoryProvider, SessionHistoryDetail, SessionHistoryDetailResult, SessionHistoryListResult, SessionHistoryResumeResult, SessionHistoryRow, SessionKey } from '../../../shared/session-history.js'
import { useSessionHistory } from '../hooks/useSessionHistory.js'
import { RIGHT_PANEL_VIEWS } from './right-panel-views.js'
import { SessionHistoryView, type HistoryRepo } from './SessionHistoryView.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const ROW_ID = {
  alpha: '11111111-1111-4111-8111-111111111111',
  beta: '22222222-2222-4222-8222-222222222222',
  gamma: '33333333-3333-4333-8333-333333333333',
  empty: '44444444-4444-4444-8444-444444444444',
}
function row(input: { id: string; provider: HistoryProvider; title: string; cwd: string; empty?: boolean; at: number }): SessionHistoryRow {
  return { provider: input.provider, id: input.id, file: `/h/.${input.provider}/${input.id}.jsonl`, title: input.title, cwd: input.cwd, cwdKey: input.cwd, cwdExists: true, branch: 'main', model: null, firstPrompt: `${input.title} prompt`, lastPrompt: null, lastActivityAt: input.at, empty: input.empty ?? false }
}
const ROWS: SessionHistoryRow[] = [
  row({ id: ROW_ID.alpha, provider: 'claude', title: 'Alpha', cwd: '/w/a', at: 4 }),
  row({ id: ROW_ID.beta, provider: 'codex', title: 'Beta', cwd: '/w/a/sub', at: 3 }),
  row({ id: ROW_ID.gamma, provider: 'claude', title: 'Gamma', cwd: '/w/b', at: 2 }),
  row({ id: ROW_ID.empty, provider: 'claude', title: 'Empty', cwd: '/w/a', empty: true, at: 1 }),
]
const ok = (rows: SessionHistoryRow[] = ROWS, realpaths: Record<string, string> = {}): SessionHistoryListResult => ({ kind: 'ok', rows, unreadable: 0, realpaths })
function detailOf(key: SessionKey): SessionHistoryDetail {
  return {
    provider: key.provider, id: key.id, file: `/h/.${key.provider}/${key.id}.jsonl`, firstPrompt: `first of ${key.id}`, recent: [{ role: 'prompt', text: 'p', at: null }, { role: 'reply', text: 'r', at: null }],
    messageCount: 2, cwd: '/w/gone', cwdExists: false, resume: { argv: ['claude', '--resume', key.id], cwd: '/w', fallback: true, disabled: null }, command: `cd /w && claude --resume ${key.id}`,
  }
}

type Deferred<I, R> = { input: I; resolve: (result: R) => void }
let lists: Deferred<{ providers: HistoryProvider[] }, SessionHistoryListResult>[] = []
let details: Deferred<SessionKey, SessionHistoryDetailResult>[] = []
let resumes: { provider: HistoryProvider; id: string; workspaceId: string }[] = []
let reveals: SessionKey[] = []
let prefWrites: unknown[] = []
let copied: string[] = []
let revealedPanes: string[] = []
let storedPrefs: Record<string, unknown> = {}
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  lists = []
  details = []
  resumes = []
  reveals = []
  prefWrites = []
  copied = []
  revealedPanes = []
  storedPrefs = {}
  Reflect.set(window, 'corral', {
    getUiPrefs: () => Promise.resolve(storedPrefs),
    setUiPrefs: (patch: unknown) => { prefWrites.push(patch) },
    sessionHistoryList: (input: { providers: HistoryProvider[] }) => new Promise<SessionHistoryListResult>((resolve) => { lists.push({ input, resolve }) }),
    sessionHistoryDetail: (input: SessionKey) => new Promise<SessionHistoryDetailResult>((resolve) => { details.push({ input, resolve }) }),
    sessionHistoryResume: (input: { provider: HistoryProvider; id: string; workspaceId: string }): Promise<SessionHistoryResumeResult> => { resumes.push(input); return Promise.resolve({ kind: 'started', paneId: 'w1:p5' }) },
    sessionHistoryReveal: (input: SessionKey) => { reveals.push(input); return Promise.resolve({ kind: 'ok' }) },
  })
  Reflect.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { copied.push(text); return Promise.resolve() } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const REPOS: HistoryRepo[] = [{ root: '/w', worktrees: [{ path: '/w/a', workspace: { tabs: [{ panes: [{ paneId: 'w1:p1', agent: 'codex', agentSession: { kind: 'id', agent: 'codex', source: 'herdr:codex', id: ROW_ID.beta } }, { paneId: 'w1:p2', agent: null, agentSession: { kind: 'id', agent: 'claude', source: 'herdr:claude', id: ROW_ID.alpha } }, { paneId: 'w1:p3', agent: 'codex', agentSession: { kind: 'id', agent: 'claude', source: 'herdr:claude', id: ROW_ID.alpha } }] }] } }, { path: '/w/b', workspace: null }] }]
type Props = { active: boolean; worktree?: string | null; repos?: HistoryRepo[]; workspaceId?: string | null }
function Harness({ active, worktree = '/w/a', repos = REPOS, workspaceId = 'w1' }: Props): React.JSX.Element {
  const api = useSessionHistory({ active })
  return createElement(SessionHistoryView, { api, repos, worktree, workspaceId, onRevealPane: (paneId: string) => { revealedPanes.push(paneId) } })
}
const render = (props: Props): void => act(() => root.render(createElement(Harness, props)))
const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }) }
const settle = async <I, R>(call: Deferred<I, R> | undefined, result: R): Promise<void> => { await act(async () => { call?.resolve(result); for (let i = 0; i < 5; i += 1) await Promise.resolve() }) }
const q = (selector: string): HTMLElement | null => host.querySelector<HTMLElement>(selector)
const all = (selector: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(selector)]
const empty = (): string | null => q('[data-history-empty]')?.textContent ?? null
const titles = (): string[] => all('.history-row-title').map((node) => node.textContent ?? '')
const click = async (selector: string): Promise<void> => { await act(async () => { q(selector)?.click(); for (let i = 0; i < 5; i += 1) await Promise.resolve() }) }
async function type(value: string): Promise<void> {
  const input = q('[data-history-search]')
  if (!(input instanceof HTMLInputElement)) throw new Error('검색 입력 없음')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}
async function shown(props: Props = { active: true }): Promise<void> {
  render(props)
  await flush()
  await settle(lists.at(-1), ok())
}

describe('C10 상태별 화면 — 서로 다른 글', () => {
  it('불러오는 중 · 세션 0건 · 검색 결과 0건 · worktree 선택 없음 · 스캔 실패 · 에이전트 0개', async () => {
    const seen: string[] = []
    render({ active: true })
    await flush()
    seen.push(empty() ?? '')
    await settle(lists.at(-1), ok([]))
    seen.push(empty() ?? '')
    await click('[data-history-refresh]')
    await settle(lists.at(-1), ok())
    await type('없는검색어')
    seen.push(empty() ?? '')
    await type('')
    render({ active: true, worktree: null })
    await flush()
    seen.push(empty() ?? '')
    render({ active: true })
    await click('[data-history-refresh]')
    await settle(lists.at(-1), { kind: 'error', message: 'EACCES: permission denied' })
    seen.push(empty() ?? '')
    await click('[data-history-agent="claude"]')
    await click('[data-history-agent="codex"]')
    seen.push(empty() ?? '')
    expect(seen).toEqual([
      '세션 기록을 불러오는 중…',
      '세션 기록이 없습니다.',
      '검색 결과가 없습니다.',
      'worktree 선택 없음 — 사이드바에서 worktree 를 고르거나 「머신 전체」 로 보세요.',
      '세션 기록을 읽지 못했습니다 — EACCES: permission denied',
      '에이전트를 하나 이상 고르세요 — Claude · Codex 표지를 켜면 기록을 훑습니다.',
    ])
    expect(new Set(seen).size).toBe(6)
  })
})

describe('C4·C5 범위·검색 (화면)', () => {
  it('범위 3단이 행을 바꾸고 검색이 겹친다', async () => {
    await shown()
    expect(titles()).toEqual(['Alpha', 'Beta'])
    await click('[data-history-scope="project"]')
    expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma'])
    await click('[data-history-scope="machine"]')
    expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma'])
    await type('gamma')
    expect(titles()).toEqual(['Gamma'])
  })
})

describe('C11 갱신·늦은 응답', () => {
  it('보이지 않으면 스캔 0 · 열 때 1 · 새로고침 1 · 다시 열면 1 · 상시 타이머 없음', async () => {
    render({ active: false })
    await flush()
    expect(lists).toHaveLength(0)
    render({ active: true })
    await flush()
    expect(lists).toHaveLength(1)
    await settle(lists[0], ok())
    await click('[data-history-refresh]')
    expect(lists).toHaveLength(2)
    render({ active: false })
    await flush()
    render({ active: true })
    await flush()
    expect(lists).toHaveLength(3)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await flush()
    expect(lists).toHaveLength(3)
  })
  it('목록: 늦게 온 이전 스캔은 새 스캔 결과를 덮지 않는다', async () => {
    await shown()
    await click('[data-history-refresh]')
    await click('[data-history-refresh]')
    const [, older, newer] = lists
    await settle(newer, ok(ROWS.slice(0, 1)))
    await settle(older, ok(ROWS))
    expect(titles()).toEqual(['Alpha'])
  })
  it('상세: A 요청 뒤 B 를 고르고 A 가 늦게 와도 B 화면에 A 가 그려지지 않는다', async () => {
    await shown()
    await click(`[data-history-row="claude:${ROW_ID.alpha}"]`)
    await click(`[data-history-row="codex:${ROW_ID.beta}"]`)
    const [a, b] = details
    expect([a?.input.id, b?.input.id]).toEqual([ROW_ID.alpha, ROW_ID.beta])
    await settle(b, { kind: 'ok', detail: detailOf({ provider: 'codex', id: ROW_ID.beta }) })
    await settle(a, { kind: 'ok', detail: detailOf({ provider: 'claude', id: ROW_ID.alpha }) })
    expect(q('[data-history-first]')?.textContent).toBe(`first of ${ROW_ID.beta}`)
  })
})

describe('C8 이미 열린 세션 (화면)', () => {
  it('같은 id 의 pane 이 있으면 「열림」 · 재개 대신 이동 — 재개 호출 0, 이동 1', async () => {
    await shown()
    expect(all('[data-history-open]')).toHaveLength(1)
    expect(q(`[data-history-row="codex:${ROW_ID.beta}"] [data-history-open]`)).not.toBeNull()
    await click(`[data-history-row="codex:${ROW_ID.beta}"]`)
    await settle(details.at(-1), { kind: 'ok', detail: detailOf({ provider: 'codex', id: ROW_ID.beta }) })
    expect(q('[data-history-resume]')).toBeNull()
    await click('[data-history-goto]')
    expect(revealedPanes).toEqual(['w1:p1'])
    expect(resumes).toHaveLength(0)
  })
  it('R1-1 에이전트가 끝나 세션 참조만 남은 pane(agent null)·다른 provider pane 의 같은 id 는 열림이 아니다 — 재개 단추', async () => {
    await shown()
    expect(q(`[data-history-row="claude:${ROW_ID.alpha}"] [data-history-open]`)).toBeNull()
    await click(`[data-history-row="claude:${ROW_ID.alpha}"]`)
    await settle(details.at(-1), { kind: 'ok', detail: detailOf({ provider: 'claude', id: ROW_ID.alpha }) })
    expect(q('[data-history-goto]')).toBeNull()
    expect(q('[data-history-resume]')).not.toBeNull()
  })
  it('열리지 않은 세션은 재개 단추 — 식별자와 workspace 만 보낸다', async () => {
    await shown()
    await click(`[data-history-row="claude:${ROW_ID.alpha}"]`)
    await settle(details.at(-1), { kind: 'ok', detail: detailOf({ provider: 'claude', id: ROW_ID.alpha }) })
    expect(q('[data-history-cwd]')?.textContent).toBe('원래 폴더 없음 — /w 에서 재개')
    await click('[data-history-resume]')
    expect(resumes).toEqual([{ provider: 'claude', id: ROW_ID.alpha, workspaceId: 'w1' }])
    expect(q('[data-history-message]')?.textContent).toBe('새 탭에서 재개했습니다')
    // R1-6(e) — 시작되면 새 탭으로 이동한다.
    expect(revealedPanes).toEqual(['w1:p5'])
  })
  it('R1-2 요청 중에는 재개 단추가 막힌다 — 연타해도 요청 1', async () => {
    let finish: (result: SessionHistoryResumeResult) => void = () => undefined
    Reflect.set(window.corral, 'sessionHistoryResume', (input: { provider: HistoryProvider; id: string; workspaceId: string }) => {
      resumes.push(input)
      return new Promise<SessionHistoryResumeResult>((resolve) => { finish = resolve })
    })
    await shown()
    await click(`[data-history-row="claude:${ROW_ID.alpha}"]`)
    await settle(details.at(-1), { kind: 'ok', detail: detailOf({ provider: 'claude', id: ROW_ID.alpha }) })
    await click('[data-history-resume]')
    await click('[data-history-resume]')
    const button = q('[data-history-resume]')
    expect(button instanceof HTMLButtonElement ? button.disabled : null).toBe(true)
    expect(resumes).toHaveLength(1)
    await act(async () => { finish({ kind: 'pending' }); for (let i = 0; i < 5; i += 1) await Promise.resolve() })
    expect(q('[data-history-message]')?.textContent).toBe('이 세션의 재개가 이미 진행 중입니다')
    const after = q('[data-history-resume]')
    expect(after instanceof HTMLButtonElement ? after.disabled : null).toBe(false)
  })
})

describe('C9·C19 복사·Finder (화면)', () => {
  it('명령 복사 = 상세의 명령 글과 바이트 같음 · ID 복사 = 세션 id · 기록 경로 복사 = 파일 경로 · Finder 는 식별자만', async () => {
    await shown()
    await click(`[data-history-row="claude:${ROW_ID.alpha}"]`)
    await settle(details.at(-1), { kind: 'ok', detail: detailOf({ provider: 'claude', id: ROW_ID.alpha }) })
    await click('[data-history-copy-command]')
    await click('[data-history-copy-id]')
    await click('[data-history-copy-path]')
    await click('[data-history-reveal]')
    expect(copied).toEqual([q('[data-history-command]')?.textContent, ROW_ID.alpha, `/h/.claude/${ROW_ID.alpha}.jsonl`])
    expect(copied[0]).toBe(`cd /w && claude --resume ${ROW_ID.alpha}`)
    expect(reveals).toEqual([{ provider: 'claude', id: ROW_ID.alpha }])
  })
})

describe('R1-4 선택 행이 보이는 목록에서 빠지면 선택·상세를 지운다', () => {
  it('Codex 행을 고른 채 Codex 를 끄면 상세가 사라지고, 다시 켜도 선택은 돌아오지 않는다 · 검색으로 빠져도 같다', async () => {
    await shown()
    await click(`[data-history-row="codex:${ROW_ID.beta}"]`)
    await settle(details.at(-1), { kind: 'ok', detail: detailOf({ provider: 'codex', id: ROW_ID.beta }) })
    expect(q('[data-history-detail]')).not.toBeNull()
    await click('[data-history-agent="codex"]')
    expect(q('[data-history-detail]')).toBeNull()
    expect(all('.history-row.is-selected')).toHaveLength(0)
    await click('[data-history-agent="codex"]')
    await settle(lists.at(-1), ok())
    expect(q('[data-history-detail]')).toBeNull()
    await click(`[data-history-row="claude:${ROW_ID.alpha}"]`)
    await settle(details.at(-1), { kind: 'ok', detail: detailOf({ provider: 'claude', id: ROW_ID.alpha }) })
    await type('beta')
    expect(q('[data-history-detail]')).toBeNull()
  })
})

describe('R1-8 현재 worktree 범위 — realpath · 하위 등록 worktree 제외 (화면)', () => {
  it('루트 체크아웃이 활성이면 `.claude/worktrees/x` 세션은 빠진다 · 활성 경로는 main 이 준 realpath 로 비교', async () => {
    const rootRows = [
      row({ id: ROW_ID.alpha, provider: 'claude', title: 'RootSession', cwd: '/real/corral/app', at: 3 }),
      row({ id: ROW_ID.beta, provider: 'claude', title: 'NestedSession', cwd: '/real/corral/.claude/worktrees/x', at: 2 }),
    ]
    const repos: HistoryRepo[] = [{ root: '/link/corral', worktrees: [{ path: '/link/corral', workspace: null }, { path: '/link/corral/.claude/worktrees/x', workspace: null }] }]
    render({ active: true, worktree: '/link/corral', repos })
    await flush()
    await settle(lists.at(-1), ok(rootRows, { '/link/corral': '/real/corral', '/link/corral/.claude/worktrees/x': '/real/corral/.claude/worktrees/x' }))
    expect(titles()).toEqual(['RootSession'])
    await click('[data-history-scope="project"]')
    expect(titles()).toEqual(['RootSession', 'NestedSession'])
  })
})

describe('C17·C18 필터 (화면)', () => {
  it('빈 세션 숨기기 기본 켬 — 끄면 2 → 3, 값은 ui-prefs 에', async () => {
    await shown()
    expect(titles()).toEqual(['Alpha', 'Beta'])
    await click('[data-history-hide-empty]')
    expect(titles()).toEqual(['Alpha', 'Beta', 'Empty'])
    expect(prefWrites).toEqual([{ sessionHistoryHideEmpty: false }])
  })
  it('에이전트 표지를 끄면 그 provider 를 빼고 다시 훑는다(끈 쪽은 요청에서 빠진다) — 둘 다 끄면 훑지 않는다', async () => {
    await shown()
    expect(lists.map((call) => call.input.providers)).toEqual([['claude', 'codex']])
    await click('[data-history-agent="codex"]')
    expect(lists.map((call) => call.input.providers)).toEqual([['claude', 'codex'], ['claude']])
    expect(titles()).toEqual(['Alpha'])
    await click('[data-history-agent="claude"]')
    expect(lists).toHaveLength(2)
    expect(prefWrites).toEqual([{ sessionHistoryAgents: { claude: true, codex: false } }, { sessionHistoryAgents: { claude: false, codex: false } }])
  })
  it('저장된 필터를 먼저 읽고 그것으로 첫 스캔 — 끈 provider 는 첫 요청부터 빠진다', async () => {
    storedPrefs = { sessionHistoryAgents: { claude: false, codex: true }, sessionHistoryHideEmpty: false }
    render({ active: true })
    await flush()
    expect(lists.map((call) => call.input.providers)).toEqual([['codex']])
    const box = q('[data-history-hide-empty]')
    expect(box instanceof HTMLInputElement ? box.checked : null).toBe(false)
  })
})

describe('C14 보기 등록', () => {
  it('RIGHT_PANEL_VIEWS 에 「세션」 — 단축키 없음', () => {
    expect(RIGHT_PANEL_VIEWS.find((view) => view.id === 'sessions')).toMatchObject({ title: '세션', action: null })
  })
})
