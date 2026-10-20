// 시험 전용 행 고정값 (LIFE-603) — main · 렌더러 시험이 같은 모양의 worktree · pane 을 만든다. 제품 코드는 이 파일을 import 하지 않는다.
import type { AgentStatus, BlockedReason, GitStatusSummary, PaneRow, RepoRow, SessionDigest, SessionQuestion, TurnOutcome, WorktreeRow } from './types.js'
import type { WorktreeWorkLink } from './work-link.js'

export const TEST_GIT: GitStatusSummary = { branch: 'x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }

export function testDigest(input: { questions?: SessionQuestion[] | null; outcome?: TurnOutcome | null; outcomeAt?: number | null; lastActivityAt?: number | null } = {}): SessionDigest {
  return {
    activity: { state: 'none' }, providerTitle: null, firstPrompt: null, tool: null, lastActivityAt: input.lastActivityAt ?? 1_000,
    turnOutcome: input.outcome ?? null, turnOutcomeAt: input.outcomeAt ?? null, model: null, lastPrompt: null,
    pendingQuestions: input.questions ?? null, lifecycle: { state: 'unknown', reason: 'no-source' },
  }
}

export function testPane(input: { paneId?: string; agent?: string | null; status?: AgentStatus; reason?: BlockedReason | null; digest?: SessionDigest; session?: string | null; focused?: boolean } = {}): PaneRow {
  const paneId = input.paneId ?? 'p1'
  return {
    paneId, tabId: `t-${paneId}`, workspaceId: 'w1', title: 'pane', agent: input.agent === undefined ? 'claude' : input.agent, agentStatus: input.status ?? 'idle',
    agentState: { blockedReason: input.reason ?? null, observedAt: 1, observedVia: 'event', enteredDoneAt: null, history: [] },
    cwd: null, focused: input.focused ?? false,
    agentSession: input.session === null ? null : { kind: 'id', agent: 'claude', source: 'test', id: input.session ?? `s-${paneId}` },
    digest: input.digest ?? testDigest(),
  }
}

export function testWorktree(input: { path: string; branch: string | null; panes?: PaneRow[]; workLink?: WorktreeWorkLink | null; open?: boolean; git?: Partial<GitStatusSummary> }): WorktreeRow {
  const open = input.open ?? (input.panes !== undefined)
  return {
    path: input.path, branch: input.branch, head: null, repoName: 'repo', isLinked: true,
    openWorkspaceId: open ? 'w1' : null,
    workspace: open ? { workspaceId: 'w1', label: 'repo', number: 1, agentStatus: 'idle', focused: false, tabs: [{ tabId: 't1', workspaceId: 'w1', label: 'tab', number: 1, order: 0, agentStatus: 'idle', focused: false, panes: input.panes ?? [], digest: testDigest() }] } : null,
    gitStatus: { ...TEST_GIT, ...input.git }, displayName: null, comment: null, parentPath: null,
    ...(input.workLink === undefined ? {} : { workLink: input.workLink }),
  }
}

export function testRepo(input: { root: string; worktrees: WorktreeRow[] }): RepoRow {
  return { root: input.root, name: 'repo', error: null, worktrees: input.worktrees }
}
