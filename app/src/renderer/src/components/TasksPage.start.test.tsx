// @vitest-environment happy-dom
// LIFE-603 C1·C2·C5·C6·C7·C10 — 작업 버튼 · 시작 모달 · 상태 옮기기 · 실패 행동 · 연타/합류 · 칩·실행 영역(DOM).
// 실제 WorkService(모의 출처 · 메모리 활동)를 preload 자리에 잇는다. 런타임(`startWork`)은 시험이 응답 모양 그대로 돌려준다 —
// 실제 런타임 실측은 최종 관문 몫이다(이 시험은 화면 계약만 본다).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkCall, WorkRequest, WorkSettingsState } from '../../../shared/work.js'
import type { RelaunchAgentInput, StartAttemptView, StartWorkInput, StartWorkResult, StartStage } from '../../../shared/work-start.js'
import { testDigest, testPane, testRepo, testWorktree } from '../../../shared/test-rows.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { mockSourceEntry, seedMockDemoState, type MockState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FakeCipher, MemoryStore } from '../../../main/work/test-kit.js'
import { TasksPage, type TasksFocus } from './TasksPage.js'

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
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const stage = (status: StartStage['status'], code: string | null = null, message: string | null = null): StartStage => ({ status, code, message })
function result(input: Partial<StartWorkResult> & { attemptId: string }): StartWorkResult {
  return { joined: false, done: true, stages: { worktree: stage('completed'), agent: stage('completed'), prompt: stage('completed') }, worktreePath: '/repo/.claude/worktrees/CORE-2', linkSaved: true, sourceLink: { state: 'saved', message: null }, refused: null, ...input }
}

type Rig = {
  state: MockState
  calls: WorkCall[]
  starts: StartWorkInput[]
  relaunches: RelaunchAgentInput[]
  opened: { repoRoot: string; path: string }[]
  revealed: string[]
  connectionId: string
  /** 다음 startWork 응답 — 함수면 그 약속을 돌려준다(진행 중 시험). */
  next: (input: StartWorkInput) => Promise<StartWorkResult>
  status: StartAttemptView | null
  focus: TasksFocus | null
  render: (repos: RepoRow[]) => Promise<void>
}

async function rig({ repos = [testRepo({ root: '/repo', worktrees: [] })] }: { repos?: RepoRow[] } = {}): Promise<Rig> {
  const state = seedMockDemoState()
  let seq = 0
  let listener: (value: WorkSettingsState) => void = () => {}
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]), activity: new MemoryActivity(),
    repos: () => [], onChange: (value) => listener(value), now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token: 'mock_l603_fixture', replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const connectionId = service.settings().connections[0]?.id ?? ''
  const r: Rig = {
    state, calls: [], starts: [], relaunches: [], opened: [], revealed: [], connectionId, status: null, focus: null,
    next: async (input) => result({ attemptId: input.attemptId }),
    render: async (next) => {
      act(() => root.render(createElement('div', null, createElement(TasksPage, {
        open: true, repos: next, activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {},
        onOpenWorktree: (tree) => { r.opened.push({ repoRoot: tree.repoRoot, path: tree.path }) },
        onRevealPane: (paneId) => { r.revealed.push(paneId) },
        focus: r.focus,
      }), createElement(Toaster))))
      await settle()
    },
  }
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: undefined }),
    setUiPrefs: () => {},
    getWorkSettings: async () => service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: (request: WorkRequest) => { r.calls.push(request.call); return service.request(request) },
    workActivity: async (query: unknown) => service.activity(query),
    startWork: (input: StartWorkInput) => { r.starts.push(input); return r.next(input) },
    startWorkStatus: async () => r.status,
    relaunchWorkAgent: async (input: RelaunchAgentInput) => { r.relaunches.push(input); return result({ attemptId: input.attemptId, stages: { worktree: stage('completed', 'already_linked'), agent: stage('completed'), prompt: stage('skipped', 'relaunch', '다시 띄운 에이전트에는 프롬프트를 넣지 않습니다.') } }) },
  })
  await r.render(repos)
  return r
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
function inputOf(selector: string): HTMLInputElement {
  const target = el(selector)
  if (!(target instanceof HTMLInputElement)) throw new Error(`입력 칸 아님: ${selector}`)
  return target
}
function check(selector: string): void {
  const target = el(selector)
  if (!(target instanceof HTMLInputElement)) throw new Error(selector)
  act(() => { target.click() })
}
function setName(value: string): void {
  const target = el('[data-start-name]')
  if (!(target instanceof HTMLInputElement)) throw new Error('이름 칸')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function openCard(itemKey: string): Promise<void> {
  click(`[data-tasks-board] [data-issue-card="${itemKey}"]`)
  await settle()
  expect(q(`[data-issue-detail="${itemKey}"]`)).not.toBeNull()
}
const writes = (calls: WorkCall[]): WorkCall[] => calls.filter((call) => call.op === 'changeStatus' || call.op === 'updateItem' || call.op === 'setPlacement')
const linked = (input: { path: string; branch: string; itemId?: string | null; key?: string; panes?: Parameters<typeof testWorktree>[0]['panes'] }, connectionId: string) => testWorktree({
  path: input.path, branch: input.branch, panes: input.panes ?? [],
  workLink: input.itemId === null || input.itemId === undefined
    ? { mode: 'auto', sourceId: 'mock-jira', connectionId, key: input.key ?? 'CORE-2', itemId: null, connected: true }
    : { mode: 'explicit', sourceId: 'mock-jira', connectionId, key: input.key ?? 'CORE-2', itemId: input.itemId, connected: true },
})

describe('C1 작업 버튼 — 링크 없음 · 있음', () => {
  it('링크 없음 = 「▶ 시작」 하나, 「실행」 은 빈 문구', async () => {
    await rig()
    await openCard('CORE-2')
    expect(el('[data-issue-start="first"]').textContent).toContain('시작')
    expect(q('[data-issue-open]')).toBeNull()
    expect(q('[data-issue-start="another"]')).toBeNull()
    expect(el('[data-issue-work]').textContent).toContain('아직 연 worktree 가 없습니다. 브랜치 이름에 CORE-2 가 들어가면 자동으로 여기 붙습니다.')
  })
  it('링크 있음 = 「열기 · 브랜치」 + 「하나 더 시작」 — 열기·칩·실행 「worktree 로」 는 같은 경로, 시작 계열은 「이미 진행 중」 상자', async () => {
    const r = await rig()
    await r.render([testRepo({ root: '/repo', worktrees: [linked({ path: '/repo/wt/a', branch: 'scratch-a', itemId: 'm-2' }, r.connectionId)] })])
    await openCard('CORE-2')
    expect(el('[data-issue-open]').textContent).toContain('scratch-a')
    click('[data-issue-open]')
    click('[data-tasks-board] [data-issue-worktree="scratch-a"]')
    click('[data-work-goto="scratch-a"]')
    expect(r.opened).toEqual([{ repoRoot: '/repo', path: '/repo/wt/a' }, { repoRoot: '/repo', path: '/repo/wt/a' }, { repoRoot: '/repo', path: '/repo/wt/a' }])
    click('[data-issue-start="another"]')
    await settle()
    expect(q('[data-start-existing]')).not.toBeNull()
    expect(el('[data-start-submit]').hasAttribute('disabled')).toBe(true)
    click('[data-start-open-existing]')
    expect(q('[data-start-work]')).toBeNull()
    expect(r.opened).toHaveLength(4)
    click('[data-issue-start="another"]')
    await settle()
    click('[data-start-another]')
    expect(q('[data-start-existing]')).toBeNull()
    click('[data-start-repo-option="repo"]')
    expect(el('[data-start-submit]').hasAttribute('disabled')).toBe(false)
  })
})

describe('LIFE-604 F10 — 시작 모달이 열린 동안 페이지 키가 새지 않는다', () => {
  it('버튼에 포커스가 있어도 `1–4`·`/`·`C` 는 페이지에 닿지 않는다(보기·검색·만들기 그대로)', async () => {
    await rig()
    await openCard('CORE-2')
    click('[data-issue-start="first"]')
    await settle()
    const view = el('[data-tasks-page]').getAttribute('data-tasks-view')
    const inside = el('[data-start-work] button')
    for (const key of ['2', '3', '/', 'c']) act(() => { inside.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    await settle()
    expect(el('[data-tasks-page]').getAttribute('data-tasks-view')).toBe(view)
    expect(document.activeElement).not.toBe(q('[data-tasks-search]'))
    expect(q('[data-quick-create]')).toBeNull()
  })
})

describe('C2 시작 모달 — 기본값 · 입력', () => {
  it('이름 = 키(한글 제목) · 프롬프트 = 제목 + 부모 + untrusted 본문 · 바로 보내기·상태 옮기기 꺼짐 · 빈 터미널이면 모델·프롬프트 없음', async () => {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-issue-start="first"]')
    await settle()
    expect(el('[data-start-work]').classList.contains('modal-start-work')).toBe(true)
    expect(inputOf('[data-start-name]').value).toBe('CORE-2')
    const prompt = el('[data-start-prompt]').textContent ?? ''
    expect(prompt).toContain('작업: CORE-2 카드 저장')
    expect(prompt).toContain('부모: CORE-1 결제 개편')
    expect(prompt).toContain('<untrusted-work-item')
    expect(inputOf('[data-start-send] input').checked).toBe(false)
    expect(inputOf('[data-start-status] input').checked).toBe(false)
    // 레포가 하나뿐이어도 기본은 「그 스페이스를 기본으로 둔 레포 → 활성 레포」 — 둘 다 없으면 고르게 한다.
    expect(q('[data-start-repo-note]')).not.toBeNull()
    expect(el('[data-start-submit]').hasAttribute('disabled')).toBe(true)
    click('[data-start-repo-option="repo"]')
    expect(el('[data-start-submit]').hasAttribute('disabled')).toBe(false)
    setName('CORE-2 bad')
    expect(q('[data-start-name-problem]')).not.toBeNull()
    expect(el('[data-start-submit]').hasAttribute('disabled')).toBe(true)
    setName('CORE-2-card')
    click('[data-start-agent-option="shell"]')
    expect(q('[data-start-model]')).toBeNull()
    expect(q('[data-start-prompt]')).toBeNull()
    click('[data-start-agent-option="codex"]')
    expect([...el('[data-start-model]').querySelectorAll('option')].map((option) => option.value)).toEqual(['', 'gpt-6-astra'])
    click('[data-start-submit]')
    await settle()
    expect(r.starts).toHaveLength(1)
    expect(r.starts[0]).toMatchObject({ connectionId: r.connectionId, sourceId: 'mock-jira', itemId: 'm-2', itemKey: 'CORE-2', repoRoot: '/repo', name: 'CORE-2-card', agent: 'codex', model: '', effort: '', submit: false })
    expect(r.starts[0]?.prompt).toBe(prompt)
  })
})

describe('C7 연타 · 진행 중 막힘 · 다시 열어 합류', () => {
  it('진행 중 시작 10회 연타 = 요청 1 · Esc·바깥 클릭·취소로 닫히지 않음 · 끝나면 3단계 완료', async () => {
    const r = await rig()
    let finish: (value: StartWorkResult) => void = () => {}
    r.next = (input) => new Promise((resolve) => { finish = (value) => resolve({ ...value, attemptId: input.attemptId }) })
    await openCard('CORE-2')
    click('[data-issue-start="first"]')
    await settle()
    click('[data-start-repo-option="repo"]')
    for (let index = 0; index < 10; index += 1) click('[data-start-submit]')
    await settle()
    expect(r.starts).toHaveLength(1)
    expect(el('[data-start-progress]').querySelector('[data-start-step="worktree"]')?.getAttribute('data-step-status')).toBe('running')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    click('[data-modal-scrim]')
    click('[data-start-cancel]')
    expect(q('[data-start-work]')).not.toBeNull()
    expect(q('[data-issue-detail="CORE-2"]')).not.toBeNull()
    await act(async () => { finish(result({ attemptId: 'x' })) })
    await settle()
    expect([...document.querySelectorAll('[data-start-step]')].map((step) => step.getAttribute('data-step-status'))).toEqual(['completed', 'completed', 'completed'])
    click('[data-start-open]')
    expect(r.opened).toEqual([{ repoRoot: '/repo', path: '/repo/.claude/worktrees/CORE-2' }])
    expect(q('[data-start-work]')).toBeNull()
  })
  it('진행 중 모달을 닫았다 다시 열면 그 시도를 이어 받는다 — 시작 요청을 다시 내지 않는다', async () => {
    const r = await rig()
    await openCard('CORE-2')
    r.status = { attemptId: 'r1.0000000000001.0b8f6a4e-7a8c-4c33-9a43-5f3c3f6d2b11', name: 'CORE-2-x', repoRoot: '/repo', agent: 'claude', model: '', effort: 'high', submit: false, result: null }
    click('[data-issue-start="first"]')
    await settle()
    expect(inputOf('[data-start-name]').value).toBe('CORE-2-x')
    expect(el('[data-start-step="worktree"]').getAttribute('data-step-status')).toBe('running')
    r.status = { ...r.status, result: result({ attemptId: r.status.attemptId }) }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
    await settle()
    expect(el('[data-start-step="prompt"]').getAttribute('data-step-status')).toBe('completed')
    expect(r.starts).toHaveLength(0)
  })
})

describe('C5 상태 옮기기 — 기본 꺼짐 · 켜면 첫 진행 중 상태로 한 번', () => {
  async function startWith({ move }: { move: boolean }): Promise<Rig> {
    const r = await rig()
    await openCard('CORE-2')
    click('[data-issue-start="first"]')
    await settle()
    click('[data-start-repo-option="repo"]')
    if (move) check('[data-start-status] input')
    click('[data-start-submit]')
    await settle(12)
    return r
  }
  it('꺼진 채 시작 → 출처 상태 쓰기 0', async () => {
    const r = await startWith({ move: false })
    expect(r.starts).toHaveLength(1)
    expect(writes(r.calls)).toEqual([])
    expect(r.state.items.find((item) => item.id === 'm-2')?.statusKey).toBe('core-todo')
  })
  it('켜고 시작 → 허용 전이 안의 첫 진행 중 상태로 changeStatus 1회, 모달에 남김', async () => {
    const r = await startWith({ move: true })
    expect(writes(r.calls)).toMatchObject([{ op: 'changeStatus', itemId: 'm-2', statusKey: 'core-doing' }])
    expect(r.state.items.find((item) => item.id === 'm-2')?.statusKey).toBe('core-doing')
    expect(q('[data-start-status-done]')).not.toBeNull()
  })
  it('상태 쓰기가 실패하면 모달에 남기고 worktree·에이전트 단계는 그대로', async () => {
    const r = await rig()
    const original = window.corral.workRequest
    window.corral.workRequest = async (request: WorkRequest) => (request.call.op === 'changeStatus'
      ? { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'rejected', message: '전이 거절(시험)', status: null } }
      : original(request))
    await openCard('CORE-2')
    click('[data-issue-start="first"]')
    await settle()
    click('[data-start-repo-option="repo"]')
    check('[data-start-status] input')
    click('[data-start-submit]')
    await settle(12)
    expect(el('[data-start-status-failed]').textContent).toContain('전이 거절(시험)')
    expect([...document.querySelectorAll('[data-start-step]')].map((step) => step.getAttribute('data-step-status'))).toEqual(['completed', 'completed', 'completed'])
    expect(r.state.items.find((item) => item.id === 'm-2')?.statusKey).toBe('core-todo')
  })
  it('이미 진행 중인 작업이면 체크 흐림 + 이유', async () => {
    await rig()
    await openCard('CORE-4')
    click('[data-issue-start="first"]')
    await settle()
    expect(inputOf('[data-start-status] input').disabled).toBe(true)
    expect(el('[data-start-status]').textContent).toContain('이미 진행 중인 작업입니다.')
  })
})

describe('C6 실패 단계에서 멈추고 다음 행동', () => {
  async function failWith(stages: StartWorkResult['stages'], worktreePath: string | null): Promise<Rig> {
    const r = await rig()
    r.next = async (input) => result({ attemptId: input.attemptId, stages, worktreePath })
    await openCard('CORE-2')
    click('[data-issue-start="first"]')
    await settle()
    click('[data-start-repo-option="repo"]')
    click('[data-start-submit]')
    await settle()
    return r
  }
  it('worktree 실패(already_exists) → 이름 바꾸기, 바꾸면 새 시도 id', async () => {
    const r = await failWith({ worktree: stage('failed', 'already_exists', 'worktree already exists'), agent: stage('skipped'), prompt: stage('skipped') }, null)
    expect(el('[data-start-step="worktree"]').getAttribute('data-step-status')).toBe('failed')
    expect(q('[data-start-action="rename"]')).not.toBeNull()
    expect(q('[data-start-action="relaunch"]')).toBeNull()
    setName('CORE-2-second')
    click('[data-start-submit]')
    await settle()
    expect(r.starts).toHaveLength(2)
    expect(r.starts[1]?.attemptId).not.toBe(r.starts[0]?.attemptId)
  })
  it('에이전트 실패 → 에이전트 다시 띄우기 · worktree 열기', async () => {
    const r = await failWith({ worktree: stage('completed'), agent: stage('failed', 'agent_exited', '에이전트가 끝났습니다'), prompt: stage('skipped') }, '/repo/wt/x')
    click('[data-start-action="relaunch"]')
    await settle()
    expect(r.relaunches).toMatchObject([{ path: '/repo/wt/x', agent: 'claude', itemId: 'm-2' }])
    expect(el('[data-start-step="agent"]').getAttribute('data-step-status')).toBe('completed')
  })
  it('프롬프트 실패(차단) → worktree 열기만', async () => {
    const r = await failWith({ worktree: stage('completed'), agent: stage('completed'), prompt: stage('failed', 'agent_blocked', '에이전트가 막는 화면') }, '/repo/wt/y')
    expect(q('[data-start-action="relaunch"]')).toBeNull()
    click('[data-start-action="open"]')
    expect(r.opened).toEqual([{ repoRoot: '/repo', path: '/repo/wt/y' }])
  })
  it('양성 대조 — 모두 완료면 실패 행동이 없다', async () => {
    await failWith({ worktree: stage('completed'), agent: stage('completed'), prompt: stage('completed') }, '/repo/wt/z')
    expect(q('[data-start-failure]')).toBeNull()
    expect(q('[data-start-open]')).not.toBeNull()
  })
})

describe('C10 칩 · 실행 영역 질문 본문', () => {
  it('worktree 둘 → 급한 순(질문 대기) 칩 + 「+1」, 실행 영역의 질문 본문 · 「터미널에서 답하기」 = 그 pane', async () => {
    const r = await rig()
    const asking = testPane({ paneId: 'p-ask', status: 'blocked', reason: 'question', digest: testDigest({ questions: [{ question: '마이그레이션을 지울까요?', header: null, options: [], multiSelect: false }] }) })
    await r.render([testRepo({ root: '/repo', worktrees: [
      linked({ path: '/repo/wt/idle', branch: 'CORE-2-idle', panes: [testPane({ paneId: 'p-idle', status: 'idle' })] }, r.connectionId),
      linked({ path: '/repo/wt/ask', branch: 'CORE-2-ask', panes: [asking] }, r.connectionId),
    ] })])
    const chip = el('[data-tasks-board] [data-issue-card="CORE-2"] [data-issue-worktree]')
    expect(chip.getAttribute('data-issue-worktree')).toBe('CORE-2-ask')
    expect(chip.textContent).toContain('질문 대기')
    expect(chip.querySelector('[data-chip-more]')?.textContent).toBe('+1')
    expect(q('[data-tasks-board] [data-issue-card="CORE-4"] [data-issue-worktree]')).toBeNull()
    await openCard('CORE-2')
    expect([...document.querySelectorAll('[data-issue-work] [data-work-tree]')].map((box) => box.getAttribute('data-work-tree'))).toEqual(['CORE-2-ask', 'CORE-2-idle'])
    expect(el('[data-work-question="text"]').textContent).toContain('마이그레이션을 지울까요?')
    click('[data-work-answer="p-ask"]')
    expect(r.revealed).toEqual(['p-ask'])
    expect(q('[data-issue-work]')?.textContent).not.toContain('PR')
  })
})

describe('C11 사이드바 작업 줄 → 작업 페이지의 그 작업 상세', () => {
  it('작업 id 를 모르면(자동 링크) 키로 한 번 찾아 연다 · 아는 경우는 바로', async () => {
    const r = await rig()
    r.focus = { seq: 1, connectionId: r.connectionId, itemId: null, key: 'CORE-4' }
    await r.render([testRepo({ root: '/repo', worktrees: [] })])
    expect(q('[data-issue-detail="CORE-4"]')).not.toBeNull()
    r.focus = { seq: 2, connectionId: r.connectionId, itemId: 'm-2', key: 'CORE-2' }
    await r.render([testRepo({ root: '/repo', worktrees: [] })])
    expect(q('[data-issue-detail="CORE-2"]')).not.toBeNull()
  })
})

describe('fix1 R1-A·D — 합류 표시 · 복구 행동 유지 · 이름 겹침 · 상태 옮기기 유실 표시', () => {
  const joinedStages = (): StartWorkResult['stages'] => ({
    worktree: stage('skipped', 'already_linked', '이 작업에 이미 만든 worktree 입니다 — 새로 만들지 않았습니다.'), agent: stage('skipped', 'already_linked'), prompt: stage('skipped', 'already_linked'),
  })
  async function startOnce(): Promise<void> {
    await openCard('CORE-2')
    click('[data-issue-start="first"]')
    await settle()
    click('[data-start-repo-option="repo"]')
  }
  it('이미 있음(합류)은 성공으로 그리지 않는다 — 「이미 있음」 · 단계 skipped · 열기와 다시 띄우기', async () => {
    const r = await rig()
    r.next = async (input) => result({ attemptId: input.attemptId, stages: joinedStages(), worktreePath: '/repo/wt/old' })
    await startOnce()
    click('[data-start-submit]')
    await settle()
    expect([...document.querySelectorAll('[data-start-step]')].map((step) => step.getAttribute('data-step-status'))).toEqual(['skipped', 'skipped', 'skipped'])
    expect(el('[data-start-step="worktree"]').textContent).toContain('이미 있음')
    expect(el('[data-start-step="agent"]').textContent).toContain('하지 않았습니다')
    expect(el('[data-start-failure]').getAttribute('data-start-failure')).toBe('already-linked')
    expect(q('[data-start-action="open"]')).not.toBeNull()
    expect(q('[data-start-action="relaunch"]')).not.toBeNull()
    // 양성 대조 — 처음 만든 결과는 「worktree 만들기」 로 그리고 복구 행동이 없다.
    r.next = async (input) => result({ attemptId: input.attemptId })
    setName('CORE-2-new')
    click('[data-start-submit]')
    await settle()
    expect(el('[data-start-step="worktree"]').textContent).toContain('worktree 만들기')
    expect(q('[data-start-failure]')).toBeNull()
  })
  it('에이전트 실패 화면에서 「▶ 시작」 을 다시 눌러도 다시 띄우기 · 열기가 남는다', async () => {
    const r = await rig()
    r.next = async (input) => result({ attemptId: input.attemptId, stages: { worktree: stage('completed'), agent: stage('failed', 'agent_exited', '끝남'), prompt: stage('skipped') }, worktreePath: '/repo/wt/x' })
    await startOnce()
    click('[data-start-submit]')
    await settle()
    expect(q('[data-start-action="relaunch"]')).not.toBeNull()
    r.next = async (input) => result({ attemptId: input.attemptId, stages: joinedStages(), worktreePath: '/repo/wt/x' })
    click('[data-start-submit]')
    await settle()
    expect(r.starts).toHaveLength(2)
    expect(q('[data-start-action="relaunch"]')).not.toBeNull()
    expect(q('[data-start-action="open"]')).not.toBeNull()
  })
  it('빈 터미널 실패도 「터미널 다시 열기」 로 복구한다', async () => {
    const r = await rig()
    r.next = async (input) => result({ attemptId: input.attemptId, stages: { worktree: stage('completed'), agent: stage('failed', 'terminal_failed', '열지 못함'), prompt: stage('skipped') }, worktreePath: '/repo/wt/s' })
    await startOnce()
    click('[data-start-agent-option="shell"]')
    click('[data-start-submit]')
    await settle()
    expect(el('[data-start-action="relaunch"]').textContent).toBe('터미널 다시 열기')
    click('[data-start-action="relaunch"]')
    await settle()
    expect(r.relaunches).toMatchObject([{ path: '/repo/wt/s', agent: 'shell' }])
  })
  it('「하나 더 시작」 의 기본 이름은 있는 worktree 와 겹치지 않는다(접미 -2)', async () => {
    const r = await rig()
    await r.render([testRepo({ root: '/repo', worktrees: [linked({ path: '/repo/.claude/worktrees/CORE-2', branch: 'CORE-2', itemId: 'm-2' }, r.connectionId)] })])
    await openCard('CORE-2')
    click('[data-issue-start="another"]')
    await settle()
    click('[data-start-another]')
    expect(inputOf('[data-start-name]').value).toBe('CORE-2-2')
  })
  it('상태 옮기기를 켠 채 시작 중 다른 작업을 열면 — 쓰지 않고 그 사실을 알림으로 남긴다', async () => {
    const r = await rig()
    let finish: () => void = () => {}
    r.next = (input) => new Promise((resolve) => { finish = () => resolve(result({ attemptId: input.attemptId })) })
    await startOnce()
    check('[data-start-status] input')
    click('[data-start-submit]')
    await settle()
    await openCard('CORE-4')
    expect(q('[data-start-work]')).toBeNull()
    await act(async () => { finish() })
    await settle()
    expect(writes(r.calls)).toEqual([])
    expect(el('[data-toast="failed"]').textContent).toContain('CORE-2 — 시작하는 동안 다른 작업을 열어 상태를')
  })
})

describe('fix2 R2-B·H·I — 링크 저장 실패 · 끝난 비성공 이어받기 · 프롬프트 복사', () => {
  async function openModal(): Promise<void> {
    await openCard('CORE-2')
    click('[data-issue-start="first"]')
    await settle()
  }
  it('R2-H 끝난 비성공 시도를 이어받아도 이름은 덮지 않는다 — 결과 안내만, 진행 중일 때만 그 이름으로 합류', async () => {
    const r = await rig()
    r.status = { attemptId: 'r1.0000000000001.0b8f6a4e-7a8c-4c33-9a43-5f3c3f6d2b11', name: 'CORE-2-old', repoRoot: '/repo', agent: 'codex', model: '', effort: '', submit: false,
      result: result({ attemptId: 'r1.0000000000001.0b8f6a4e-7a8c-4c33-9a43-5f3c3f6d2b11', stages: { worktree: stage('completed'), agent: stage('failed', 'agent_exited', '끝남'), prompt: stage('skipped') }, worktreePath: '/repo/wt/old' }) }
    await openModal()
    expect(inputOf('[data-start-name]').value).toBe('CORE-2')
    expect(q('[data-start-action="relaunch"]')).not.toBeNull()
    click('[data-start-action="relaunch"]')
    await settle()
    expect(r.relaunches).toMatchObject([{ path: '/repo/wt/old', agent: 'codex' }])
  })
  it('R2-I 초안이 들어가지 못하면 「프롬프트 복사」 — 미리보기 그 글을 복사, 초안이 들어갔으면 없음(양성 대조)', async () => {
    const r = await rig()
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
    r.next = async (input) => result({ attemptId: input.attemptId, stages: { worktree: stage('completed'), agent: stage('completed'), prompt: stage('failed', 'agent_blocked', '막는 화면') }, worktreePath: '/repo/wt/b' })
    await openModal()
    click('[data-start-repo-option="repo"]')
    click('[data-start-submit]')
    await settle()
    const preview = el('[data-start-prompt]').textContent ?? ''
    click('[data-start-action="copy-prompt"]')
    await settle()
    expect(copied).toEqual([preview])
    expect(q('[data-start-copy-state="done"]')).not.toBeNull()
    r.next = async (input) => result({ attemptId: input.attemptId })
    setName('CORE-2-ok')
    click('[data-start-submit]')
    await settle()
    expect(q('[data-start-action="copy-prompt"]')).toBeNull()
  })
  it('R2-B 링크 저장 실패는 성공으로 그리지 않는다 — 단계 문구 · 열기만', async () => {
    const r = await rig()
    r.next = async (input) => result({ attemptId: input.attemptId, linkSaved: false, stages: { worktree: stage('completed', 'link_failed', '이 작업에 링크를 저장하지 못했습니다 — 다음 상태 갱신 때 다시 붙입니다.'), agent: stage('completed'), prompt: stage('completed') }, worktreePath: '/repo/wt/l' })
    await openModal()
    click('[data-start-repo-option="repo"]')
    click('[data-start-submit]')
    await settle()
    expect(el('[data-start-step="worktree"]').textContent).toContain('링크를 저장하지 못했습니다')
    expect(q('[data-start-action="open"]')).not.toBeNull()
    expect(q('[data-start-open]')).toBeNull()
  })
})
