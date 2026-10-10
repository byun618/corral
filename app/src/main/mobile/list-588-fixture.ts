// 하위 워크트리 묶음 고정 상태 (LIFE-588 W1) — 기준선 스크립트·시험이 같이 쓴다. 경로·이름은 가짜다.
//
// 담은 종류: 루트 작업 + 하위 2(브랜치) + 손자 1 + detached 하위 1 + 열린 세션 없는 하위 1(셸 + 보존 행) · 루트가 detached 인 작업 1 ·
// HEAD 없는 작업 1 · 보존 행(루트·하위) · 워커 계보(같은 워크트리 · 다른 하위 묶음 · 루트 → 하위 · 부모 모름) · 기다림(질문·권한).
import { emptyAgentState } from '../../shared/agent-state.js'
import type { OrchestrationLineage, PaneRow, RepoRow, RetainedAgentRow, WorktreeRow } from '../../shared/types.js'
import { FIXTURE_NOW, fixturePane, fixtureWorktree, liveLink } from './list-fixture.js'
import type { ListState } from './list.js'

const at = (secondsAgo: number): number => FIXTURE_NOW - secondsAgo * 1000

const ROOT = '/fx588/corral'
const FEAT = '/fx588/wt/feat'

function detached(input: { path: string; head: string | null; parentPath?: string | null; panes: PaneRow[] | null }): WorktreeRow {
  const row = fixtureWorktree({ path: input.path, branch: `det-${input.path}`, repoName: 'corral', parentPath: input.parentPath ?? null, panes: input.panes })
  return { ...row, branch: null, head: input.head, gitStatus: { ...row.gitStatus, branch: null } }
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

export const DETACHED_SUB_HEAD = 'deadbeefcafe0000'
export const DETACHED_ROOT_HEAD = '7cb34f3aa11bb22'

export function worktreeFixture(): ListState {
  const p = fixturePane
  const corral: RepoRow = {
    root: ROOT,
    name: 'corral',
    error: null,
    worktrees: [
      // 셸만 있는 기본 작업 — 숨김(M3-b).
      fixtureWorktree({ path: ROOT, branch: 'main', repoName: 'corral', isLinked: false, panes: [p('s0', null, { title: 'zsh', agentStatus: 'unknown' })] }),
      fixtureWorktree({
        path: FEAT,
        branch: 'feature/LIFE-564-mobile',
        repoName: 'corral',
        panes: [
          p('f1', 'claude', {
            agentStatus: 'blocked',
            agentState: { blockedReason: 'question', observedAt: at(30) },
            digest: { providerTitle: '묶음 코디', pendingQuestions: [{ question: '다음 일감?', header: '순서', options: [], multiSelect: false }] },
          }),
          p('f2', 'codex', { agentStatus: 'working', agentState: { observedAt: at(5) }, digest: { firstPrompt: '루트 워커', lastPrompt: '루트 워커' } }),
        ],
      }),
      fixtureWorktree({
        path: '/fx588/wt/a',
        branch: 'LIFE-581-mobile-chat',
        repoName: 'corral',
        parentPath: FEAT,
        panes: [
          p('a1', 'claude', { agentStatus: 'working', agentState: { observedAt: at(8) }, digest: { providerTitle: '581 코디' } }),
          p('a2', 'claude', { agentStatus: 'idle', digest: { providerTitle: '581 워커' } }),
          p('a3', 'claude', { agentStatus: 'idle', digest: { providerTitle: '581 계보 없는 세션' } }),
        ],
      }),
      fixtureWorktree({
        path: '/fx588/wt/a-claude',
        branch: 'LIFE-581-mobile-chat-claude',
        repoName: 'corral',
        parentPath: '/fx588/wt/a',
        panes: [
          p('g1', 'claude', { agentStatus: 'working', agentState: { observedAt: at(12) }, digest: { providerTitle: '581 구현 워커' } }),
          p('g2', 'codex', {
            agentStatus: 'blocked',
            agentState: { blockedReason: 'permission', observedAt: at(40) },
            digest: { firstPrompt: '581 리뷰어', lastActivityAt: at(40) },
          }),
        ],
      }),
      fixtureWorktree({
        path: '/fx588/wt/b',
        branch: 'LIFE-588-worktree-label',
        repoName: 'corral',
        parentPath: FEAT,
        panes: [p('b1', 'grok', { agentStatus: 'idle', digest: { firstPrompt: '588 서치', lastPrompt: '588 서치' } })],
      }),
      detached({
        path: '/fx588/wt/det',
        head: DETACHED_SUB_HEAD,
        parentPath: FEAT,
        panes: [p('d1', 'claude', { agentStatus: 'working', agentState: { observedAt: at(3) }, digest: { providerTitle: '검증 세션' } })],
      }),
      // 열린 AI 세션 없는 하위 — 셸 + 보존 행만. 하위 머리가 나오지 않는다(D2).
      fixtureWorktree({
        path: '/fx588/wt/none',
        branch: 'no-live-child',
        repoName: 'corral',
        parentPath: FEAT,
        panes: [p('s9', null, { title: 'zsh', agentStatus: 'unknown' })],
      }),
      // 루트가 detached 인 작업.
      detached({ path: '/fx588/wt/det-root', head: DETACHED_ROOT_HEAD, panes: [p('r1', 'claude', { agentStatus: 'idle', digest: { providerTitle: 'detached 루트 세션' } })] }),
      // HEAD 도 브랜치도 없는 작업 — detached 가 아니다(제목 폴백 그대로).
      detached({ path: '/fx588/wt/bare', head: null, panes: [p('h1', 'claude', { agentStatus: 'idle', digest: { providerTitle: 'HEAD 없는 세션' } })] }),
    ],
  }
  const lineage: OrchestrationLineage = {
    state: 'ready',
    entries: [
      // 같은 워크트리 워커 — 들여쓰기(└).
      { paneId: 'f2', parentPaneId: 'f1', runId: 'r', taskId: 't', dispatchId: 'df2', dispatchStatus: 'dispatched' },
      // 루트 → 하위 묶음 — 다른 묶음이라 셋째 줄 「띄운 세션」.
      { paneId: 'a1', parentPaneId: 'f1', runId: 'r', taskId: 't', dispatchId: 'da1', dispatchStatus: 'dispatched' },
      { paneId: 'a2', parentPaneId: 'a1', runId: 'r', taskId: 't', dispatchId: 'da2', dispatchStatus: 'dispatched' },
      // 하위 → 손자 묶음.
      { paneId: 'g1', parentPaneId: 'a1', runId: 'r', taskId: 't', dispatchId: 'dg1', dispatchStatus: 'dispatched' },
      // 부모 모름.
      { paneId: 'd1', parentPaneId: null, runId: 'r', taskId: 't', dispatchId: 'dd1', dispatchStatus: 'dispatched' },
    ],
  }
  return {
    repos: [corral],
    retainedAgents: [
      retained('rf', { title: '닫은 루트 세션', cwd: FEAT, at: at(1200) }),
      retained('ra', { title: '닫은 581 세션', cwd: '/fx588/wt/a', at: at(1250) }),
      retained('rn', { title: '닫은 열린 것 없는 하위 세션', cwd: '/fx588/wt/none', at: at(1300) }),
    ],
    orchestrationLineage: lineage,
    integrations: [],
    home: '/fx/home',
    link: liveLink(),
  }
}
