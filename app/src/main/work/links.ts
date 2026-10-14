// 작업 링크 (LIFE-603 · 묶음 K11·K8) — main 쪽 한 곳.
//
// 1. **해석해서 싣기**(`annotate`): 트리를 내보낼 때마다 `repos.json` 메타(명시 링크 · 예외)와 연결의 키 모양으로 worktree 마다 링크를 정해
//    `WorktreeRow.workLink` 에 싣는다. 판정은 `shared/work-link.ts` 의 `resolveWorkLink` 하나 — 사이드바 · 작업 중 · 칩 · 상세가 같은 값을 본다.
// 2. **쓰기**(`saveExplicit`·`detach`): `RepoRegistry.change()` 잠금을 지난다(CLI `worktree set` 과 같은 잠금). 런타임 workspace 줄은 타지 않는다 —
//    시작이 그 줄을 잡고 에이전트 ready 를 기다리는 동안에도 링크 저장·떼기가 줄 서지 않는다(F3).
// 3. **사건 기록**(`observe`): 링크된 worktree 의 실행(자동 연결)·에이전트(질문 · 턴 결과) 사건을 활동에 남긴다. 작업 페이지가 닫혀 있어도 main 이 남긴다.
//    같은 사건은 `eventKey` 로 한 번만(재시작 · 상태 재방송 · 같은 질문 재관측). 열쇠는 설계 메모 §4.

import { createHash } from 'node:crypto'
import type { DetachWorkLinkResult, RepoRow, WorktreeRow, PaneRow } from '../../shared/types.js'
import type { WorkActivityChange, WorkLink } from '../../shared/work.js'
import { resolveWorkLink, type LinkConnection, type StoredWorkLink, type WorktreeWorkLink } from '../../shared/work-link.js'
import type { StartSourceLink } from '../../shared/work-start.js'
import type { DroppedLink, WorktreeMetadataRecord } from '../registry.js'

export type LinkRegistryPort = {
  metadata(): Record<string, WorktreeMetadataRecord>
  droppedLinks(): DroppedLink[]
  change<T>(mutate: (data: { worktrees: Record<string, WorktreeMetadataRecord> }) => T): T
}

export type LinkWorkPort = {
  linkConnections(): LinkConnection[]
  repoDefaultConnection(repoRoot: string): string | null
  recordEvent(input: { connectionId: string; itemId: string | null; itemKey: string; eventKey: string; change: WorkActivityChange }): boolean
  storeLink(input: { connectionId: string; itemId: string; link: WorkLink; action: 'save' | 'remove' }): Promise<StartSourceLink>
}

export type LinkDeps = {
  registry: () => LinkRegistryPort | null
  work: () => LinkWorkPort | null
  log: (event: string, data: Record<string, unknown>) => void
}


const sha8 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

function branchName(branch: string | null): string | null {
  return branch === null ? null : branch.replace(/^refs\/heads\//, '')
}

function sessionOf(pane: PaneRow): string {
  const ref = pane.agentSession
  return ref === null ? `pane:${pane.paneId}` : ref.kind === 'id' ? ref.id : ref.path
}

function filesChanged(worktree: WorktreeRow): number | null {
  const git = worktree.gitStatus
  if (git.error !== null) return null
  return git.staged + git.unstaged + git.untracked + git.conflicted
}

export class WorkLinks {
  private readonly deps: LinkDeps
  private droppedSeen = ''

  constructor(deps: LinkDeps) {
    this.deps = deps
  }

  /** 레지스트리를 못 읽으면 빈 메타 — 링크 없이 그린다(앱은 산다). */
  private metadata(): Record<string, WorktreeMetadataRecord> {
    const registry = this.deps.registry()
    if (registry === null) return {}
    try {
      const metadata = registry.metadata()
      const dropped = registry.droppedLinks()
      const signature = JSON.stringify(dropped)
      if (dropped.length > 0 && signature !== this.droppedSeen) this.deps.log('work.link_dropped', { dropped })
      this.droppedSeen = signature
      return metadata
    } catch {
      return {}
    }
  }

  /** 트리에 링크를 싣는다 — 연결이 없으면(작업 서비스 전) 명시 링크만, `connected: false`. */
  annotate(repos: RepoRow[]): RepoRow[] {
    const metadata = this.metadata()
    const work = this.deps.work()
    const connections = work?.linkConnections() ?? []
    return repos.map((repo) => {
      const defaultConnectionId = work?.repoDefaultConnection(repo.root) ?? null
      return {
        ...repo,
        worktrees: repo.worktrees.map((worktree) => {
          const meta = metadata[worktree.path]
          const workLink = resolveWorkLink({
            branch: branchName(worktree.branch),
            explicit: meta?.workLink ?? null,
            suppressed: meta?.workLinkSuppressed === true,
            defaultConnectionId,
            connections,
          })
          return { ...worktree, workLink }
        }),
      }
    })
  }

  /** 시작으로 만든 worktree 에 명시 링크(예외는 푼다 — 그 worktree 는 이 작업을 하려고 만든 것이다). */
  saveExplicit({ path, link }: { path: string; link: StoredWorkLink }): boolean {
    const registry = this.deps.registry()
    if (registry === null) return false
    try {
      registry.change((data) => {
        const current = data.worktrees[path] ?? {}
        data.worktrees[path] = { ...current, workLink: link, workLinkSuppressed: false }
      })
      return true
    } catch (error) {
      this.deps.log('work.link_save_failed', { path, error: String(error) })
      return false
    }
  }

  /**
   * 사이드바 「작업 떼기」 — 명시 링크면 지우고, 어느 쪽이든 그 worktree 를 자동 연결 예외로 둔다(명시 링크를 지운 뒤 브랜치 키로 다시 붙지 않게).
   * 실행 갈래에 「떼기」 를 남기고, 출처가 링크를 저장하는 능력이 있으면 출처의 링크도 지운다(실패해도 로컬 떼기는 그대로).
   */
  async detach({ worktree, repoRoot }: { worktree: WorktreeRow; repoRoot: string }): Promise<DetachWorkLinkResult> {
    const registry = this.deps.registry()
    const link = this.annotate([{ root: repoRoot, name: '', error: null, worktrees: [worktree] }])[0]?.worktrees[0]?.workLink ?? null
    if (registry === null) return { ok: false, error: '레지스트리를 읽지 못했습니다.' }
    if (link === null) return { ok: false, error: '이 worktree 에는 작업 링크가 없습니다.' }
    try {
      registry.change((data) => {
        const current = data.worktrees[worktree.path] ?? {}
        const { workLink: _removed, ...rest } = current
        void _removed
        data.worktrees[worktree.path] = { ...rest, workLinkSuppressed: true }
      })
    } catch (error) {
      return { ok: false, error: `링크를 떼지 못했습니다: ${String(error)}` }
    }
    const work = this.deps.work()
    work?.recordEvent({
      connectionId: link.connectionId,
      itemId: link.itemId,
      itemKey: link.key,
      eventKey: `run:detach:${link.connectionId}:${link.key}:${worktree.path}:${Date.now()}`,
      change: { field: 'run', event: 'detach', worktree: worktree.path, branch: branchName(worktree.branch) },
    })
    const sourceLink = link.itemId === null || work === null ? null
      : await work.storeLink({ connectionId: link.connectionId, itemId: link.itemId, link: { kind: 'worktree', path: worktree.path, repoRoot }, action: 'remove' })
    return { ok: true, mode: link.mode, sourceLink }
  }

  /**
   * 링크된 worktree 의 사건을 남긴다 — 상태를 내보낼 때마다 부른다. 같은 사건은 열쇠로 걸러져 한 번만 남는다.
   * 자동 연결 · 질문(본문 — 못 읽는 에이전트는 이유) · 턴 결과(완료 · 중단 · 실패 + 바뀐 파일 수).
   */
  observe(repos: RepoRow[]): void {
    const work = this.deps.work()
    if (work === null) return
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        const link = worktree.workLink ?? null
        if (link === null || !link.connected) continue
        const scope = `${link.connectionId}:${link.key}`
        const record = (eventKey: string, change: WorkActivityChange) => work.recordEvent({ connectionId: link.connectionId, itemId: link.itemId, itemKey: link.key, eventKey, change })
        if (link.mode === 'auto') record(`run:auto:${scope}:${worktree.path}`, { field: 'run', event: 'auto_link', worktree: worktree.path, branch: branchName(worktree.branch) })
        for (const pane of (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes)) this.observePane({ pane, worktree, scope, record })
      }
    }
  }

  private observePane({ pane, worktree, scope, record }: { pane: PaneRow; worktree: WorktreeRow; scope: string; record: (eventKey: string, change: WorkActivityChange) => boolean }): void {
    if (pane.agent === null) return
    const digest = pane.digest
    const session = sessionOf(pane)
    const questions = digest.pendingQuestions
    const asking = questions !== null || (pane.agentStatus === 'blocked' && pane.agentState.blockedReason === 'question')
    if (asking) {
      const text = questions === null ? null : questions.map((entry) => entry.question).join('\n')
      // 열쇠: 세션 + 기록의 마지막 활동 시각 + 본문 — 기다리는 동안 기록이 자라지 않으므로 재시작·재관측에도 같다.
      record(`agent:q:${scope}:${session}:${digest.lastActivityAt ?? 'na'}:${sha8(text ?? '')}`, {
        field: 'agent', event: 'question', agent: pane.agent, worktree: worktree.path, question: text,
        noBody: text === null ? '이 에이전트의 질문 본문은 읽지 못합니다.' : null,
      })
    }
    const outcome = digest.turnOutcome
    // 결과 시각이 없으면 같은 결과를 다시 알아볼 열쇠가 없다 — 남기지 않는다(중복보다 빠짐이 낫다).
    if (outcome !== null && digest.turnOutcomeAt !== null && pane.agentStatus !== 'working') {
      record(`agent:t:${scope}:${session}:${digest.turnOutcomeAt}:${outcome.outcome}`, {
        field: 'agent', event: 'result', agent: pane.agent, worktree: worktree.path, outcome: outcome.outcome,
        detail: outcome.outcome === 'interrupted' ? outcome.reason : outcome.outcome === 'failed' ? outcome.error : null,
        filesChanged: filesChanged(worktree),
      })
    }
  }
}

/** 렌더러 경로 검사 뒤의 링크 — 트리에 있는 worktree 의 해석 결과(없으면 null). */
export function linkOf({ repos, path }: { repos: RepoRow[]; path: string }): { repoRoot: string; worktree: WorktreeRow; link: WorktreeWorkLink | null } | null {
  for (const repo of repos) {
    const worktree = repo.worktrees.find((row) => row.path === path)
    if (worktree !== undefined) return { repoRoot: repo.root, worktree, link: worktree.workLink ?? null }
  }
  return null
}
