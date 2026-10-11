// 목록 고정 상태 묶음 (LIFE-580 L2ⓐ) — 동등 시험·repro·측정 스크립트가 같이 쓴다. 경로·이름은 가짜다.
//
// 담은 종류: 상태 5값(working·idle·done·blocked·unknown) × blockedReason(question·permission·login) · 대기 질문 · turnOutcome(failed·interrupted) ·
// monitoring · 하위 워크트리(parentPath) · 고아 하위 워크트리 · 워커 계보(같은 워크트리·다른 작업·부모 모름) · 보존 행 · 셸 pane · 셸만 있는 작업 ·
// 닫힌 세션만 남은 작업 · provider 세션 참조.
import { emptyAgentState } from '../../shared/agent-state.js'
import {
  EMPTY_SESSION_DIGEST,
  type AgentState,
  type LinkState,
  type OrchestrationLineage,
  type PaneRow,
  type RepoRow,
  type RetainedAgentRow,
  type SessionDigest,
  type WorktreeRow,
} from '../../shared/types.js'
import type { ListState } from './list.js'

export const FIXTURE_NOW = 1_800_000_000_000

export function liveLink(): LinkState {
  return {
    phase: 'live',
    sessionName: 'default',
    attempt: 0,
    nextRetryInMs: null,
    lastError: null,
    lastPushAt: null,
    bufferedAtSnapshot: null,
    lastResyncAt: null,
    lastResyncNote: null,
    resyncCount: 0,
    droppingPush: false,
  }
}

type PaneSpec = Partial<Omit<PaneRow, 'digest' | 'agentState'>> & { digest?: Partial<SessionDigest>; agentState?: Partial<AgentState> }

export function fixturePane(id: string, agent: string | null, spec: PaneSpec = {}): PaneRow {
  const { digest, agentState, ...rest } = spec
  return {
    paneId: id,
    tabId: `t-${id}`,
    workspaceId: 'w',
    title: '',
    agent,
    agentStatus: 'idle',
    cwd: null,
    focused: false,
    agentSession: null,
    ...rest,
    agentState: { ...emptyAgentState(FIXTURE_NOW - 60_000), ...agentState },
    digest: { ...EMPTY_SESSION_DIGEST, ...digest },
  }
}

export function fixtureWorktree(input: { path: string; branch: string; repoName: string; isLinked?: boolean; parentPath?: string | null; panes: PaneRow[] | null }): WorktreeRow {
  const workspaceId = `ws-${input.branch}`
  const panes = input.panes
  return {
    path: input.path,
    branch: input.branch,
    head: 'abc1234',
    repoName: input.repoName,
    isLinked: input.isLinked ?? true,
    openWorkspaceId: panes === null ? null : workspaceId,
    workspace:
      panes === null
        ? null
        : {
            workspaceId,
            label: input.branch,
            number: 1,
            agentStatus: 'idle',
            focused: false,
            tabs: panes.map((pane, index) => ({
              tabId: pane.tabId,
              workspaceId,
              label: '',
              number: index + 1,
              order: index,
              agentStatus: pane.agentStatus,
              focused: false,
              panes: [{ ...pane, workspaceId }],
              digest: EMPTY_SESSION_DIGEST,
            })),
          },
    gitStatus: { branch: input.branch, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
    displayName: null,
    comment: null,
    parentPath: input.parentPath ?? null,
  }
}

function retained(paneId: string, input: { title: string; cwd: string; at: number }): RetainedAgentRow {
  return {
    paneId,
    tabId: `t-${paneId}`,
    workspaceId: 'ws-gone',
    title: input.title,
    agent: 'claude',
    agentStatus: 'done',
    agentState: { ...emptyAgentState(input.at), enteredDoneAt: input.at },
    cwd: input.cwd,
    retainedAt: input.at,
  }
}

const at = (secondsAgo: number): number => FIXTURE_NOW - secondsAgo * 1000

/** 고정 상태 — `overrides` 로 pane 하나의 상태만 바꿔 전이를 흉내 낸다(측정 스크립트). */
export function listFixture(overrides: Record<string, PaneSpec> = {}): ListState {
  const p = (id: string, agent: string | null, spec: PaneSpec): PaneRow => fixturePane(id, agent, { ...spec, ...overrides[id] })
  const corral: RepoRow = {
    root: '/fx/corral',
    name: 'corral',
    error: null,
    worktrees: [
      // 셸만 있는 기본 작업 — 숨김(M3-b).
      fixtureWorktree({ path: '/fx/corral', branch: 'main', repoName: 'corral', isLinked: false, panes: [p('s0', null, { title: 'zsh', agentStatus: 'unknown' })] }),
      fixtureWorktree({
        path: '/fx/corral/.wt/life-579',
        branch: 'LIFE-579-mobile-design',
        repoName: 'corral',
        panes: [
          p('p1', 'claude', {
            agentStatus: 'blocked',
            agentState: { blockedReason: 'question', observedAt: at(30) },
            digest: { providerTitle: '모바일 디자인 브리프 정리', pendingQuestions: [{ question: '목록 상단 구조를 어느 안으로 갈까요?', header: '구조', options: [], multiSelect: false }] },
          }),
          p('p2', 'codex', { agentStatus: 'working', agentState: { observedAt: at(5) }, digest: { firstPrompt: '목록 화면 구현', lastPrompt: '목록 화면 구현해 줘' } }),
          p('p3', 'claude', { agentStatus: 'done', agentState: { enteredDoneAt: at(600), observedAt: at(600) }, digest: { providerTitle: '구현 리뷰 1차', lastActivityAt: at(600), turnOutcome: { outcome: 'completed' } } }),
          // 셸 pane — 목록에 오지 않는다(L1ⓑ 양성 대조: 같은 워크트리에 에이전트와 섞여 있다).
          p('s1', null, { title: 'byun@mac:~/repos/corral', agentStatus: 'unknown' }),
        ],
      }),
      // 하위 워크트리 — 부모 작업에 합쳐진다(`↳ life-579-impl`).
      fixtureWorktree({
        path: '/fx/corral/.wt/life-579-impl',
        branch: 'life-579-impl',
        repoName: 'corral',
        parentPath: '/fx/corral/.wt/life-579',
        panes: [p('p5', 'claude', { agentStatus: 'working', agentState: { observedAt: at(8) }, digest: { providerTitle: '목록 행 구현', tool: { name: 'Edit', input: 'mobile/app/home.tsx' } } })],
      }),
      fixtureWorktree({
        path: '/fx/corral/.wt/life-564',
        branch: 'LIFE-564-mobile',
        repoName: 'corral',
        panes: [
          p('p6', 'grok', { agentStatus: 'idle', digest: { firstPrompt: '재연결 정책 조사', lastPrompt: '웹소켓 재연결 백오프 정리해 줘', lastActivityAt: at(3000) } }),
          p('p7', 'claude', { agentStatus: 'unknown', digest: { providerTitle: '상태 모르는 세션' } }),
          p('p8', 'claude', { agentStatus: 'idle', digest: { providerTitle: '빌드 고치기', turnOutcome: { outcome: 'failed', error: 'API Error: 529 overloaded' }, turnOutcomeAt: at(100) } }),
          p('p9', 'claude', { agentStatus: 'idle', digest: { providerTitle: '중단한 작업', turnOutcome: { outcome: 'interrupted', reason: null }, turnOutcomeAt: at(200) } }),
          p('p10', 'claude', { agentStatus: 'working', agentState: { observedAt: at(20) }, digest: { providerTitle: '다른 레포에서 띄운 워커' } }),
        ],
      }),
      // 고아 하위 워크트리 — 부모 경로가 목록에 없다 → 독립 그룹.
      fixtureWorktree({
        path: '/fx/corral/.wt/orphan',
        branch: 'orphan-child',
        repoName: 'corral',
        parentPath: '/fx/corral/.wt/deleted',
        panes: [
          p('p11', 'claude', {
            agentStatus: 'idle',
            digest: { providerTitle: '백그라운드 감시', lifecycle: { state: 'known', tasks: [{ id: 'b1', kind: 'shell', label: 'npm test', startedAt: at(50) }], taskOverflow: 0, subagents: [], subagentOverflow: 0 } },
          }),
        ],
      }),
      // 닫힌 세션만 남은 작업 — 숨김(J2·M3-b).
      fixtureWorktree({ path: '/fx/corral/.wt/closed', branch: 'closed-only', repoName: 'corral', panes: null }),
    ],
  }
  const la: RepoRow = {
    root: '/fx/la',
    name: 'life-assistant',
    error: null,
    worktrees: [
      fixtureWorktree({
        path: '/fx/la/.wt/notify',
        branch: 'notify-refactor',
        repoName: 'life-assistant',
        panes: [
          p('p20', 'claude', {
            agentStatus: 'blocked',
            agentState: { blockedReason: 'permission', observedAt: at(40) },
            digest: { providerTitle: '알림 모듈 리팩터', tool: { name: 'Bash', input: 'rm -rf .expo/cache' } },
          }),
          p('p21', 'codex', {
            agentStatus: 'done',
            agentState: { enteredDoneAt: at(900), observedAt: at(900) },
            agentSession: { kind: 'id', agent: 'codex', source: 'herdr', id: 'sess-codex-21' },
            digest: { firstPrompt: '푸시 제거 테스트', lastActivityAt: at(900), turnOutcome: { outcome: 'completed' } },
          }),
          p('p22', 'claude', { agentStatus: 'blocked', agentState: { blockedReason: 'login', observedAt: at(10) }, digest: { providerTitle: '로그인 필요한 세션' } }),
          p('p23', 'claude', { agentStatus: 'working', agentState: { observedAt: at(15) }, digest: { providerTitle: '부모 모르는 워커' } }),
        ],
      }),
    ],
  }
  const lineage: OrchestrationLineage = {
    state: 'ready',
    entries: [
      { paneId: 'p2', parentPaneId: 'p1', runId: 'r', taskId: 't', dispatchId: 'd2', dispatchStatus: 'dispatched' },
      { paneId: 'p5', parentPaneId: 'p1', runId: 'r', taskId: 't', dispatchId: 'd5', dispatchStatus: 'dispatched' },
      { paneId: 'p10', parentPaneId: 'p20', runId: 'r', taskId: 't', dispatchId: 'd10', dispatchStatus: 'dispatched' },
      { paneId: 'p23', parentPaneId: null, runId: 'r', taskId: 't', dispatchId: 'd23', dispatchStatus: 'dispatched' },
    ],
  }
  return {
    repos: [corral, la],
    retainedAgents: [
      retained('r1', { title: '닫은 리뷰 세션', cwd: '/fx/corral/.wt/life-579', at: at(1200) }),
      retained('r2', { title: '닫은 것만 남은 작업', cwd: '/fx/corral/.wt/closed', at: at(1300) }),
    ],
    orchestrationLineage: lineage,
    integrations: [],
    home: '/fx/home',
    link: liveLink(),
  }
}
